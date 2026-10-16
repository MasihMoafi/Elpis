const { chooseOption, controlValue } = require("./controls.cjs");
// Browser contracts for the actual static app; fixtures never run model calls.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require(process.env.ELPIS_PLAYWRIGHT_PACKAGE||'playwright');
let browser,server,url,reconnectFixture;const clients=new Set();
before(async()=>{
 server=http.createServer(async(req,res)=>{
  const route=new URL(req.url,'http://local').pathname;
  if(route==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: connection\ndata: {"connected":true}\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
  if(reconnectFixture&&route.startsWith('/api/')){
   const f=reconnectFixture;f.calls.push({route,method:req.method});
   let data={data:[],nextCursor:null};
   if(route==='/api/health')data={connected:true};
   if(route==='/api/settings')data={main:{model:'fixture-model',provider:'fixture'},providers:[]};
   if(route==='/api/threads')data={data:[f.thread],nextCursor:null};
   if(route==='/api/threads/reconnect')data={thread:f.thread,data:[{turnId:'turn',item:{id:'reply',type:'agentMessage',text:f.reply}}],nextCursor:null};
   if(route==='/api/threads/reconnect/resume')data={thread:f.thread,activeTurnId:null};
   if(route==='/api/threads/reconnect/turns'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Delivery is unknown. Review the history.'}}));return;}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));return;
  }
  if(route.startsWith('/api/')){res.setHeader('content-type','application/json');res.end(JSON.stringify(route==='/api/health'?{connected:true}:{data:[],nextCursor:null}));return;}
  try{const file=path.join(__dirname,'../out',route==='/'?'index.html':route);res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:process.env.ELPIS_CHROMIUM||undefined,headless:true});
});
after(async()=>{await browser?.close();for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));});
async function open(){const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(5000);await page.goto(url);await page.getByRole('button',{name:'Workflows',exact:true}).click();return page;}
async function fillTask(page,title,kind='explore'){
 await page.getByRole('button',{name:'Add task',exact:true}).click();await page.getByLabel('Task title',{exact:true}).fill(title);await chooseOption(page.getByLabel('Task role'), kind);await page.getByLabel('Task instructions').fill(`Investigate ${title}`);await page.getByLabel('Acceptance criteria').fill(`Evidence for ${title}\nCounterexample for ${title}`);await page.getByLabel('Task title',{exact:true}).click();
}
async function exportDraft(page){await page.evaluate(()=>{const original=URL.createObjectURL;URL.createObjectURL=blob=>{window.__exportBlob=blob.text();return original.call(URL,blob);};});const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();assert.equal((await download).suggestedFilename(),'elpis-workflow.json');return JSON.parse(await page.evaluate(()=>window.__exportBlob));}
const task=(id,kind='explore',environment_id)=>({id,title:id,instruction:`Inspect ${id}`,kind,depends_on:[],write_scopes:kind==='implement'?['src']:[],acceptance_criteria:['Evidence exists'],...(environment_id?{environment_id}:{})});
const draft=tasks=>({name:'Imported workflow',max_concurrency:2,tasks});
async function importDraft(page,value){await page.getByText('Import a workflow',{exact:true}).click();await page.getByLabel('Workflow JSON').fill(JSON.stringify(value));await page.getByRole('button',{name:'Import',exact:true}).click();}

test('empty editor -> tasks, dependencies, drag, export, save/restore, mobile overflow',async()=>{
 const page=await open();try{
  await page.getByText('Add your first task to start a workflow.').waitFor();await page.getByRole('button',{name:'Export',exact:true}).click();await page.getByRole('status').filter({hasText:'Give the workflow a name'}).waitFor();
  await page.getByLabel('Workflow name').fill('Pruning evidence');await fillTask(page,'Measure tokens');await fillTask(page,'Review evidence','verify');await page.getByLabel('Measure tokens',{exact:true}).check();
  let result=await exportDraft(page);assert.equal(result.tasks.length,2);assert.deepEqual(result.tasks[1].depends_on,['task_1']);assert.deepEqual(result.tasks[0].acceptance_criteria,['Evidence for Measure tokens','Counterexample for Measure tokens']);
  const node=page.getByRole('button',{name:'Edit Measure tokens',exact:true});const before=await node.boundingBox();await node.focus();await page.keyboard.press('Alt+ArrowRight');const after=await node.boundingBox();assert.equal(after.x-before.x,20);await page.mouse.move(after.x+60,after.y+30);await page.mouse.down();await page.mouse.move(after.x+90,after.y+50);await page.mouse.up();const dragged=await node.boundingBox();assert.equal(dragged.x-after.x,30);assert.equal(dragged.y-after.y,20);
  await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByLabel('Task title',{exact:true}).fill('Unsaved edit');await page.getByRole('button',{name:'Restore',exact:true}).click();assert.equal(await controlValue(page.getByLabel('Task title',{exact:true})),'Measure tokens');
  result=await exportDraft(page);assert.equal(result.name,'Pruning evidence');assert.equal(result.tasks[1].title,'Review evidence');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'/tmp/elpis-workflow-mobile-390.png',fullPage:true});
 }finally{await page.close();}
});
test('cyclic and cross-environment verifier imports are rejected without replacing current draft',async()=>{
 const page=await open();try{
  await page.getByLabel('Workflow name').fill('Keep this draft');const a=task('a'),b=task('b');a.depends_on=['b'];b.depends_on=['a'];await importDraft(page,draft([a,b]));await page.getByRole('status').filter({hasText:'contain a cycle'}).waitFor();assert.equal(await controlValue(page.getByLabel('Workflow name')),'Keep this draft');
  const write=task('write','implement','workspace-a'),verify=task('verify','verify','workspace-b');verify.depends_on=['write'];await page.getByLabel('Workflow JSON').fill(JSON.stringify(draft([write,verify])));await page.getByRole('button',{name:'Import',exact:true}).click();await page.getByRole('status').filter({hasText:'same environment'}).waitFor();assert.equal(await controlValue(page.getByLabel('Workflow name')),'Keep this draft');
 }finally{await page.close();}
});
test('incomplete drafts can be saved/restored; storage errors are visible',async()=>{
 const page=await open();try{await page.getByRole('button',{name:'Add task',exact:true}).click();await page.getByLabel('Task title',{exact:true}).fill('Partial task');await page.getByLabel('Task instructions').fill('Unfinished instructions');await page.getByLabel('Acceptance criteria').fill('First criterion\nSecond criterion');await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByRole('status').filter({hasText:'Saved in this browser'}).waitFor();await page.getByLabel('Task title',{exact:true}).fill('Unsaved title');await page.getByLabel('Acceptance criteria').fill('Unsaved criterion');await page.getByRole('button',{name:'Restore',exact:true}).click();await page.getByRole('status').filter({hasText:'Saved draft restored'}).waitFor();assert.equal(await controlValue(page.getByLabel('Task title',{exact:true})),'Partial task');assert.equal(await controlValue(page.getByLabel('Task instructions')),'Unfinished instructions');assert.equal(await controlValue(page.getByLabel('Acceptance criteria')),'First criterion\nSecond criterion');await page.getByRole('button',{name:'Export',exact:true}).click();await page.getByRole('status').filter({hasText:'Give the workflow a name'}).waitFor();
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new Error('Storage blocked by fixture');};});await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByRole('status').filter({hasText:'Storage blocked by fixture'}).waitFor();
 }finally{await page.close();}
});
test('restore replaces criteria text even when task id remains selected',async()=>{
 const page=await open();try{await page.getByLabel('Workflow name').fill('Restore regression');await fillTask(page,'Evidence');await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByLabel('Acceptance criteria').fill('Unsaved criteria');await page.getByLabel('Task title',{exact:true}).click();await page.getByRole('button',{name:'Restore',exact:true}).click();assert.equal(await controlValue(page.getByLabel('Acceptance criteria')),'Evidence for Evidence\nCounterexample for Evidence');
 }finally{await page.close();}
});

test('canvas ports edit real dependencies, reject cycles, preserve timeout, and zoom dragging',async()=>{
 const page=await open();try{
  await importDraft(page,draft([task('inspect'),task('review')]));
  await page.getByLabel('Task timeout (seconds)').fill('120');
  await page.getByRole('button',{name:'Connect output: inspect',exact:true}).click();
  await page.getByRole('button',{name:'Connect input: review',exact:true}).click();
  assert.equal(await page.locator('svg path[data-from="inspect"][data-to="review"]').count(),1);
  await page.getByRole('button',{name:'Connect output: review',exact:true}).click();
  await page.getByRole('button',{name:'Connect input: inspect',exact:true}).click();
  await page.getByRole('status').filter({hasText:'would create a cycle'}).waitFor();
  assert.equal(await page.locator('svg path[data-from="review"][data-to="inspect"]').count(),0);
  await page.getByRole('button',{name:'Cancel connection',exact:true}).click();
  await page.getByRole('button',{name:'Remove connection from inspect to review',exact:true}).click();
  assert.equal(await page.locator('svg path[data-from="inspect"][data-to="review"]').count(),0);
  await page.getByRole('button',{name:'Connect output: inspect',exact:true}).click();
  await page.getByRole('button',{name:'Connect input: review',exact:true}).click();
  await page.getByRole('button',{name:'Arrange',exact:true}).click();
  assert.equal(await page.locator('[data-task="review"]').evaluate(node=>parseFloat(node.style.left)),460);
  await page.getByRole('button',{name:'Zoom out',exact:true}).click();
  assert.equal(await page.getByLabel('Canvas zoom').textContent(),'90%');
  const node=page.locator('[data-task="inspect"]'),box=await node.boundingBox();
  await page.mouse.move(box.x+30,box.y+30);await page.mouse.down();await page.mouse.move(box.x+75,box.y+48,{steps:3});await page.mouse.up();
  assert.equal(Math.round(await node.evaluate(node=>parseFloat(node.style.left))),280);
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.getByRole('button',{name:'Restore',exact:true}).click();
  let result=await exportDraft(page);assert.deepEqual(result.tasks[1].depends_on,['inspect']);assert.equal(result.max_runtime_seconds,120);
  await page.getByRole('button',{name:'Connect output: inspect',exact:true}).click();
  await page.getByRole('button',{name:'Connect input: review',exact:true}).click();
  result=await exportDraft(page);assert.deepEqual(result.tasks[1].depends_on,[]);
  await page.getByRole('button',{name:'Fit workflow',exact:true}).click();
  await page.getByRole('button',{name:'Connect output: inspect',exact:true}).click();await page.getByRole('button',{name:'Connect input: review',exact:true}).click();
  await page.getByRole('button',{name:'Arrange',exact:true}).click();
  await page.locator('.page-scroll').evaluate(element=>{element.scrollTop=0;});
  for(const dark of [false,true]){if(dark)await page.getByRole('button',{name:'Use dark theme'}).click();await page.waitForTimeout(150);await page.screenshot({path:`/tmp/elpis-workflow-canvas-${dark?'dark':'light'}.png`,fullPage:true});}
 }finally{await page.close();}
});

test('connection recovery preserves draft and delivery error, clears stale approvals and reloads history',async()=>{
 reconnectFixture={thread:{id:'reconnect',name:'Reconnect conversation',model:'fixture-model',modelProvider:'fixture',status:{type:'idle'},desktopAccess:{writable:true}},reply:'Before reconnect',calls:[]};
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(5000);
 const event=(name,data)=>{for(const client of clients)client.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);};
 try{
  await page.goto(url);await page.locator('.thread-link').filter({hasText:'Reconnect conversation'}).click();
  await page.getByText('Before reconnect',{exact:true}).waitFor();
  await page.getByLabel('Message Elpis',{exact:true}).fill('Keep this draft');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Delivery is unknown'}).waitFor();
  event('approval',{id:'stale',params:{threadId:'reconnect',reason:'Stale approval',availableDecisions:['accept']}});
  await page.getByText('Stale approval',{exact:true}).waitFor();
  event('connection',{connected:false});
  await page.getByRole('status').filter({hasText:'Reconnecting to Elpis'}).waitFor();
  assert.equal(await page.getByLabel('Message Elpis',{exact:true}).isDisabled(),true);
  assert.equal(await page.getByText('Stale approval',{exact:true}).count(),0);
  reconnectFixture.reply='Recovered history';const calls=reconnectFixture.calls.length;
  event('connection',{connected:true});
  await page.getByText('Recovered history',{exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('textarea[aria-label="Message Elpis"]').disabled);
  assert.equal(await controlValue(page.getByLabel('Message Elpis',{exact:true})),'Keep this draft');
  assert.equal(await page.getByRole('alert').filter({hasText:'Delivery is unknown'}).count(),1);
  await new Promise(resolve=>setTimeout(resolve,100));
  const refreshed=reconnectFixture.calls.slice(calls).map(call=>call.route);
  for(const route of ['/api/threads','/api/models','/api/settings','/api/threads/reconnect','/api/threads/reconnect/resume'])assert(refreshed.includes(route),route);
  assert.equal(reconnectFixture.calls.filter(call=>call.route==='/api/threads/reconnect/turns').length,1,'unknown delivery is never replayed');
 }finally{await page.close();reconnectFixture=null;}
});
