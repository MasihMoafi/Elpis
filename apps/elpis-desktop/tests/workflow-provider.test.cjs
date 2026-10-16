const { chooseOption, controlValue } = require("./controls.cjs");
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const http=require('node:http');const {chromium}=require(process.env.ELPIS_PLAYWRIGHT_PACKAGE||'playwright');
function workflowModelPicker(page,label) {
 return page.getByRole('group',{name:label,exact:true}).getByRole('combobox',{name:'Model',exact:true});
}
async function chooseUnlistedWorkflowModel(page,label,provider,model) {
 await workflowModelPicker(page,label).click();
 if(!await page.getByRole('textbox',{name:'Model ID',exact:true}).isVisible())await page.getByText('Advanced: use an unlisted model',{exact:true}).click();
 await chooseOption(page.getByLabel('Provider',{exact:true}),provider);
 await page.getByRole('textbox',{name:'Model ID',exact:true}).fill(model);
 await page.getByRole('button',{name:'Use model',exact:true}).click();
}

test('alternate configured provider requires explicit model and native thread keeps it on later sends',async()=>{
 const calls=[],clients=new Set();const thread={id:'local-thread',name:'Local conversation',modelProvider:'local',model:'local/custom-model',status:{type:'idle'},desktopAccess:{writable:true,reason:null}};
 const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://local');let body='';for await(const chunk of req)body+=chunk;const data=body?JSON.parse(body):undefined;calls.push({method:req.method,path:url.pathname,data});const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};if(url.pathname==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: connection\ndata: {"connected":true}\n\n');clients.add(res);return;}if(url.pathname==='/api/health')return json({connected:true});if(url.pathname==='/api/settings')return json({main:{provider:'openai',model:'gpt-6-luna'},providers:[{id:'openai',displayName:'OpenAI'},{id:'local',displayName:'Local endpoint'}],managed:{modelProvider:null}});if(url.pathname==='/api/models')return json({data:url.searchParams.get('provider')==='local'?[]:[{id:'luna',model:'gpt-6-luna',displayName:'Luna 6'}]});if(url.pathname==='/api/threads')return json(req.method==='POST'?{thread}:{data:[],nextCursor:null});if(url.pathname==='/api/threads/local-thread/turns'){json({turn:{id:'turn-'+calls.length}});const turnId='turn-'+calls.length;setTimeout(()=>{for(const client of clients)client.write(`event: message\ndata: ${JSON.stringify({method:'turn/completed',params:{threadId:thread.id,turn:{id:turnId,status:'completed'}}})}\n\n`);},50);return;}try{const file=path.join(__dirname,'../out',url.pathname==='/'?'index.html':url.pathname);res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({executablePath:process.env.ELPIS_CHROMIUM||undefined,headless:true});try{const page=await browser.newPage();page.setDefaultTimeout(7000);await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByLabel('Model',{exact:true}).click();await page.getByText('Advanced: use an unlisted model',{exact:true}).click();await chooseOption(page.getByLabel('Provider',{exact:true}), 'local');assert.equal(await page.getByRole('button',{name:'Use model',exact:true}).isDisabled(),true);await page.getByLabel('Model ID',{exact:true}).fill('local/custom-model');await page.getByRole('button',{name:'Use model',exact:true}).click();await page.getByLabel('Message Elpis').fill('Use local provider');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.waitForFunction(()=>document.querySelector('textarea').value==='');assert.deepEqual(calls.find(c=>c.path==='/api/threads'&&c.method==='POST').data,{model:'local/custom-model',provider:'local'});assert.deepEqual(calls.find(c=>c.path.endsWith('/turns')).data,{text:'Use local provider'});await page.getByRole('button',{name:'Send message',exact:true}).waitFor();assert.equal(await controlValue(page.getByLabel('Model',{exact:true})),'local/custom-model');await page.getByLabel('Message Elpis').fill('Keep the same model');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.waitForFunction(()=>document.querySelector('textarea').value==='');assert.deepEqual(calls.filter(c=>c.path.endsWith('/turns')).at(-1).data,{text:'Keep the same model'});
 }finally{await browser.close();for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));}
});

test('workflows reject subscription routes while native custom providers can run reviewed graphs',async()=>{
 const clients=new Set(),runs=[];
 const thread=(id,model,provider)=>({id,name:id,model,modelProvider:provider,status:{type:'idle'},desktopAccess:{writable:true,mode:'direct'}});
 const threads=[thread('claude-workflow','claude/opus','openai'),thread('gemini-workflow','agy/gemini-3-pro','openai'),thread('native-workflow','custom/native-model','local')];
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://local'),route=url.pathname;
  const json=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
  if(route==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: connection\ndata: {"connected":true}\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
  if(route==='/api/health')return json({connected:true});
  if(route==='/api/settings')return json({main:{model:'native-model',provider:'openai'},providers:[{id:'openai',displayName:'OpenAI'},{id:'local',displayName:'Local'}]});
  if(route==='/api/models'){const provider=url.searchParams.get('provider');return json({data:provider==='local'?[{id:'local-native-model',model:'local-native-model',displayName:'Local native model'}]:provider?[{id:'native-model',model:'native-model',displayName:'Native model'}]:[{id:'native-model',model:'native-model',displayName:'Native model'},{id:'claude/opus',model:'claude/opus',displayName:'Opus subscription'},{id:'agy/gemini-3-pro',model:'agy/gemini-3-pro',displayName:'Gemini subscription'}]});}
  if(route==='/api/threads')return json({data:url.searchParams.has('ancestorThreadId')?[]:threads,nextCursor:null});
  if(route.startsWith('/api/threads/')){const t=threads.find(t=>t.id===route.split('/')[3]);return json({thread:t,data:[],nextCursor:null,activeTurnId:null});}
  if(route==='/api/workflows')return json({data:[]});
  if(route==='/api/workflows/run'){let raw='';for await(const chunk of req)raw+=chunk;runs.push(JSON.parse(raw));return json({threadId:runs.at(-1).rootThreadId,turnId:'native-workflow-turn'});}
  try{const file=path.join(__dirname,'../out',route==='/'?'index.html':route);res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.ELPIS_CHROMIUM||undefined,headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(7000);
 try{
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByText('Local workspace',{exact:true}).waitFor();
  for(const id of ['claude-workflow','gemini-workflow']){
   await page.locator(`.thread-row[data-thread-id="${id}"] .thread-link`).click();
   await page.locator('aside').getByRole('button',{name:'Workflows',exact:true}).click();
   const compatibility=page.getByText('Workflows currently run on native-provider conversations. Choose or create one to run this graph.',{exact:true});assert.ok((await compatibility.boundingBox()).y < (await page.getByLabel('Workflow name',{exact:true}).boundingBox()).y,'Provider restriction must be visible before graph editing');
   if(id==='claude-workflow'){
    await page.screenshot({path:'/tmp/elpis-workflow-subscription-notice-before-editing.png'});
    await page.getByText('Import a workflow',{exact:true}).click();
    await page.getByLabel('Workflow JSON').fill(JSON.stringify({name:'Native workflow',max_concurrency:2,tasks:[{id:'inspect',title:'Inspect',instruction:'Read only',kind:'explore',depends_on:[],write_scopes:[],acceptance_criteria:['Evidence exists']},{id:'review',title:'Review evidence',instruction:'Review only',kind:'explore',depends_on:['inspect'],write_scopes:[],acceptance_criteria:['Evidence reviewed'],provider:'openai',model:'native-model'}]}));
    await page.getByRole('button',{name:'Import',exact:true}).click();
   }
   await page.getByText('Workflows currently run on native-provider conversations. Choose or create one to run this graph.',{exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Run workflow',exact:true}).isDisabled(),true);
   assert.equal(runs.length,0);
  }
  await page.getByRole('button',{name:'Create workflow conversation',exact:true}).click();
  await workflowModelPicker(page,'Workflow model').click();
  await page.getByRole('option').and(page.locator('[data-value="native-model"]')).waitFor();
  const options=await page.getByRole('option').evaluateAll(options=>options.map(option=>option.getAttribute('data-value')));
  await page.keyboard.press('Escape');
  assert(options.includes('native-model'));assert.ok(!options.some(model=>/^(claude|agy)\//.test(model)));
  await chooseOption(page.getByLabel('Workflow provider',{exact:true}), 'local');
  await chooseUnlistedWorkflowModel(page,'Workflow model','local','claude/opus');
  assert.equal(await page.getByRole('button',{name:'Create conversation',exact:true}).isDisabled(),true);
  await chooseUnlistedWorkflowModel(page,'Workflow model','local','custom/native-model');
  assert.equal(await page.getByRole('button',{name:'Create conversation',exact:true}).isEnabled(),true);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.locator('.thread-row[data-thread-id="native-workflow"] .thread-link').click();
  await page.locator('aside').getByRole('button',{name:'Workflows',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Run workflow',exact:true}).isEnabled(),true);
  await page.getByRole('button',{name:'Edit Inspect',exact:true}).click();
  await page.getByLabel('Task provider',{exact:true}).click();
  await page.getByRole('option',{name:'Local',exact:true}).waitFor();
  const taskProviders=await page.getByRole('option').allTextContents();
  await page.keyboard.press('Escape');
  assert.ok(taskProviders.includes('Local'));assert.ok(!taskProviders.some(label=>/Claude|Gemini|Antigravity/i.test(label)));
  await chooseOption(page.getByLabel('Task provider',{exact:true}), 'local');
  assert.equal(await page.getByRole('button',{name:'Run workflow',exact:true}).isDisabled(),true);
  await chooseUnlistedWorkflowModel(page,'Task model','local','claude/opus');
  assert.equal(await page.getByRole('button',{name:'Run workflow',exact:true}).isDisabled(),true);
  await chooseUnlistedWorkflowModel(page,'Task model','local','custom/task-model');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await chooseUnlistedWorkflowModel(page,'Task model','local','unsaved/change');
  await page.getByRole('button',{name:'Restore',exact:true}).click();
  assert.equal(await controlValue(workflowModelPicker(page,'Task model')),'custom/task-model');
  await page.evaluate(()=>{const original=URL.createObjectURL;URL.createObjectURL=blob=>{window.__workflowExport=blob.text();return original.call(URL,blob);};});
  const downloadWait=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();
  const download=await downloadWait;assert.equal(download.suggestedFilename(),'elpis-workflow.json');const exported=JSON.parse(await page.evaluate(()=>window.__workflowExport));
  assert.equal(exported.tasks[0].provider,'local');assert.equal(exported.tasks[0].model,'custom/task-model');
  await workflowModelPicker(page,'Task model').click();
  await page.getByRole('option').and(page.locator('[data-value="local-native-model"]')).waitFor();
  const taskModels=await page.getByRole('option').evaluateAll(options=>options.map(option=>option.getAttribute('data-value')));
  assert.ok(taskModels.includes('local-native-model'));assert.ok(!taskModels.includes('native-model'));assert.ok(!taskModels.some(model=>/^(claude|agy)\//.test(model)));
  await page.keyboard.press('Escape');
  await chooseOption(page.getByLabel('Task provider',{exact:true}), '');
  assert.equal(await controlValue(workflowModelPicker(page,'Task model')),'');
  assert.match(await workflowModelPicker(page,'Task model').textContent(),/custom\/native-model/);
  assert.equal(await page.getByRole('button',{name:'Run workflow',exact:true}).isEnabled(),true);
  await page.getByLabel('Workflow JSON').fill(JSON.stringify(exported));await page.getByRole('button',{name:'Import',exact:true}).click();
  assert.equal(await controlValue(page.getByLabel('Task provider',{exact:true})),'local');assert.equal(await controlValue(workflowModelPicker(page,'Task model')),'custom/task-model');
  await page.setViewportSize({width:1440,height:1200});await page.getByLabel('Workflow name',{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'/tmp/elpis-workflow-task-providers-light.png',fullPage:true});
  await page.getByRole('button',{name:'Use dark theme',exact:true}).click();await page.waitForTimeout(150);
  await page.screenshot({path:'/tmp/elpis-workflow-task-providers-dark.png',fullPage:true});

  await page.getByRole('button',{name:'Run workflow',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Run acknowledged'}).waitFor();
  assert.equal(runs.length,1);assert.equal(runs[0].rootThreadId,'native-workflow');assert.equal(runs[0].tasks[0].provider,'local');assert.equal(runs[0].tasks[0].model,'custom/task-model');assert.equal(runs[0].tasks[1].provider,'openai');assert.equal(runs[0].tasks[1].model,'native-model');assert.deepEqual(runs[0].tasks[1].dependsOn,['inspect']);
 }finally{await browser.close();for(const client of clients)client.end();await new Promise(r=>server.close(r));}
});
