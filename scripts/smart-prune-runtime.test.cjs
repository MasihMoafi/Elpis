const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {AppServer} = require('../editors/vscode/src/rpc');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-prune-runtime-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'project');
fs.mkdirSync(home); fs.mkdirSync(cwd);
const requests = [];
let mode = 'compact', mainCalls = 0, rpc;
const compact = 'The command produced 12000 copies of Z.';
const malformed = '{"items":[]} trailing data';
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (!req.url.includes('/responses')) {res.writeHead(404); res.end(); return;}
  const body = JSON.parse(raw); requests.push(body);
  const optimizer = body.input?.some(item => item.content?.some(part =>
    typeof part.text === 'string' && part.text.includes('"source_tokens_estimate"')));
  let item;
  if (!optimizer && mainCalls++ === 0) {
    item = {type:'function_call', id:'fc_fixture', call_id:'prune-fixture', name:'shell_command',
      arguments:JSON.stringify({command:"awk 'BEGIN { for (i=0; i<12000; i++) printf \"Z\" }'", timeout_ms:2000, login:false})};
  } else {
    const text = optimizer ? (mode === 'malformed' ? malformed : JSON.stringify({items:[{
      call_id:'prune-fixture', decision:mode, content:mode === 'compact' ? compact : null,
    }]})) : 'Finished.';
    item = {type:'message', id:'msg_'+requests.length, role:'assistant', status:'completed',
      content:[{type:'output_text', text, annotations:[]}]};
  }
  res.writeHead(200, {'content-type':'text/event-stream'});
  for (const event of [
    {type:'response.created',response:{id:'resp_'+requests.length,status:'in_progress',output:[]}},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:{id:'resp_'+requests.length,status:'completed',output:[item],
      usage:{input_tokens:100,output_tokens:50,total_tokens:150}}},
  ]) res.write('data: '+JSON.stringify(event)+'\n\n');
  res.end();
});

async function runCase(nextMode) {
  mode = nextMode; mainCalls = 0;
  const start = requests.length;
  const {thread} = await rpc.request('thread/start', {model:'gpt-5.4',cwd,approvalPolicy:'never',sandbox:'danger-full-access'});
  let timer, listener;
  const done = new Promise((resolve,reject) => {
    listener = event => {
      if(event.method === 'turn/completed' && event.params.threadId === thread.id) resolve();
    };
    rpc.on('notification', listener);
    timer = setTimeout(()=>reject(Error('turn timed out '+mode)),20000);
  });
  try {
    await rpc.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'Generate the diagnostic output.'}]});
    await done;
  } finally {clearTimeout(timer);rpc.removeListener('notification',listener);}
  const calls = requests.slice(start);
  assert.equal(calls.length,3,'expected main/tool, optimizer, main/followup; models='+calls.map(x=>x.model));
  const format = calls[1].text?.format;
  assert.equal(format?.type,'json_schema','optimizer omitted structured response schema');
  assert.equal(format.strict,true,'optimizer schema is not strict');
  assert.deepEqual(format.schema.required,['items']);
  const followup = JSON.stringify(calls[2].input);
  if(mode === 'compact') {
    assert(followup.includes(compact));
    assert(followup.includes('[ELPIS SMART PRUNE]'));
    assert(!followup.includes('Z'.repeat(256)));
  } else {
    assert(followup.includes('Z'.repeat(256)),'original missing after '+mode);
    assert(!followup.includes('[ELPIS SMART PRUNE]'));
    const source = JSON.parse(calls[1].input[0].content[0].text).items[0].source_output;
    const admitted = calls[2].input.find(item=>item.type==='function_call_output' && item.call_id==='prune-fixture');
    assert.equal(admitted.output,source.output,'source output changed after '+mode);
  }
  return {mode,requests:calls.length,strictSchema:true,originalPreserved:mode!=='compact'};
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
  for(const selected of ['compact','unchanged','malformed']) results.push(await runCase(selected));
  console.log(JSON.stringify({passed:true,root,results}));
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(()=>{
  fs.writeFileSync(path.join(root,'requests.json'),JSON.stringify(requests,null,2));
  console.log('Evidence: '+root);
  rpc?.dispose();server.closeAllConnections();server.close();
});
