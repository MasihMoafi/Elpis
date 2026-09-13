const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {AppServer} = require('../editors/vscode/src/rpc');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-pressure-runtime-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'project');
fs.mkdirSync(home); fs.mkdirSync(cwd);
const requests = [];
let mode = 'unset', mainCalls = 0, rpc;
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (!req.url.includes('/responses')) {res.writeHead(404); res.end(); return;}
  const body = JSON.parse(raw); requests.push(body);
  const optimizer = req.url.endsWith('/compact') || body.input?.some(item=>item.type==='compaction_trigger');
  body.fixture_is_compact = optimizer;
  let item;
  if (optimizer) {
    item = {type:'compaction',id:'fixture_compact',encrypted_content:
      mode==='ineffective' ? 'a'.repeat(384000) : 'fixture-pressure-state'};
  } else if (mainCalls++ < (mode==='ineffective'?2:1)) {
    item = {type:'function_call', id:'fc_fixture_'+mainCalls, call_id:'pressure-fixture-'+mainCalls, name:'shell_command',
      arguments:JSON.stringify({command:'printf tool-completed', timeout_ms:2000, login:false})};
  } else {
    const text = 'Finished.';
    item = {type:'message', id:'msg_'+requests.length, role:'assistant', status:'completed',
      content:[{type:'output_text', text, annotations:[]}]};
  }
  res.writeHead(200, {'content-type':'text/event-stream'});
  for (const event of [
    {type:'response.created',response:{id:'resp_'+requests.length,status:'in_progress',output:[]}},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:{id:'resp_'+requests.length,status:'completed',output:[item],
      usage:{input_tokens:!optimizer && mainCalls<=(mode==='ineffective'?2:1) ? 72000 : 500,output_tokens:20,total_tokens:!optimizer && mainCalls<=(mode==='ineffective'?2:1) ? 72020 : 520}}},
  ]) res.write('data: '+JSON.stringify(event)+'\n\n');
  res.end();
});

async function runCase(nextMode) {
  mode = nextMode; mainCalls = 0;
  const settings = path.join(home,'compaction.json');
  if(mode==='unset') fs.rmSync(settings,{force:true});
  else fs.writeFileSync(settings,JSON.stringify({remaining_percent:mode==='off'?null:30}));
  const start = requests.length;
  const {thread} = await rpc.request('thread/start', {model:'gpt-5.6-terra',cwd,approvalPolicy:'never',sandbox:'danger-full-access'});
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
  const sequence = calls.map(call=>call.fixture_is_compact?'compact':'sample');
  const expected = mode==='ineffective' ? ['sample','compact','sample','sample']
    : mode==='pressure' ? ['sample','compact','sample'] : ['sample','sample'];
  assert.deepEqual(sequence,expected, 'pressure boundary failed: '+mode);
  return {mode,sequence,reportedInputTokens:72000,configuredWindow:100000,nativeThreshold:90000};
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  fs.writeFileSync(path.join(home,'config.toml'),[
    'model="gpt-5.6-terra"','model_provider="fixture"','model_context_window=100000',
    'model_auto_compact_token_limit=90000',
    '[model_providers.fixture]','name="OpenAI"',
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
  for(const selected of ['unset','off','pressure','ineffective']) {
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
