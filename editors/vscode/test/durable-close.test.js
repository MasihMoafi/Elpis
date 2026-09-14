'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { AppServer } = require('../src/rpc');
const test = require('node:test');
const assert = require('node:assert/strict');

test('failed durable child close reports failure and preserves the child until retry', {timeout:80000}, t => durableLifecycle(t, 'close'));
test('failed durable child resume reports failure and rolls back loading until retry', {timeout:80000}, t => durableLifecycle(t, 'resume'));
test('failed durable child spawn reports failure without starting an untracked child', {timeout:80000}, t => durableLifecycle(t, 'spawn'));

async function durableLifecycle(t, operation) {
  const binary = process.env.ELPIS_EDITOR_TEST_RUNTIME || path.join(__dirname, '../bin/elpis-app-server');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `elpis-durable-${operation}-`));
  const home = path.join(root, 'home'), cwd = path.join(root, 'project');
  for (const dir of [home, cwd]) fs.mkdirSync(dir);
  const notifications = [], requests = [], checks = [];
  let rpc, server, phase = 'spawn', childId, providerError, deadline;
  const childMarker = 'DURABLE_CLOSE_CHILD_734129';
  const model = 'gpt-5.2';
  const db = path.join(home, 'state_5.sqlite');
  function sql(statement) {
    return JSON.parse(execFileSync('python3', ['-c', 'import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1],timeout=5)\nr=c.execute(sys.argv[2]).fetchall()\nc.commit()\nprint(json.dumps(r))', db, statement], {encoding:'utf8', timeout:7000}));
  }
  function check(name, passed, actual) { checks.push({name, passed:!!passed, actual}); }
  function reply(res, item) {
    res.writeHead(200, {'content-type':'text/event-stream'});
    const emit = value => res.write('data: '+JSON.stringify(value)+'\n\n');
    const id = 'r'+requests.length;
    emit({type:'response.created',response:{id,status:'in_progress'}});
    emit({type:'response.output_item.done',output_index:0,item});
    emit({type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:100,output_tokens:20,total_tokens:120}}});
    res.end();
  }
  const message = text => ({type:'message',id:'msg'+requests.length,role:'assistant',status:'completed',content:[{type:'output_text',text}]});
  const call = (name,args,id) => ({type:'function_call',id:'fc_'+id,call_id:id,namespace:'multi_agent_v1',name,arguments:JSON.stringify(args)});
  async function until(predicate, label) {
    const end = Date.now()+15000;
    while (!predicate()) { if (Date.now()>end) throw Error('Timeout: '+label); await new Promise(r=>setTimeout(r,30)); }
  }
  async function turn(threadId, text) {
    const start = notifications.length;
    await rpc.request('turn/start',{threadId,input:[{type:'text',text}],model},20000);
    await until(()=>notifications.slice(start).some(n=>n.method==='turn/completed'&&n.params?.threadId===threadId),phase+' turn completion');
  }
  function toolEvent(id) {
    return notifications.find(n=>n.method==='item/completed'&&n.params?.item?.id===id)?.params.item;
  }
  async function loaded() { return (await rpc.request('thread/loaded/list',{})).data; }
  function edge() { return sql("SELECT status FROM thread_spawn_edges WHERE child_thread_id='"+childId+"'"); }
  async function main() {
    server = http.createServer(async (req,res)=>{
      try {
        if (!req.url.includes('/responses')) throw Error('Unexpected endpoint '+req.url);
        let raw=''; for await(const part of req) { raw+=part; if(raw.length>3000000) throw Error('Request size exceeded'); }
        const body=JSON.parse(raw); requests.push({phase,path:req.url,body});
        if(requests.length>14) throw Error('Provider request cap exceeded');
        const input=body.input||[];
        const isChild=input.some(i=>i.role==='user'&&Array.isArray(i.content)&&i.content.some(p=>p.text?.startsWith(childMarker)));
        if(isChild) return reply(res,message('child done'));
        const id=phase==='spawn'?'spawn_control':phase==='setup'?'close_setup':`${operation}_${phase}`;
        if(input.some(i=>i.type==='function_call_output'&&i.call_id===id)) return reply(res,message(phase+' done'));
        if(phase==='spawn'||operation==='spawn') return reply(res,call('spawn_agent',{message:childMarker+(operation==='spawn'?'_'+phase:''),fork_context:false},id));
        if(phase==='setup'||operation==='close') return reply(res,call('close_agent',{target:childId},id));
        return reply(res,call('resume_agent',{id:childId},id));
      } catch(error) { providerError=error; res.writeHead(500);res.end(error.message); }
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    fs.writeFileSync(path.join(home,'config.toml'),`model = "${model}"\nmodel_provider = "fixture"\nmodel_context_window = 128000\nweb_search = "disabled"\ncheck_for_update_on_startup = false\n[agents]\nmax_threads = 1\n[features]\nmulti_agent = true\nmulti_agent_v2 = false\n[model_providers.fixture]\nname = "Offline close regression"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
    fs.writeFileSync(path.join(home,'hooks.json'),'{}');
    const env={PATH:process.env.PATH,HOME:root,CODEX_HOME:home,ELPIS_HOME:home,NO_PROXY:'127.0.0.1,localhost'};
    rpc=new AppServer(path.resolve(binary),cwd,{env});
    rpc.child.stderr.on('data',data=>fs.appendFileSync(path.join(root,'runtime.log'),data));
    rpc.on('disconnect',()=>{});
    rpc.on('notification',n=>notifications.push(n));
    rpc.on('request',n=>{ providerError=Error('Unexpected server request '+n.method);rpc.respond(n.id,{decision:'decline'}); });
    await rpc.request('initialize',{clientInfo:{name:'durable_close_eval',version:'1'},capabilities:{experimentalApi:true}});
    rpc.send({method:'initialized'});
    const threadId=(await rpc.request('thread/start',{cwd,model,approvalPolicy:'never',sandbox:'read-only',config:{'features.shell_tool':false}})).thread.id;
    if(operation==='spawn') {
      const childRequests=attempt=>requests.filter(r=>r.body.input?.some(i=>i.role==='user'&&i.content?.some?.(p=>p.text===childMarker+'_'+attempt)));
      sql("CREATE TRIGGER reject_test_spawn BEFORE INSERT ON thread_spawn_edges WHEN NEW.status='open' BEGIN SELECT RAISE(ABORT,'injected open spawn write failure'); END");
      phase='fail'; await turn(threadId,'Spawn the fixture child and report the result.');
      check('failed spawn event reports failed',toolEvent('spawn_fail')?.status==='failed',toolEvent('spawn_fail'));
      const output=requests.flatMap(r=>r.body.input||[]).find(i=>i.type==='function_call_output'&&i.call_id==='spawn_fail');
      check('model receives spawn persistence error',String(JSON.stringify(output)).includes('injected open spawn write failure'),output);
      check('failed spawn leaves only parent loaded',JSON.stringify((await loaded()).sort())===JSON.stringify([threadId]),await loaded());
      check('failed spawn creates no edge',sql('SELECT child_thread_id FROM thread_spawn_edges').length===0);
      sql('DROP TRIGGER reject_test_spawn');
      phase='retry'; await turn(threadId,'Retry spawning the fixture child.');
      const retried=toolEvent('spawn_retry');
      childId=retried?.receiverThreadIds?.[0];
      if(!childId||!/^[0-9a-f-]{36}$/.test(childId)) throw Error('Retry spawn failed: '+JSON.stringify(retried));
      check('retry spawn completed',retried.status==='completed',retried);
      check('retry leaves only parent and new child loaded',JSON.stringify((await loaded()).sort())===JSON.stringify([threadId,childId].sort()),await loaded());
      check('retry spawn persists open edge',edge()[0]?.[0]==='open',edge());
      await until(()=>childRequests('retry').length>0,'retry child inference');
      check('retry starts child inference',childRequests('retry').length>0);
      check('failed spawn starts no child inference',childRequests('fail').length===0,childRequests('fail').length);
      if(providerError) throw providerError;
      return;
    }
    await turn(threadId,'Spawn the fixture child.');
    const spawn=toolEvent('spawn_control');
    childId=spawn?.receiverThreadIds?.[0];
    if(!childId||!/^[0-9a-f-]{36}$/.test(childId)) throw Error('Spawn failed: '+JSON.stringify(spawn));
    await until(()=>notifications.some(n=>n.method==='turn/completed'&&n.params?.threadId===childId)||requests.some(r=>r.body.input?.some(i=>i.role==='user'&&i.content?.some?.(p=>p.text===childMarker))), 'child response');
    check('spawn child loaded',(await loaded()).includes(childId));
    check('spawn edge open',edge()[0]?.[0]==='open',edge());
    const resuming=operation==='resume';
    if(resuming) {
      phase='setup'; await turn(threadId,'Close the fixture child before testing resume.');
      check('setup close completed',toolEvent('close_setup')?.status==='completed',toolEvent('close_setup'));
      check('setup child unloaded',!(await loaded()).includes(childId));
      check('setup edge closed',edge()[0]?.[0]==='closed',edge());
    }
    const transition=resuming?'open':'closed';
    const write=resuming?'INSERT':'UPDATE OF status';
    const fault=`injected ${transition} edge write failure`;
    sql(`CREATE TRIGGER reject_test_transition BEFORE ${write} ON thread_spawn_edges WHEN NEW.status='${transition}' AND NEW.child_thread_id='${childId}' BEGIN SELECT RAISE(ABORT,'${fault}'); END`);
    phase='fail'; await turn(threadId,`${operation} the fixture child; report the result.`);
    const failedEvent=toolEvent(`${operation}_fail`);
    check(`failed ${operation} event reports failed`,failedEvent?.status==='failed',failedEvent);
    const output=requests.flatMap(r=>r.body.input||[]).find(i=>i.type==='function_call_output'&&i.call_id===`${operation}_fail`);
    check('model receives persistence error',String(JSON.stringify(output)).includes(fault),output);
    check(`failed ${operation} preserves prior child residency`,(await loaded()).includes(childId)===!resuming);
    check(`failed ${operation} preserves prior edge`,edge()[0]?.[0]===(resuming?'closed':'open'),edge());
    sql('DROP TRIGGER reject_test_transition');
    phase='retry'; await turn(threadId,`Retry ${operation} for the same fixture child.`);
    const retryEvent=toolEvent(`${operation}_retry`);
    check(`retry ${operation} event reports completed`,retryEvent?.status==='completed',retryEvent);
    check('retry changes child residency',(await loaded()).includes(childId)===resuming);
    check(`retry persists ${transition} edge`,edge()[0]?.[0]===transition,edge());
    if(providerError) throw providerError;
  }
  let error;
  try { await Promise.race([main(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Overall 70s deadline exceeded')),70000);})]); }
  catch(e) { error=e.stack; }
  finally {
    clearTimeout(deadline);rpc?.dispose();server?.closeAllConnections();server?.close();
    const result={passed:!error&&checks.length===(operation==='resume'?12:9)&&checks.every(c=>c.passed),binary:path.resolve(binary),root,checks,error,providerError:providerError?.stack};
    fs.writeFileSync(path.join(root,'requests.json'),JSON.stringify(requests,null,2));
    fs.writeFileSync(path.join(root,'notifications.json'),JSON.stringify(notifications,null,2));
    fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));
    t.diagnostic('Runtime evidence: '+root);
    assert.equal(result.passed,true,JSON.stringify(result,null,2));
  }
}
