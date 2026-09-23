const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {AppServer} = require('../editors/vscode/src/rpc');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-prune-runtime-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'project');
fs.mkdirSync(home); fs.mkdirSync(cwd);
const negativeControl = process.argv[3];
assert(negativeControl === undefined || negativeControl === '--drop-prune',
  'optional third argument must be --drop-prune');
const requests = [];
const responseIds = [];
let mode = 'compact', mainCalls = 0, rpc, rejectCase, fixtureFailure;
const compact = 'The command produced 12000 copies of Z.';
const malformed = '{"items":[]} trailing data';
const command = "awk 'BEGIN { for (i=0; i<12000; i++) printf \"Z\" }'";

function filesUnder(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(file, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(file);
  }
  return files;
}

function advertisedCommand(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const advertised = tools.flatMap(tool => tool.type === 'namespace'
    ? (tool.tools || []).map(child => ({...child, namespace:tool.name})) : [tool]);
  const selected = advertised.find(tool => tool.name === 'exec_command')
    || advertised.find(tool => tool.name === 'shell_command');
  assert(selected, 'main request did not advertise exec_command or shell_command');
  const call = selected.name === 'exec_command'
    ? {name:selected.name, arguments:JSON.stringify({cmd:command, yield_time_ms:10000, login:false})}
    : {name:selected.name, arguments:JSON.stringify({command, timeout_ms:2000, login:false})};
  if(selected.namespace) call.namespace = selected.namespace;
  return call;
}

const server = http.createServer((req, res) => { void (async () => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (!req.url.includes('/responses')) {res.writeHead(404); res.end(); return;}
  const body = JSON.parse(raw);
  requests.push(body);
  const responseId = 'resp_'+requests.length;
  responseIds.push(responseId);
  const optimizer = body.input?.some(item => item.content?.some(part =>
    typeof part.text === 'string' && part.text.includes('"source_tokens_estimate"')));
  let item;
  if (!optimizer && mainCalls++ === 0) {
    const selected = advertisedCommand(body);
    item = {type:'function_call', id:'fc_fixture', call_id:'prune-fixture', ...selected};
  } else {
    const text = optimizer ? (mode === 'malformed' ? malformed : JSON.stringify({items:[{
      call_id:'prune-fixture', decision:mode, content:mode === 'compact' ? compact : null,
    }]})) : 'Finished.';
    item = {type:'message', id:'msg_'+requests.length, role:'assistant', status:'completed',
      content:[{type:'output_text', text, annotations:[]}]};
  }
  res.writeHead(200, {'content-type':'text/event-stream'});
  for (const event of [
    {type:'response.created',response:{id:responseId,status:'in_progress',output:[]}},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:{id:responseId,status:'completed',output:[item],
      usage:{input_tokens:100,output_tokens:50,total_tokens:150}}},
  ]) res.write('data: '+JSON.stringify(event)+'\n\n');
  res.end();
  })().catch(error => {
    fixtureFailure ||= error;
    if (!res.headersSent) res.writeHead(500);
    res.end();
    rejectCase?.(new Error('fixture server failed: '+fixtureFailure.message,{cause:fixtureFailure}));
  });
});

async function runCase(nextMode) {
  mode = nextMode; mainCalls = 0;
  const start = requests.length;
  const auditStarts = {
    admissions: new Set(filesUnder(path.join(home,'logs/smart-prune/admissions'), 'manifest.json')),
    attempts: new Set(filesUnder(path.join(home,'logs/smart-prune/attempts'), '.json')),
  };
  const disabled = mode === 'disabled' || (negativeControl === '--drop-prune' && mode === 'compact');
  const config = disabled ? {'features.automatic_context_pruning':false} : undefined;
  const {thread} = await rpc.request('thread/start', {model:'gpt-5.4',cwd,
    approvalPolicy:'never',sandbox:'danger-full-access',config});
  await rpc.request('thread/name/set',{threadId:thread.id,name:'Smart Prune fixture '+mode});
  let timer, listener;
  const done = new Promise((resolve,reject) => {
    listener = event => {
      if(event.method === 'turn/completed' && event.params.threadId === thread.id) resolve(event.params);
    };
    rpc.on('notification', listener);
    timer = setTimeout(()=>reject(Error('turn timed out '+mode)),20000);
  });
  const fixtureFailed = new Promise((_,reject) => {
    rejectCase = reject;
    if(fixtureFailure) reject(new Error('fixture server failed: '+fixtureFailure.message,
      {cause:fixtureFailure}));
  });
  let completed;
  try {
    await rpc.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'Generate the diagnostic output.'}]});
    completed = await Promise.race([done,fixtureFailed]);
  } finally {
    rejectCase = undefined;
    clearTimeout(timer);
    rpc.removeListener('notification',listener);
  }
  assert.equal(completed.turn.status,'completed','turn did not complete successfully: '+mode);
  assert.equal(completed.turn.error,null,'turn completed with an error: '+mode);
  const calls = requests.slice(start);
  const caseResponseIds = responseIds.slice(start);
  const expectedCalls = mode === 'disabled' ? 2 : 3;
  assert.equal(calls.length,expectedCalls,
    'unexpected main/optimizer/followup sequence for '+mode+'; models='+calls.map(x=>x.model));
  if(mode === 'disabled') {
    assert(!calls.some(call => call.input?.some(item => item.content?.some(part =>
      typeof part.text === 'string' && part.text.includes('"source_tokens_estimate"')))),
    'disabled Smart Prune made an auxiliary optimizer call');
  } else {
    const format = calls[1].text?.format;
    assert.equal(format?.type,'json_schema','optimizer omitted structured response schema');
    assert.equal(format.strict,true,'optimizer schema is not strict');
    assert.deepEqual(format.schema.required,['items']);
  }
  const followupCall = calls.at(-1);
  const followup = JSON.stringify(followupCall.input);
  if(mode === 'compact') {
    assert(followup.includes(compact));
    assert(followup.includes('[ELPIS SMART PRUNE]'));
    assert(!followup.includes('Z'.repeat(256)));
  } else if(mode !== 'disabled') {
    assert(followup.includes('Z'.repeat(256)),'original missing after '+mode);
    assert(!followup.includes('[ELPIS SMART PRUNE]'));
    const source = JSON.parse(calls[1].input[0].content[0].text).items[0].source_output;
    const admitted = followupCall.input.find(item=>item.type==='function_call_output' && item.call_id==='prune-fixture');
    assert.equal(admitted.output,source.output,'source output changed after '+mode);
  } else {
    assert(followup.includes('Z'.repeat(256)),'original missing while Smart Prune disabled');
    assert(!followup.includes('[ELPIS SMART PRUNE]'));
  }

  const admissions = filesUnder(path.join(home,'logs/smart-prune/admissions'), 'manifest.json')
    .filter(file => !auditStarts.admissions.has(file));
  const attempts = filesUnder(path.join(home,'logs/smart-prune/attempts'), '.json')
    .filter(file => !auditStarts.attempts.has(file));
  assert.equal(admissions.length, mode === 'compact' ? 1 : 0,
    'unexpected durable admission count for '+mode);
  assert.equal(attempts.length, mode === 'disabled' ? 0 : 1,
    'unexpected optimizer attempt audit count for '+mode);
  let admittedId = null;
  if(mode === 'compact') {
    const admissionDir = path.dirname(admissions.at(-1));
    assert(fs.existsSync(path.join(admissionDir,'ace.json')),'missing durable optimizer audit');
    const manifest = JSON.parse(fs.readFileSync(path.join(admissionDir,'manifest.json'),'utf8'));
    const request = JSON.parse(fs.readFileSync(path.join(admissionDir,'request.json'),'utf8'));
    const response = JSON.parse(fs.readFileSync(path.join(admissionDir,'response.json'),'utf8'));
    admittedId = manifest.admission_id;
    assert.equal(request.admission_id,manifest.admission_id,'request linkage admission mismatch');
    assert.equal(request.input_representation,'logical_response_items_before_transport');
    assert.match(request.request_input_sha256,/^[0-9a-f]{64}$/,'request linkage hash is invalid');
    assert.equal(request.request_sequence,2,'admission linked to the wrong main-model request');
    assert.equal(response.admission_id,manifest.admission_id,'response linkage admission mismatch');
    assert.equal(response.response_id,caseResponseIds.at(-1),'response linkage does not match actual response');
    assert.equal(response.usage.total_tokens,150,'response linkage usage does not match actual response');
    for(const item of manifest.items) {
      const source = JSON.parse(fs.readFileSync(path.join(admissionDir,item.source_artifact),'utf8'));
      const admitted = JSON.parse(fs.readFileSync(path.join(admissionDir,item.admitted_artifact),'utf8'));
      const offered = JSON.parse(calls[1].input[0].content[0].text).items
        .find(candidate => candidate.call_id === item.call_id).source_output;
      const observed = followupCall.input.find(candidate =>
        candidate.type === 'function_call_output' && candidate.call_id === item.call_id);
      const sourceHash = crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
      assert.equal(item.source_sha256,sourceHash,'audited source hash does not match source artifact');
      assert.deepEqual(source,offered,'audited source differs from optimizer request');
      assert(observed,'audited admission missing from actual followup');
      assert.equal(observed.call_id,admitted.call_id,'audited call ID differs from actual followup');
      assert.deepEqual(observed.output,admitted.output,'audited payload differs from actual followup');
    }
  }
  const latestAttempt = mode === 'disabled' ? null
    : JSON.parse(fs.readFileSync(attempts.at(-1),'utf8'));
  const expectedStatus = {compact:'admitted',unchanged:'unchanged',malformed:'malformed_response'}[mode];
  if(expectedStatus) assert.equal(latestAttempt.status,expectedStatus,'wrong attempt audit status: '+mode);
  if(admittedId) assert.equal(latestAttempt.admission_id,admittedId,'attempt/admission linkage mismatch');
  return {mode,requests:calls.length,optimizerCalls:mode==='disabled'?0:1,
    turnStatus:completed.turn.status,turnError:completed.turn.error,
    durableAdmission:mode==='compact',originalPreserved:mode!=='compact'};
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  fs.writeFileSync(path.join(home,'config.toml'),[
    'model="gpt-5.4"','model_provider="fixture"','model_context_window=100000',
    '[features]','automatic_context_pruning=true',
    '[model_providers.fixture]','name="Fixture"',
    `base_url="http://127.0.0.1:${server.address().port}/v1"`,'wire_api="responses"','requires_openai_auth=false',
  ].join('\n'));
  fs.writeFileSync(path.join(home,'hooks.json'),'{}');
  const binary = process.argv[2];
  rpc = new AppServer(binary,cwd,{args:path.basename(binary)==='elpis'?['app-server']:[],
    env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,ELPIS_HOME:home}});
  rpc.child.stderr.on('data', data=>fs.appendFileSync(path.join(root,'stderr.log'),data));
  rpc.on('disconnect',()=>{});
  rpc.on('request',event=>rpc.respond(event.id,{decision:'decline'}));
  await rpc.request('initialize',{clientInfo:{name:'prune_fixture',version:'1'},capabilities:{experimentalApi:true}});
  rpc.send({method:'initialized'});
  const results = [];
  for(const selected of ['compact','unchanged','malformed','disabled']) {
    const result = await runCase(selected);
    results.push(result);
    console.log(JSON.stringify(result));
  }
  console.log(JSON.stringify({passed:true,root,results}));
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(()=>{
  fs.writeFileSync(path.join(root,'requests.json'),JSON.stringify(requests,null,2));
  console.log('Evidence: '+root);
  rpc?.dispose();server.closeAllConnections();server.close();
});
