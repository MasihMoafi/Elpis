const { openSettings } = require('./controls.cjs');
const { chooseOption, controlValue } = require("./controls.cjs");
// Exercises the exported app against a local settings adapter; no provider calls.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const http=require('node:http');const {chromium}=require(process.env.ELPIS_PLAYWRIGHT_PACKAGE||'playwright');
test('maintenance saves only edited fields, applies switches at once and preserves model edits on conflict',async()=>{
 let settings={version:'v1',main:{model:'main-model',provider:'openai'},background:{model:null,provider:null},providers:[{id:'openai',displayName:'OpenAI'},{id:'local',displayName:'Local'}],smartPrune:{enabled:true,explicitOverride:{available:true,model:null,provider:null,version:'p1'}},memory:{generate:null,use:true,extractionModel:null,consolidationModel:null},write:{available:true,reason:'Applies to new conversations.'}};
 const calls=[],clients=new Set();let reject=false;
 const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://local');let body='';for await(const chunk of req)body+=chunk;const data=body?JSON.parse(body):undefined;const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
 if(url.pathname==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: connection\ndata: {"connected":true}\n\n');clients.add(res);return;}
 if(url.pathname==='/api/health')return json({connected:true});if(url.pathname==='/api/models')return json({data:[{id:'main-model',model:'main-model',displayName:'Main model'},{id:'cheap-model',model:'cheap-model',displayName:'Cheap model'},{id:'gpt-6-luna',model:'gpt-6-luna',displayName:'Luna'}]});if(url.pathname==='/api/threads')return json({data:[],nextCursor:null});
 if(url.pathname==='/api/settings'&&req.method==='GET')return json(settings);
 if(url.pathname==='/api/settings'&&req.method==='POST'){calls.push({path:url.pathname,data});if(reject){res.statusCode=409;return json({error:'Settings changed elsewhere. Reload before saving.'});}settings={...settings,version:'v2',main:{...settings.main,...data.main},background:{...settings.background,...data.background},memory:{...settings.memory,...data.memory}};return json(settings);}
 if(url.pathname==='/api/pruner'){calls.push({path:url.pathname,data});settings={...settings,smartPrune:{...settings.smartPrune,explicitOverride:{...settings.smartPrune.explicitOverride,...data,version:'p2'}}};return json(settings);}
 try{const file=path.join(__dirname,'../out',url.pathname==='/'?'index.html':url.pathname);res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({executablePath:process.env.ELPIS_CHROMIUM,headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1280,height:960}});page.setDefaultTimeout(7000);
 try{await page.goto(`http://127.0.0.1:${server.address().port}`);await openSettings(page);await page.getByRole('tab',{name:'Configuration',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Save background model'}).isDisabled(),true);
 await chooseOption(page.getByLabel('Background model',{exact:true}), 'cheap-model');await page.getByRole('button',{name:'Save background model'}).click();await page.getByRole('status').filter({hasText:'Background model saved'}).waitFor();assert.deepEqual(calls[0],{path:'/api/settings',data:{version:'v1',background:{model:'cheap-model'}}});
 // Memory switches apply at once with the version the previous save returned; unset values show Elpis's defaults.
 await page.getByRole('tab',{name:'Personalization',exact:true}).click();
 const use=page.getByRole('switch',{name:'Use memories',exact:true});assert.equal(await use.getAttribute('aria-checked'),'true');assert.equal(await page.getByRole('switch',{name:'Generate memories',exact:true}).getAttribute('aria-checked'),'true','unset generation follows the Elpis default');
 await use.click();await page.getByRole('status').filter({hasText:/^Saved\. Applies to new conversations\.$/}).waitFor();assert.deepEqual(calls[1],{path:'/api/settings',data:{version:'v2',memory:{use:false}}});assert.equal(await use.getAttribute('aria-checked'),'false');
 // A conflicting save keeps the unsaved model choice until the person reloads.
 reject=true;assert.equal(await page.getByRole('button',{name:'Save memory models'}).isDisabled(),true);
 await chooseOption(page.getByLabel('Memory extraction model',{exact:true}), 'cheap-model');await page.getByRole('button',{name:'Save memory models'}).click();await page.getByRole('alert').filter({hasText:'Settings changed elsewhere'}).waitFor();assert.equal(await controlValue(page.getByLabel('Memory extraction model',{exact:true})),'cheap-model');assert.deepEqual(calls[2].data,{version:'v2',memory:{extractionModel:'cheap-model'}});
 reject=false;await page.getByRole('tabpanel',{name:'Personalization'}).getByRole('button',{name:'Reload settings',exact:true}).click();await page.getByRole('status').filter({hasText:'Settings reloaded'}).waitFor();assert.equal(await controlValue(page.getByLabel('Memory extraction model',{exact:true})),'');assert.equal(await page.getByRole('button',{name:'Save memory models'}).isDisabled(),true);
 await page.getByRole('tab',{name:'Configuration',exact:true}).click();
 await chooseOption(page.getByLabel('Pruning model selection',{exact:true}), 'explicit');assert.equal(await page.getByRole('button',{name:'Save pruning model'}).isDisabled(),true);await chooseOption(page.getByLabel('Pruning provider',{exact:true}), 'openai');await chooseOption(page.getByLabel('Pruning model',{exact:true}), 'gpt-6-luna');await page.getByRole('button',{name:'Save pruning model'}).click();await page.getByRole('status').filter({hasText:'Pruning model saved'}).waitFor();assert.deepEqual(calls[3],{path:'/api/pruner',data:{version:'p1',model:'gpt-6-luna',provider:'openai',reasoningEffort:null}});
 await chooseOption(page.getByLabel('Pruning model selection',{exact:true}), 'background');await page.getByRole('button',{name:'Save pruning model'}).click();await page.getByRole('status').filter({hasText:'Pruning model saved'}).waitFor();assert.deepEqual(calls[4],{path:'/api/pruner',data:{version:'p2',model:null,provider:null,reasoningEffort:null}});
 assert.equal(settings.main.model,'main-model');
 // The main model is chosen here too, saved where the TUI reads it; it can't be cleared, so there is no empty choice.
 assert.equal(await page.getByRole('button',{name:'Save main model'}).isDisabled(),true);
 assert.equal(await page.getByLabel('Main model',{exact:true}).locator('option[value=""]').count(),0);
 await chooseOption(page.getByLabel('Main model',{exact:true}), 'gpt-6-luna');await page.getByRole('button',{name:'Save main model'}).click();await page.getByRole('status').filter({hasText:'Main model saved'}).waitFor();
 assert.deepEqual(calls.at(-1).data.main,{model:'gpt-6-luna'});assert.equal(settings.main.model,'gpt-6-luna');const background=page.getByRole('region',{name:'Models',exact:true});await background.scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/elpis-maintenance-1280.png'});await page.setViewportSize({width:390,height:844});await background.screenshot({path:'/tmp/elpis-maintenance-390.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 }finally{await browser.close();for(const client of clients)client.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('Smart Prune effort uses the selected model catalog, saves Max, reopens and clears to Default', async () => {
 const { fixture } = require('./parity-fixture.cjs');
 let settings = { version: 'v1', main: { model: 'gpt-6-luna', provider: 'openai' }, background: { model: 'cheap-model', provider: 'openai' },
  providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'local', displayName: 'Local' }],
  smartPrune: { enabled: true, explicitOverride: { available: true, version: 'p1', model: 'gpt-6-luna', provider: 'openai' } }, memory: {}, write: { available: true } };
 const writes = []; let reject = false;
 const app = await fixture({ routes: {
  '/api/settings': () => settings,
  '/api/pruner': body => {
   writes.push(body);
   if (reject) return { __http: 409, error: 'Settings changed elsewhere. Reload settings.' };
   settings = { ...settings, smartPrune: { ...settings.smartPrune, explicitOverride: { available: true, ...body, version: `p${writes.length + 1}` } } };
   return settings;
  },
 } });
 const { page } = app;
 const catalog = (model, displayName, efforts) => ({ id: model, model, displayName, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) });
 let releaseLocal;
 const localReady = new Promise(resolve => { releaseLocal = resolve; });
 await page.route('**/api/models*', async route => {
  const local = new URL(route.request().url()).searchParams.get('provider') === 'local';
  if (local) await localReady;
  await route.fulfill({ json: { data: local ? [catalog('gpt-6-luna', 'Local Luna', ['medium'])]
   : [catalog('gpt-6-luna', 'Luna', ['low', 'medium', 'high', 'max']), catalog('cheap-model', 'Cheap model', ['low', 'high']), catalog('no-efforts', 'No reasoning', [])] } });
 });
 const effort = page.getByLabel('Pruning effort', { exact: true });
 const save = page.getByRole('button', { name: 'Save pruning model', exact: true });
 const configuration = async () => { await openSettings(page); await page.getByRole('tab', { name: 'Configuration', exact: true }).click(); };
 const options = async values => {
  await effort.click();
  assert.deepEqual(await page.getByRole('option').evaluateAll(items => items.map(item => item.getAttribute('data-value'))), values);
  assert.equal(await page.getByRole('option', { name: 'Default (Low)', exact: true }).count(), 1);
  await page.keyboard.press('Escape');
 };
 const saved = async () => { await save.click(); await page.getByRole('status').filter({ hasText: 'Pruning model saved' }).waitFor(); };
 try {
  await page.reload(); await configuration();
  await effort.waitFor(); // Fails on the installed renderer: there is no effort control.
  assert.equal(await controlValue(effort), ''); assert.equal(await save.isDisabled(), true);
  await options(['', 'low', 'medium', 'high', 'max']);
  // First, middle and last supported choices all save independently of the model.
  for (const reasoningEffort of ['low', 'high', 'max']) {
   const version = settings.smartPrune.explicitOverride.version;
   await chooseOption(effort, reasoningEffort); await saved();
   assert.deepEqual(writes.at(-1), { version, model: 'gpt-6-luna', provider: 'openai', reasoningEffort });
   assert.equal(await controlValue(effort), reasoningEffort); assert.equal(await save.isDisabled(), true);
  }
  await configuration(); assert.equal(await controlValue(effort), 'max');
  await page.reload(); await configuration(); assert.equal(await controlValue(effort), 'max');
  await chooseOption(effort, ''); await saved();
  assert.equal(writes.at(-1).reasoningEffort, null);
  await page.reload(); await configuration(); assert.equal(await controlValue(effort), '');
  await chooseOption(effort, 'max'); await saved();
  await chooseOption(page.getByLabel('Pruning model', { exact: true }), 'cheap-model');
  assert.equal(await controlValue(effort), ''); await options(['', 'low', 'high']);
  await saved(); assert.equal(writes.at(-1).reasoningEffort, null);
  await chooseOption(effort, 'high'); reject = true; await save.click();
  await page.getByRole('alert').filter({ hasText: 'Settings changed elsewhere' }).waitFor();
  assert.equal(await controlValue(effort), 'high');
  reject = false; await page.getByRole('region', { name: 'Smart Prune', exact: true }).getByRole('button', { name: 'Reload settings', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Settings reloaded' }).waitFor();
  assert.equal(await controlValue(effort), '');
  await chooseOption(page.getByLabel('Pruning provider', { exact: true }), 'local');
  await page.getByText('Loading model choices…', { exact: true }).waitFor();
  await options(['']); releaseLocal();
  await page.getByText('Loading model choices…', { exact: true }).waitFor({ state: 'hidden' });
  await chooseOption(page.getByLabel('Pruning model', { exact: true }), 'gpt-6-luna');
  await options(['', 'medium']); await chooseOption(effort, 'medium'); await saved();
  assert.equal(writes.at(-1).provider, 'local'); assert.equal(writes.at(-1).reasoningEffort, 'medium');
  await chooseOption(page.getByLabel('Pruning model selection', { exact: true }), 'background');
  assert.equal(await controlValue(effort), ''); await options(['', 'low', 'high']);
  const version = settings.smartPrune.explicitOverride.version; await saved();
  assert.deepEqual(writes.at(-1), { version, model: null, provider: null, reasoningEffort: null });
  await chooseOption(page.getByLabel('Pruning model selection', { exact: true }), 'explicit');
  await chooseOption(page.getByLabel('Pruning provider', { exact: true }), 'openai');
  await chooseOption(page.getByLabel('Pruning model', { exact: true }), 'no-efforts'); await options(['']);
  assert.deepEqual(app.errors, []);
 } finally { await app.close(); }
});
