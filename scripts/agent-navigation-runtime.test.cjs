'use strict';
// Real Agent command center, native collaboration and chat navigation; no dashboard requests.
// Usage: node scripts/agent-navigation-runtime.test.cjs /absolute/engine [/absolute/launcher]
const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const http=require('node:http'); const {once}=require('node:events');
const {execFileSync}=require('node:child_process'); const {DatabaseSync}=require('node:sqlite');
const args=process.argv.slice(2);
const repo=path.resolve(__dirname,'..'), binary=args[0];
assert(binary&&path.isAbsolute(binary),'absolute binary required');
const launcher=args[1]??path.join(path.dirname(binary),'tools/elpis-claude/elpis-claude');
assert(fs.existsSync(launcher),'bundled launcher required');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'elpis-agent-navigation-'));
const userHome=path.join(root,'home'),home=path.join(userHome,'.elpis-next'),cwd=path.join(userHome,'source'),runtime=path.join(root,'run');
for(const p of [home,cwd,runtime])fs.mkdirSync(p,{recursive:true,mode:0o700});
const env={PATH:process.env.PATH,HOME:userHome,ELPIS_HOME:home,CODEX_HOME:home,CODEX_AUTH_HOME:home,XDG_RUNTIME_DIR:runtime,BROWSER:'/bin/true',TERM:'xterm-256color',LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(userHome,'.gitconfig'),ELPIS_ENGINE_BIN:binary,ELPIS_NO_AGY:'1',ACP_BRIDGE_NO_AGENTS:'1',ACP_ADAPTER:path.join(repo,'scripts/permissions-bridge.test.cjs'),PERMISSION_FIXTURE_ADAPTER:'1'};
const socket=path.join(root,'tmux.sock'),requests=[],checks=[],failures=[];
const quote=s=>`'${s.replaceAll("'","'\\''")}'`;
const tmux=(...args)=>execFileSync('tmux',['-S',socket,...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const git=(...args)=>execFileSync('git',['-C',cwd,...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const screen=()=>tmux('capture-pane','-p','-t','test');
async function submit(text){tmux('send-keys','-t','test','-l',text);await pause(200);tmux('send-keys','-t','test','Enter');}
function save(name,value){fs.writeFileSync(path.join(root,name),typeof value==='string'?value:JSON.stringify(value,null,2));}
function check(condition,label){(condition?checks:failures).push(label);console.log(`${condition?'PASS':'FAIL'} ${label}`);}
let providerError,server,rootId,childId,spawnIssued=false,spawnRequested=false,childRequested=false,childReleased=false;
let releaseSpawn;const spawnGate=new Promise(resolve=>{releaseSpawn=resolve;});
let releaseChild;const childGate=new Promise(resolve=>{releaseChild=()=>{childReleased=true;resolve();};});
async function waitFor(predicate,label,timeout=20000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(providerError)throw providerError;if(await predicate())return;await pause(100);}save(`${label}-timeout.txt`,screen());throw Error(`Timed out ${label}; evidence ${root}`);}
function threads(){const file=fs.readdirSync(home).find(n=>/^state_\d+\.sqlite$/.test(n));if(!file)return[];const db=new DatabaseSync(path.join(home,file),{readOnly:true});try{return db.prepare('SELECT id, cwd, rollout_path, agent_nickname, name FROM threads').all();}finally{db.close();}}
const message=text=>({type:'message',id:`msg_${Date.now()}`,role:'assistant',content:[{type:'output_text',text}]});
function sendResponse(res,item,id){const events=[{type:'response.created',response:{id}}];if(item.type==='message'){events.push({type:'response.output_item.added',output_index:0,item:{...item,content:[]}});events.push({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});}events.push({type:'response.output_item.done',output_index:0,item});events.push({type:'response.completed',response:{id,usage:{input_tokens:500,output_tokens:20,total_tokens:520}}});res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));}
async function startProvider(){server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));if(body.text?.format?.schema?.required?.includes('title')){sendResponse(res,message(JSON.stringify({title:'Agents fixture'})),`title_${Date.now()}`);return;}
const users=(body.input||[]).filter(i=>i.type==='message'&&i.role==='user');const latestUser=JSON.stringify(users.at(-1)||{});
const child=(body.input||[]).some(i=>i.type==='agent_message'&&i.recipient==='/root/dashboard_child');requests.push({path:req.url,role:child?'child':'root',body});const id=`response_${requests.length}`;
if(child){childRequested=true;await childGate;sendResponse(res,message('CHILD_FIXTURE_COMPLETED'),id);return;}
if(latestUser.includes('ELPIS_ROOT_DRIVER_20261013')&&!spawnIssued){const tools=(body.tools||[]).flatMap(t=>t.type==='namespace'?t.tools.map(c=>({...c,namespace:t.name})):[t]);const tool=tools.find(t=>t.name==='spawn_agent');assert(tool,'native spawn_agent must be advertised');save('spawn-tool.json',tool);spawnIssued=true;const item={type:'function_call',id:'fc_spawn_fixture',call_id:'spawn_fixture',name:tool.name,arguments:JSON.stringify({task_name:'dashboard_child',fork_turns:'none',message:'ELPIS_CHILD_FIXTURE_20261013: reply CHILD_FIXTURE_COMPLETED. Read only; do not change files.'})};if(tool.namespace)item.namespace=tool.namespace;spawnRequested=true;await spawnGate;sendResponse(res,item,id);return;}
sendResponse(res,message(spawnIssued?'ROOT_SPAWN_COMPLETED':'ROOT_FIXTURE_READY'),id);
}catch(error){providerError??=error;try{res.writeHead(500);res.end(error.message);}catch{}}});server.listen(0,'127.0.0.1');await once(server,'listening');return`http://127.0.0.1:${server.address().port}/v1`;}

(async()=>{git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(cwd,'readme.txt'),'Agent fixture\n');git('add','readme.txt');git('commit','-m','Fixture');const providerUrl=await startProvider();
const model=structuredClone(require(path.join(repo,'codex-rs/models-manager/models.json')).models.find(m=>m.slug==='gpt-5.5'));assert(model);model.multi_agent_version='v2';const catalog=path.join(home,'models.json');fs.writeFileSync(catalog,JSON.stringify({models:[model]}));fs.writeFileSync(path.join(home,'hooks.json'),'{}');
fs.writeFileSync(path.join(home,'config.toml'),`model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(catalog)}\napproval_policy="never"\nsandbox_mode="workspace-write"\n[features]\ncode_mode=false\nautomatic_context_pruning=false\nmulti_agent=true\nmulti_agent_v2=true\nworktrees=false\n[agents]\nmax_threads=3\n[model_providers.fixture]\nname="Agents fixture"\nbase_url=${JSON.stringify(providerUrl)}\nwire_api="responses"\nrequires_openai_auth=false\n[tui]\nanimations=false\n[projects.${JSON.stringify(userHome)}]\ntrust_level="trusted"\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
const command=['env','-i',...Object.entries(env).map(([k,v])=>`${k}=${v}`),launcher,'--no-alt-screen','-C',cwd].map(quote).join(' ');tmux('new-session','-d','-s','test','-x','110','-y','46',command);
await waitFor(()=>{const s=screen();if(s.includes('Hooks need review')){tmux('send-keys','-t','test','Escape');return false;}return s.includes('Elpis')&&/gpt-5[.]5/i.test(s)&&!s.includes('esc to interrupt');},'startup');
await submit('Initialize this fixture conversation.');await waitFor(()=>screen().includes('ROOT_FIXTURE_READY')&&!screen().includes('esc to interrupt'),'root-ready');rootId=threads()[0]?.id;assert(rootId,'root persisted');
const press=key=>tmux('send-keys','-t','test',key);
const saveScreen=label=>{save(label+'.txt',screen());save(label+'.ansi',tmux('capture-pane','-p','-e','-t','test'));};
press('Left');await waitFor(()=>screen().includes('Agent command center'),'initial-command-center');saveScreen('initial-command-center');check(screen().includes('Agents fixture'),'command center contains root before spawn');press('Escape');await waitFor(()=>!screen().includes('Agent command center'),'return-before-spawn');
await submit('ELPIS_ROOT_DRIVER_20261013: spawn the one read-only child described in this fixture, then finish.');await waitFor(()=>spawnRequested,'spawn-response-held');
press('Left');await waitFor(()=>screen().includes('Agent command center'),'command-center-before-spawn');saveScreen('command-center-before-spawn');check(threads().length===1,'command center opens before native child is spawned');
releaseSpawn();await waitFor(()=>childRequested,'child-request',30000);await waitFor(()=>threads().some(t=>t.id!==rootId),'child-persisted');const childThread=threads().find(t=>t.id!==rootId);childId=childThread.id;
check(screen().includes('Agent command center'),'command center stays open during actual native spawn');
const aliases=[childThread.agent_nickname,childThread.name].filter(Boolean);
check(aliases.length>0,'native child has an actual recorded display name');
const childRow=()=>screen().split('\n').map(line=>line.split('│')[0]).find(line=>line.includes('GPT-5.5')&&aliases.some(alias=>line.includes(alias)));
const deadline=Date.now()+6000;while(!childRow()&&Date.now()<deadline)await pause(100);
saveScreen('working-command-center');save('thread-identities.json',{rootId,childId,childThread,aliases});
const workingChild=childRow();check(Boolean(workingChild),'already-open command center discovers working child without reopening or dashboard');
if(workingChild){const lines=screen().split('\n').map(line=>line.split('│')[0]),parentLine=lines.find(line=>line.includes('Agents fixture')&&line.includes('GPT-5.5'));const nested=/[├└↳]/.test(workingChild)||(parentLine&&aliases.some(alias=>workingChild.indexOf(alias)>parentLine.indexOf('Agents fixture')));check(Boolean(parentLine&&lines.indexOf(parentLine)<lines.indexOf(workingChild)&&nested),'child is visibly nested under its parent');
for(let i=0;i<8&&!childRow()?.trimStart().startsWith('›');i++){press('Down');await pause(100);}check(Boolean(childRow()?.trimStart().startsWith('›')),'working child row is selectable');press('Enter');await waitFor(()=>!screen().includes('Agent command center'),'opened-child-chat');saveScreen('working-child-chat');check(!screen().includes('ROOT_SPAWN_COMPLETED'),'Enter opens child conversation rather than parent transcript');
}
releaseChild();await waitFor(()=>{const child=threads().find(t=>t.id===childId);return child&&fs.existsSync(child.rollout_path)&&fs.readFileSync(child.rollout_path,'utf8').trim().split('\n').some(line=>{const e=JSON.parse(line);return e.type==='response_item'&&e.payload?.type==='message'&&e.payload?.role==='assistant'&&e.payload.content?.some(c=>c.text==='CHILD_FIXTURE_COMPLETED');});},'child-completed');
if(workingChild){await waitFor(()=>screen().includes('CHILD_FIXTURE_COMPLETED'),'child-transcript-shown');saveScreen('completed-child-chat');check(screen().includes('CHILD_FIXTURE_COMPLETED'),'opened child chat shows actual assistant completion');press('Left');await waitFor(()=>screen().includes('Agent command center'),'return-command-center');
const parentRow=()=>screen().split('\n').map(line=>line.split('│')[0]).find(line=>line.includes('Agents fixture')&&line.includes('GPT-5.5'));for(let i=0;i<8&&!parentRow()?.trimStart().startsWith('›');i++){press('Up');await pause(100);}check(Boolean(parentRow()?.trimStart().startsWith('›')),'parent row remains selectable');press('Enter');await waitFor(()=>!screen().includes('Agent command center')&&screen().includes('ROOT_SPAWN_COMPLETED'),'returned-parent');saveScreen('returned-parent-chat');check(screen().includes('ROOT_SPAWN_COMPLETED'),'parent navigation returns original parent transcript');
}else{await pause(500);saveScreen('completed-command-center');check(Boolean(childRow()),'completed child remains visible in command center');}
// A second genuine root in the same cwd must remain a sibling, never a fabricated parent.
await submit('/new');await pause(400);await submit('Initialize the unrelated same-folder conversation.');
await waitFor(()=>threads().length===3&&screen().includes('ROOT_SPAWN_COMPLETED'),'unrelated-root-created');
await submit('/rename Unrelated root');await waitFor(()=>threads().some(t=>t.name==='Unrelated root'),'unrelated-root-named');
const unrelated=threads().find(t=>t.name==='Unrelated root');
check(unrelated.cwd===childThread.cwd&&unrelated.id!==rootId&&unrelated.id!==childId,'negative control is a real unrelated root in the same working directory');
press('Left');await waitFor(()=>screen().includes('Agent command center')&&Boolean(childRow())&&screen().includes('Unrelated root'),'same-folder-roots');
saveScreen('same-folder-roots');
const taskLines=screen().split('\n').map(line=>line.split('│')[0]).filter(line=>line.includes('GPT-5.5'));
const childIndex=taskLines.findIndex(line=>aliases.some(alias=>line.includes(alias)));
const nearestRoot=taskLines.slice(0,childIndex).reverse().find(line=>!/[↳├└]/.test(line));
check(Boolean(nearestRoot?.includes('Agents fixture'))&&!nearestRoot.includes('Unrelated root'),'same cwd does not move child beneath unrelated root');
check(taskLines.some(line=>line.includes('Unrelated root')&&!/[↳├└]/.test(line)),'unrelated conversation remains a root row');
const dbName=fs.readdirSync(home).find(x=>/^state_\d+\.sqlite$/.test(x));const db=new DatabaseSync(path.join(home,dbName),{readOnly:true});
try{const edges=db.prepare('select parent_thread_id,child_thread_id from thread_spawn_edges').all();save('recorded-parent-edges.json',edges);check(edges.some(e=>e.child_thread_id===childId&&e.parent_thread_id===rootId)&&!edges.some(e=>e.parent_thread_id===unrelated.id||e.child_thread_id===unrelated.id),'displayed hierarchy matches persisted native parent edge');}finally{db.close();}
assert.equal(failures.length,0,`TUI agent command-center failures: ${failures.join('; ')}`);
})().catch(error=>{save('error.txt',error.stack);console.error(error.stack);process.exitCode=1;}).finally(async()=>{releaseSpawn();releaseChild();try{tmux('kill-server');}catch{}
const saved=process.env.XDG_RUNTIME_DIR;try{process.env.XDG_RUNTIME_DIR=runtime;const {runtimeDir,startToken}=await import(path.join(path.dirname(launcher),'shared-runtime.mjs'));const file=runtimeDir(home).state;if(fs.existsSync(file)){const state=JSON.parse(fs.readFileSync(file));if(startToken(state.pid)===state.token){process.kill(state.pid,'SIGTERM');const until=Date.now()+10000;while(startToken(state.pid)===state.token&&Date.now()<until)await pause(50);assert.notEqual(startToken(state.pid),state.token,'isolated bridge stopped');}}}finally{if(saved===undefined)delete process.env.XDG_RUNTIME_DIR;else process.env.XDG_RUNTIME_DIR=saved;if(server){server.closeAllConnections();server.close();}const receipt={root,binary,launcher,rootId,childId,checks,failures,spawnIssued,spawnRequested,childRequested,childReleased,requests};save('evidence.json',receipt);console.log(`Evidence: ${root}`);}});
