// Prove the shipped sibling host executes JavaScript through the real runtime.
// --missing-host copies the runtime alone; the same positive assertion must fail.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-host-install-'));
const home = path.join(root, 'home'); fs.mkdirSync(home);
let binary = path.resolve(process.argv[2]);
if (process.argv[3] === '--missing-host') {
  const isolated = path.join(root, 'elpis'); fs.copyFileSync(binary, isolated); fs.chmodSync(isolated, 0o755); binary = isolated;
}
const catalog=path.join(root,'models.json');
const model=JSON.parse(fs.readFileSync(path.join(__dirname,'../codex-rs/models-manager/models.json'),'utf8')).models.find(m=>m.slug==='gpt-6-sol');
assert(model);
fs.writeFileSync(catalog,JSON.stringify({models:[{...model,prefer_websockets:false,use_responses_lite:false,supported_in_api:true}]}));
const marker = 'host-only-' + require('node:crypto').randomBytes(12).toString('hex');
let calls = 0, observed = false, fixtureFailure;
const server = http.createServer(async (req,res) => {
  try {
    let raw=''; for await(const chunk of req) raw+=chunk;
    if(!req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
    const body=JSON.parse(raw);
    const advertised=(body.tools||[]).flatMap(t=>t.type==='namespace'?(t.tools||[]):[t]);
    assert(advertised.some(t=>t.name==='exec'), 'Code Mode was not advertised');
    if(calls++>0) observed ||= body.input.some(i=>i.type==='custom_tool_call_output' && JSON.stringify(i).includes(marker));
    const item=calls===1 ? {type:'custom_tool_call',id:'host_call',call_id:'host_call',name:'exec',input:`text(${JSON.stringify(marker)})`} :
      {type:'message',id:'host_answer',role:'assistant',status:'completed',content:[{type:'output_text',text:'DONE',annotations:[]}]};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const e of [
      {type:'response.created',response:{id:'host_response_'+calls,status:'in_progress',output:[]}},
      {type:'response.output_item.done',output_index:0,item},
      {type:'response.completed',response:{id:'host_response_'+calls,status:'completed',output:[item],usage:{input_tokens:100,output_tokens:10,total_tokens:110}}}
    ]) res.write('data: '+JSON.stringify(e)+'\n\n');
    res.end();
  } catch(e) { fixtureFailure=e; res.writeHead(500); res.end(); }
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  fs.writeFileSync(path.join(home,'config.toml'),`model = "gpt-6-sol"\nmodel_provider = "fixture"\nmodel_catalog_json = ${JSON.stringify(catalog)}\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  const child=spawn(binary,['exec','--skip-git-repo-check','--dangerously-bypass-approvals-and-sandbox','-C',root,'Run the provided tool once.'],{env:{PATH:process.env.PATH,HOME:home,ELPIS_HOME:home,LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']});
  let stderr=''; child.stdout.resume(); child.stderr.on('data',d=>stderr+=d);
  const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
  const status=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});
  clearTimeout(timer);
  if(fixtureFailure) throw fixtureFailure;
  assert.equal(status,0,stderr.slice(-2000));
  assert(observed,'The Code Mode host did not produce its planted marker in the followup request');
  console.log(JSON.stringify({passed:true,calls,hostOutputReceived:observed,root}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>server.close());
