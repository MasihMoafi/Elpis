'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { AppServer } = require('../editors/vscode/src/rpc');
const binary = process.env.ELPIS_EDITOR_TEST_RUNTIME || (process.argv[2] && path.resolve(process.argv[2])) || path.resolve(__dirname, '../codex-rs/target/local-release/codex-app-server');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-memory-repeat-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'project');
const workspace = path.join(home, 'context/workspaces', 'project-'+crypto.createHash('sha256').update(cwd).digest('hex').slice(0,12));
for(const dir of [cwd,workspace]) fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(workspace,'memory-autosave.json'),'{"enabled":true}');
fs.writeFileSync(path.join(workspace,'admission.toml'),'memory=true\ncheckpoint=true\n');
const requests=[], saves=[], events=[], checks=[];
let rpc, malformed=false, providerError, deadline;
const check=(name,passed,actual)=>checks.push({name,passed:!!passed,actual});
const server=http.createServer(async(req,res)=>{
  try {
    if(!req.url.includes('/responses')) throw Error('Unexpected endpoint '+req.url);
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>3000000)throw Error('Request cap exceeded');}
    const body=JSON.parse(raw);requests.push({path:req.url,body});
    if(requests.length>25)throw Error('Provider request cap exceeded');
    let text='Acknowledged.';
    if(body.model==='gpt-5.6-luna') {
      const evidence=body.input.flatMap(i=>i.content||[]).filter(i=>i.text?.startsWith('{')).map(i=>JSON.parse(i.text)).find(i=>Array.isArray(i.evidence));
      if(!evidence)throw Error('Missing saver evidence');
      saves.push({evidence,malformed});
      const source=evidence.evidence[0].id;
      text=malformed?'INVALID JSON':JSON.stringify({checkpoint:`- Keep the preference [${source}].`,memory:`- Use Celsius [${source}].`});
    }
    const id='r'+requests.length,item={type:'message',id:'m'+requests.length,role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [
      {type:'response.created',response:{id,status:'in_progress'}},
      {type:'response.output_item.added',output_index:0,item:{...item,content:[]}},
      {type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:text},
      {type:'response.output_item.done',output_index:0,item},
      {type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:100,output_tokens:30,total_tokens:130}}},
    ])res.write('data: '+JSON.stringify(event)+'\n\n');
    res.end();
  }catch(e){providerError=e;res.writeHead(500);res.end(e.message);}
});
async function complete(threadId,method,params) {
  const start=events.length;
  await rpc.request(method,params,20000);
  const end=Date.now()+20000;
  while(!events.slice(start).some(e=>e.method==='turn/completed'&&e.params.threadId===threadId)) {
    if(Date.now()>end)throw Error('Turn deadline exceeded');
    await new Promise(r=>setTimeout(r,20));
  }
}
const turn=(id,text)=>complete(id,'turn/start',{threadId:id,input:[{type:'text',text}]});
const compact=id=>complete(id,'thread/compact/start',{threadId:id});
function semantic(save) { return JSON.stringify(save.evidence.evidence.map(row=>row.item)); }
async function run() {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  fs.writeFileSync(path.join(home,'config.toml'),`model="gpt-5.6-terra"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local saver check"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  fs.writeFileSync(path.join(home,'hooks.json'),'{}');
  rpc=new AppServer(binary,cwd,{env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,CODEX_AUTH_HOME:home,ELPIS_HOME:home}});
  rpc.on('disconnect',()=>{});rpc.on('notification',e=>events.push(e));
  rpc.child.stderr.on('data',data=>fs.appendFileSync(path.join(root,'runtime.log'),data));
  rpc.on('request',e=>{providerError=Error('Unexpected server request '+e.method);rpc.respond(e.id,{decision:'decline'});});
  await rpc.request('initialize',{clientInfo:{name:'memory_repeat_eval',version:'1'},capabilities:{experimentalApi:true}});
  rpc.send({method:'initialized'});
  const id=(await rpc.request('thread/start',{model:'gpt-5.6-terra',cwd,approvalPolicy:'never',sandbox:'read-only'})).thread.id;
  await turn(id,'Remember: I prefer Celsius.');
  check('successful end-turn save',saves.length===1,saves.length);
  await compact(id);
  check('immediate compaction skips unchanged saved evidence',saves.length===1,{saverRequests:saves.length,duplicateSemanticItems:saves.length>1&&semantic(saves[0])===semantic(saves[1]),firstEvidence:saves[0]?.evidence.evidence,secondEvidence:saves[1]?.evidence.evidence});
  let before=saves.length;
  await turn(id,'A new user turn: keep Celsius for all weather reports.');
  check('new user evidence still saves',saves.length===before+1,saves.length-before);
  before=saves.length;malformed=true;
  await turn(id,'Another user correction: Celsius is also preferred in research reports.');
  check('failure control attempted saving',saves.length>before,saves.length-before);
  const failed=saves.at(-1);malformed=false;before=saves.length;
  await compact(id);
  check('failed save retried at compaction',saves.length===before+1,saves.length-before);
  check('retry uses unchanged failed evidence',semantic(failed)===semantic(saves.at(-1)));
  const receipts=fs.readdirSync(path.join(workspace,'memory-saves')).map(f=>JSON.parse(fs.readFileSync(path.join(workspace,'memory-saves',f),'utf8')));
  check('retry commits successfully',receipts.some(r=>r.status==='committed'&&r.evidence.includes('research reports')));
  for (const [name, file] of [
    ['MEMORY', path.join(home, 'memories/MEMORY.md')],
    ['ES', path.join(workspace, 'ES.md')],
    ['GOAL', path.join(workspace, 'GOAL.md')],
  ]) {
    await turn(id, 'Prepare the unchanged conversation for the '+name+' edit control.');
    const savedEvidence=semantic(saves.at(-1));
    before=saves.length;
    fs.appendFileSync(file, '\nManual '+name+' correction.\n');
    await compact(id);
    check('manual '+name+' edit invalidates successful-save cache',
      saves.length===before+1&&semantic(saves.at(-1))===savedEvidence,
      {requests:saves.length-before,sameEvidence:semantic(saves.at(-1))===savedEvidence});
  }
  if(providerError)throw providerError;
}
(async()=>{
  let error;
  try{await Promise.race([run(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Overall 90s deadline exceeded')),90000);})]);}catch(e){error=e.stack;}
  finally{
    clearTimeout(deadline);rpc?.dispose();server.closeAllConnections();server.close();
    const result={passed:!error&&checks.length===10&&checks.every(c=>c.passed),binary,root,checks,error,providerError:providerError?.stack};
    for(const [name,value] of Object.entries({requests,saves,events,result}))fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(value,null,2));
    console.log(JSON.stringify(result,null,2));process.exitCode=result.passed?0:1;
  }
})();
