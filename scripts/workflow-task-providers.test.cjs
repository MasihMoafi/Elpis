'use strict';
// Test-owned native scheduler and local Responses endpoints. No paid provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const {spawn} = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const {Provider, message, call} = require(path.join(repo, 'scripts/lib/mock-provider.js'));
const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), 'An absolute native binary is required');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-native-task-providers-'));
const home = path.join(root, 'home');
const cwd = path.join(root, 'workspace');
fs.mkdirSync(home); fs.mkdirSync(cwd);
const providers = new Map(['root', 'provider-a', 'provider-b'].map(id => [id, new Provider()]));
const pending = new Map();
const requests = []; const notifications = []; const checks = []; const inference = []; const endpointAuth = [];
let child, sequence = 0, stderr = '', runtimeError;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
function rpc(method, params, timeout = 25000) {
  const id = ++sequence;
  requests.push({id, method, params});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {pending.delete(id);reject(new Error(`Timed out: ${method}`));}, timeout);
    pending.set(id, {resolve, reject, timer});
    child.stdin.write(`${JSON.stringify({id, method, params})}\n`);
  });
}
async function rejected(method, params) {
  try {await rpc(method, params);} catch (error) {return error;}
  assert.fail(`${method} unexpectedly accepted invalid routes`);
}
async function eventually(fn, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (runtimeError) throw runtimeError;
    for (const fixture of providers.values()) if (fixture.error) throw fixture.error;
    if (child.exitCode !== null) throw new Error(`Native exited: ${stderr}`);
    const value = await fn(); if (value) return value; await pause(50);
  }
  throw new Error(`Timed out: ${label}; evidence ${root}; ${stderr}`);
}
const task = (id, dependsOn=[], route={}) => ({id, kind:'explore', title:`Route ${id}`, instruction:'Read this task prompt and report its local fixture evidence using report_agent_work_task. Do not run commands or delegate.', dependsOn,writeScopes:[],acceptanceCriteria:['Return accepted local fixture evidence'],...route});
const list = async id => (await rpc('workGraph/list',{rootThreadId:id})).data;
async function runGraph(rootId, name, tasks) {
  const started = await rpc('workGraph/runWithProviders',{rootThreadId:rootId,name,tasks,maxConcurrency:2,maxRuntimeSeconds:30});
  const finished = await eventually(async()=>{
    const graph=(await list(rootId)).find(row=>row.id===started.graphId);
    if (graph?.status==='failed') throw new Error(`Graph failed: ${JSON.stringify(graph)}`);
    return graph?.status==='succeeded' && graph;
  },name);
  await eventually(()=>notifications.some(row=>row.method==='turn/completed' && row.params?.threadId===rootId && row.params.turn.id===started.turnId),`${name} native turn completion`);
  return finished;
}
async function startNative(executable) {
  runtimeError = undefined;
  child=spawn(executable,['app-server'],{cwd,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,CODEX_AUTH_HOME:home,ELPIS_HOME:home,LANG:'C.UTF-8',NO_PROXY:'127.0.0.1,localhost'},stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.on('error',error=>{for(const row of pending.values()){clearTimeout(row.timer);row.reject(error);}pending.clear();});
  readline.createInterface({input:child.stdout}).on('line',line=>{
    let row;try{row=JSON.parse(line);}catch{stderr+=line+'\n';return;}
    const waiting=!row.method && pending.get(row.id);
    if(waiting){clearTimeout(waiting.timer);pending.delete(row.id);if(row.error)waiting.reject(Object.assign(new Error(row.error.message),row.error));else waiting.resolve(row.result);}
    else if(row.id!==undefined && row.method){
      child.stdin.write(`${JSON.stringify({id:row.id,result:{decision:'decline'}})}\n`);
      runtimeError = new Error(`Unexpected native approval: ${row.method}`);
      for(const waiting of pending.values()){clearTimeout(waiting.timer);waiting.reject(runtimeError);}pending.clear();
    }
    else notifications.push(row);
  });
  await rpc('initialize',{clientInfo:{name:'native-task-providers',version:'1'},capabilities:{experimentalApi:true}});
}
async function stopNative() {
  const stopping = child;
  if (stopping && stopping.exitCode === null) {
    stopping.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>stopping.once('exit',resolve)),pause(3000)]);
    if (stopping.exitCode === null) {
      stopping.kill('SIGKILL');
      await Promise.race([new Promise(resolve=>stopping.once('exit',resolve)),pause(3000)]);
    }
  }
}
async function main() {
  for (const [providerId, fixture] of providers) {
    await fixture.start();
    fixture.server.on('request', req => {
      const authorizationMatches = req.headers.authorization === `Bearer synthetic-${providerId}`;
      endpointAuth.push({providerId,path:req.url,authorizationMatches});
      if (!authorizationMatches) fixture.error = new Error(`Unexpected authorization at ${providerId} endpoint`);
    });
    const action = (request, headers) => {
      const source = JSON.stringify(request.input);
      const graphId = source.match(/Graph ID: ([^\\\s"]+)/)?.[1];
      const taskId = source.match(/Task ID: ([^\\\s"]+)/)?.[1];
      assert(graphId && taskId, 'Inference must belong to an assigned graph task');
      assert.equal(headers.authorization,`Bearer synthetic-${providerId}`,`Independent auth for ${providerId}`);
      inference.push({providerId,model:request.model,effort:request.reasoning?.effort,graphId,taskId,authorizationMatches:true});
      const evidence = `NATIVE_TASK_ROUTE_EVIDENCE_${taskId}`;
      if (source.includes(evidence)) return message('Worker complete');
      return call(`report_${providerId}_${taskId}`, 'report_agent_work_task',{
        graph_id:graphId,task_id:taskId,outcome:'succeeded',summary:`Completed ${providerId} route`,changed_files:[],checks:['Checked assigned local fixture route'],evidence:[evidence],risks:[],edge_cases_considered:['Provider-specific bearer and model'],open_questions:[],what_i_did_not_check:['Paid provider inference'],
      });
    };
    for(let i=0;i<30;i++) fixture.actions.push(action);
  }
  const catalog = JSON.parse(fs.readFileSync(path.join(repo,'codex-rs/models-manager/models.json'),'utf8'));
  const model = catalog.models.find(row=>row.slug==='gpt-5.5'); assert(model);
  fs.writeFileSync(path.join(home,'models.json'),JSON.stringify({models:[model]}));
  fs.writeFileSync(path.join(home,'hooks.json'),'{}');
  fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({OPENAI_API_KEY:'synthetic-saved-openai-main'}),{mode:0o600});
  let config=`model="gpt-5.5"\nmodel_provider="root"\nmodel_catalog_json=${JSON.stringify(path.join(home,'models.json'))}\napproval_policy="never"\nsandbox_mode="danger-full-access"\n[features]\ncode_mode=false\nmulti_agent=true\nenable_fanout=true\nsqlite=true\nautomatic_context_pruning=false\n[memories]\ngenerate_memories=false\nuse_memories=false\n`;
  for(const [id,fixture] of providers) config+=`[model_providers.${JSON.stringify(id)}]\nname=${JSON.stringify(id)}\nbase_url=${JSON.stringify(fixture.url)}\nwire_api="responses"\nrequires_openai_auth=false\nexperimental_bearer_token=${JSON.stringify(`synthetic-${id}`)}\nrequest_max_retries=0\nstream_max_retries=0\n`;
  config+=`[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`;
  fs.writeFileSync(path.join(home,'config.toml'),config,{mode:0o600});
  await startNative(binary);
  const rootThread=(await rpc('thread/start',{cwd,model:'gpt-5.5',modelProvider:'root'})).thread.id;
  const probe = await rejected('workGraph/runWithProviders', {rootThreadId:rootThread,name:'',tasks:[]});
  if (process.argv.includes('--old-runtime')) {
    assert(probe.code === -32601 || /unknown variant|unknown method|method not found/i.test(probe.message), 'Old runtime must reject the routed method');
    assert.equal((await list(rootThread)).length,0);
    assert.equal(inference.length,0);
    pass('Old runtime rejects routed graphs before persistence or inference');
    fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({binary,checks,inference},null,2));
    return;
  }
  assert.match(probe.message,/work graph name/i,'Routed RPC must reach native validation');
  const invalidRoutes=[{provider:'unknown',model:'fixture/a-model'},{provider:'provider-a'},{provider:'claude',model:'fixture/a-model'},{provider:'provider-a',model:'claude/opus'},{model:'agy/model'},{provider:'provider-a',model:''}];
  for(const route of invalidRoutes){
    const before=(await list(rootThread)).length;const calls=inference.length;
    await rejected('workGraph/runWithProviders',{rootThreadId:rootThread,name:'Rejected route',tasks:[task('invalid',[],route)]});
    assert.equal((await list(rootThread)).length,before,'Invalid route must not persist');
    assert.equal(inference.length,calls,'Invalid route must not spawn workers');
  }
  pass('Unknown, incomplete and subscription task routes reject before graph persistence or inference');
  const legacy=await rejected('workGraph/run',{rootThreadId:rootThread,name:'Legacy explicit route',tasks:[task('legacy',[],{provider:'provider-a',model:'fixture/a-model'})]});
  assert.match(legacy.message,/runWithProviders/);pass('Legacy method rejects explicit task routes');
  const lacking=await rejected('workGraph/runWithProviders',{rootThreadId:rootThread,name:'Unsupported effort',tasks:[task('too-deep',[],{model:'gpt-5.5',reasoningEffort:'ultra'})]});
  assert.match(lacking.message,/ultra.*not supported.*gpt-5\.5.*low, medium, high, xhigh/s,'The refusal names the effort, the model and what it supports');
  assert.equal((await list(rootThread)).length,0,'Unsupported effort must not persist');assert.equal(inference.length,0,'Unsupported effort must not spawn workers');
  const effortOnly=await rejected('workGraph/run',{rootThreadId:rootThread,name:'Legacy effort',tasks:[task('legacy-effort',[],{reasoningEffort:'low'})]});
  assert.match(effortOnly.message,/runWithProviders/);
  pass('A task effort its model lacks, or sent on the legacy method, is refused before graph persistence or inference');
  const mixed=await runGraph(rootThread,'Independent provider tasks',[
    task('first',[],{provider:'provider-a',model:'fixture/a-model'}),
    task('second',['first'],{provider:'provider-b',model:'fixture/b-model'}),
  ]);
  for(const [id,providerId,modelId] of [['first','provider-a','fixture/a-model'],['second','provider-b','fixture/b-model']]){
    const summary=mixed.tasks.find(row=>row.id===id);assert(summary);assert.equal(summary.provider,providerId);assert.equal(summary.model,modelId);
    const seen=inference.filter(row=>row.graphId===mixed.id && row.taskId===id);assert(seen.length);assert(seen.every(row=>row.providerId===providerId && row.model===modelId));
    const thread=(await rpc('thread/read',{threadId:summary.assignedThreadId,includeTurns:false})).thread;
    assert.equal(thread.modelProvider,providerId,'Worker thread attribution');
  }
  assert.equal(providers.get('root').requests.length,0,'Explicit routes must not infer through root provider');
  pass('Two dependent tasks reach distinct endpoints with distinct bearer keys and custom models');
  pass('Graph summaries and assigned worker threads retain their effective providers/models');
  const inherited=await runGraph(rootThread,'Model-only inheritance',[task('inherit',[],{model:'fixture/root-model'})]);
  assert.equal(inherited.tasks[0].provider,'root');assert.equal(inherited.tasks[0].model,'fixture/root-model');
  const seen=inference.filter(row=>row.graphId===inherited.id);assert(seen.length);assert(seen.every(row=>row.providerId==='root' && row.model==='fixture/root-model'));
  pass('Model-only task uses the native root endpoint and its own root credential');
  const efforts=await runGraph(rootThread,'Per-task reasoning effort',[
    task('lean',[],{provider:'provider-a',model:'gpt-5.5',reasoningEffort:'low'}),
    task('deep',['lean'],{provider:'provider-b',model:'gpt-5.5',reasoningEffort:'xhigh'}),
    task('default',['deep'],{provider:'provider-a',model:'gpt-5.5'}),
  ]);
  const effortsSeen=id=>new Set(inference.filter(row=>row.graphId===efforts.id && row.taskId===id).map(row=>row.effort));
  assert.deepEqual([...effortsSeen('lean')],['low']);assert.deepEqual([...effortsSeen('deep')],['xhigh']);
  const inheritedEffort=[...effortsSeen('default')];assert.equal(inheritedEffort.length,1);assert(!['low','xhigh'].includes(inheritedEffort[0]),'A task with no effort keeps the coordinator effort');
  pass('Each task worker infers at its own reasoning effort; a task without one keeps the inherited effort');
  const again=(await list(rootThread)).find(row=>row.id===mixed.id);
  assert.deepEqual(again.tasks.map(({provider,model})=>({provider,model})),mixed.tasks.map(({provider,model})=>({provider,model})));
  pass('Persisted effective routes survive subsequent graphs and state readback');
  let rollback;
  const rollbackIndex = process.argv.indexOf('--rollback-binary');
  if (rollbackIndex !== -1) {
    const rollbackBinary = process.argv[rollbackIndex + 1];
    assert(rollbackBinary && path.isAbsolute(rollbackBinary), 'An absolute rollback binary is required');
    const inferenceBefore = inference.length;
    await stopNative();
    await startNative(rollbackBinary);
    const oldGraphs = await list(rootThread);
    const common = graph => ({id:graph.id,name:graph.name,status:graph.status,tasks:graph.tasks.map(({id,title,status,dependencies,assignedThreadId,result,evidence,failureReason})=>({id,title,status,dependencies,assignedThreadId,result,evidence,failureReason}))});
    for (const expected of [mixed,inherited]) {
      const actual = oldGraphs.find(row=>row.id===expected.id);
      assert(actual, 'Installed baseline must read each completed graph');
      assert.deepEqual(common(actual),common(expected),'Completed task records must remain readable on rollback');
    }
    await stopNative();
    await startNative(binary);
    const afterRollback = await list(rootThread);
    for (const expected of [mixed,inherited]) assert.deepEqual(afterRollback.find(row=>row.id===expected.id),expected,'Rollback must preserve all persisted task routes/results');
    assert.equal(inference.length,inferenceBefore,'Read-only rollback must not infer');
    rollback={binary:rollbackBinary,graphsRead:oldGraphs.map(row=>row.id),effectiveRoutesPreserved:true};
    pass('Installed baseline reads migrated completed tasks; restarting candidate preserves exact route/result records');
  }
  assert(endpointAuth.every(row=>row.authorizationMatches));
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({binary,checks,graphs:[mixed,inherited],inference,endpointAuth,rollback,limits:['Routes and credentials use the owning root configuration snapshot. Subscription workers remain unsupported; no paid inference checked.']},null,2));
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;}).finally(async()=>{
  fs.writeFileSync(path.join(root,'requests.json'),JSON.stringify(requests,null,2));
  fs.writeFileSync(path.join(root,'notifications.json'),JSON.stringify(notifications,null,2));
  fs.writeFileSync(path.join(root,'native.stderr.log'),stderr);
  for(const row of pending.values()){clearTimeout(row.timer);row.reject(new Error('Fixture cleanup'));}pending.clear();
  await stopNative();
  for(const fixture of providers.values())if(fixture.server)fixture.close();
  console.log(`Evidence: ${root}`);
});
