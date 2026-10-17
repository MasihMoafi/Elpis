'use strict';
// Real TUI through the real launcher and bridge, on a Claude model with a stand-in Anthropic usage
// endpoint: /usage must show Claude's own limits, not the GPT plan.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {Provider,message}=require('./lib/mock-provider.js');
const binary=process.argv[2];assert(binary&&path.isAbsolute(binary),'absolute Elpis binary required');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'elpis-terminal-usage-')),home=path.join(root,'home'),cwd=path.join(root,'workspace'),socket=path.join(root,'tmux.sock');fs.mkdirSync(home);fs.mkdirSync(cwd);
const provider=new Provider(),pause=ms=>new Promise(r=>setTimeout(r,ms));let server,log='';
const tm=(...args)=>execFileSync('tmux',['-S',socket,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const type=text=>tm('send-keys','-t','test','-l',text),key=name=>tm('send-keys','-t','test',name);
const capture=(ansi=false)=>tm('capture-pane','-p',...(ansi?['-e']:[]),'-t','test');
async function until(predicate,label){let text='';for(let i=0;i<150;i++){text=capture();if(predicate(text))return text;await pause(100);}fs.writeFileSync(path.join(root,label+'.txt'),text);throw Error('Timed out '+label+'; '+root);}
function shot(label){const text=capture();fs.writeFileSync(path.join(root,label+'.txt'),text);return text;}
const http=require('node:http');const repo=path.resolve(__dirname,'..');const runtime=path.join(root,'run');fs.mkdirSync(runtime,{mode:0o700});
fs.mkdirSync(path.join(home,'.claude'),{recursive:true});fs.writeFileSync(path.join(home,'.claude/.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fixture-token',subscriptionType:'max'}}));
const usage=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({five_hour:{utilization:41,resets_at:'2030-01-01T00:00:00Z'},seven_day:{utilization:86,resets_at:'2030-01-07T00:00:00Z'}}));});
(async()=>{try{
 await provider.start();await new Promise(r=>usage.listen(0,'127.0.0.1',r));const catalog=require('../codex-rs/models-manager/models.json');const elpisHome=path.join(home,'.elpis-next');fs.mkdirSync(elpisHome);fs.writeFileSync(path.join(elpisHome,'models.json'),JSON.stringify({models:catalog.models.filter(m=>m.slug==='gpt-5.5')}));
 fs.writeFileSync(path.join(elpisHome,'config.toml'),`model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(elpisHome,'models.json'))}\napproval_policy="on-request"\nsandbox_mode="workspace-write"\n[features]\ncode_mode=false\n[model_providers.fixture]\nname="Usage fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[tui]\nanimations=false\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
 const env={HOME:home,CODEX_HOME:elpisHome,CODEX_AUTH_HOME:elpisHome,ELPIS_HOME:elpisHome,XDG_RUNTIME_DIR:runtime,TERM:'xterm-256color',ELPIS_ENGINE_BIN:binary,ELPIS_NO_AGY:'1',PERMISSION_FIXTURE_ADAPTER:'1',ACP_ADAPTER:path.join(repo,'scripts/permissions-bridge.test.cjs'),ELPIS_CLAUDE_USAGE_URL:`http://127.0.0.1:${usage.address().port}/usage`,NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'};
 const control=path.join(root,'control.json');fs.writeFileSync(path.join(root,'release'),'');fs.writeFileSync(control,JSON.stringify({ready:path.join(root,'ready'),release:path.join(root,'release'),marker:path.join(root,'marker')}));env.PERMISSION_FIXTURE_CONTROL=control;
 const launcher=process.argv[3]??path.join(repo,'tools/elpis-claude/elpis-claude');
 tm('new-session','-d','-s','test','-x','110','-y','45','bash --noprofile --norc');
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";const cmd=['env','-u','NO_COLOR',...Object.entries(env).map(([k,v])=>k+'='+v),launcher,'--no-alt-screen','-C',cwd,'--model','claude/haiku'].map(quote).join(' ');await pause(200);type(cmd);key('Enter');
 await until(s=>{if(s.includes('Hooks need review'))key('Escape');return /Claude subscription/.test(s);},'startup');
 type('/usage');await pause(300);key('Enter');await pause(4000);const card=shot('usage');
 const session=card.match(/Session:\s+([0-9a-f-]{36})/)?.[1];assert(session,'session id on the usage card');key('Escape');await pause(300);
 type('Say hello.');await pause(200);key('Enter');await until(s=>/Fixture write/.test(s),'approval');key('Enter');await until(()=>fs.existsSync(path.join(root,'marker')),'allowed');await until(s=>!/esc to interrupt/.test(s),'turn');await pause(2000);
 key('C-c');await pause(400);key('C-c');await until(s=>/\$ $/m.test(s.trimEnd()+' ')||/resume/.test(s),'exit');await pause(500);tm('send-keys','-t','test','clear','Enter');await pause(300);
 const resumeCmd=['env','-u','NO_COLOR',...Object.entries(env).map(([k,v])=>k+'='+v),launcher,'--no-alt-screen','-C',cwd,'resume',session].map(quote).join(' ');type(resumeCmd);key('Enter');
 await until(s=>{if(s.includes('Hooks need review')){key('Escape');return false;}return /Say hello/.test(s);},'resumed');await pause(1500);const resumedFooter=shot('resumed');
 type('/usage');await pause(300);key('Enter');await pause(4000);const resumedCard=shot('resumed-usage');
 const checks={root,binary,launcher,session,footerClaude:/Claude subscription/.test(card),showsClaudeLimits:/Claude/.test(card)&&/41%|59%/.test(card)&&/86%|14%/.test(card),
  resumedFooterClaude:/Claude subscription/.test(resumedFooter),resumedModelLine:(resumedCard.match(/Model:.*$/m)||[''])[0].trim(),resumedClaudeLimits:/Claude limit/.test(resumedCard)};fs.writeFileSync(path.join(root,'checks.json'),JSON.stringify(checks,null,2));console.log(JSON.stringify(checks));
 assert(checks.showsClaudeLimits,'/usage on a Claude chat shows Claude\'s 5-hour and weekly limits');
 console.log('PASS /usage on a Claude chat shows Claude subscription limits');
 assert(checks.resumedFooterClaude&&/Claude subscription/.test(checks.resumedModelLine)&&checks.resumedClaudeLimits,'a resumed Claude chat still shows Claude, not a GPT model');
 console.log('PASS resumed Claude chat shows Claude model and limits');
 }finally{try{tm('kill-server');}catch{}provider.close();usage.close();try{const dir=path.join(runtime,'elpis-bridge');for(const d of fs.readdirSync(dir)){const st=JSON.parse(fs.readFileSync(path.join(dir,d,'state.json')));process.kill(st.pid,'SIGTERM');}}catch{}}})().catch(e=>{console.error(e);process.exitCode=1;});
