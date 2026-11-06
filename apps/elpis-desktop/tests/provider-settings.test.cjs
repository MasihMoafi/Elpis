const { chooseOption, controlValue, leaveSettings, sidebar, openSettings } = require('./controls.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require(process.env.ELPIS_PLAYWRIGHT_PACKAGE||'playwright');

test('provider setup preserves edits on conflict, refreshes choices and never redisplays stored secrets',async()=>{
 const clients=new Set(),writes=[];
 let conflict=true;
 let config={version:'v1',configPath:'/tmp/config.toml',write:{available:true},managed:{modelProvider:null},providers:[]};
 const subscription={state:'notConnected',models:[],usage:[]};
 const accounts={openai:{auth:{state:'signedOut'},usage:[],usageError:null},claude:subscription,gemini:subscription,openrouter:[],local:[]};
 const server=http.createServer(async(req,res)=>{
  const route=new URL(req.url,'http://local').pathname;
  const json=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  if(route==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: connection\ndata: {"connected":true}\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
  if(route==='/api/health')return json({connected:true});
  if(route==='/api/settings')return json({background:{},smartPrune:{explicitOverride:{}},memory:{},write:{available:false},main:{model:'native-model',provider:'openai'},providers:[{id:'openai',displayName:'OpenAI'},...config.providers.map(p=>({id:p.id,displayName:p.name}))]});
  if(route==='/api/models')return json({data:[{id:'native-model',model:'native-model',displayName:'Native model'}]});
  if(route==='/api/threads')return json({data:[],nextCursor:null});
  if(route==='/api/providers')return json(accounts);
  if(route==='/api/providers/settings'){
   if(req.method==='GET')return json(config);
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);writes.push(body);
   if(conflict){conflict=false;config={...config,version:'v2'};return json({error:'Configuration changed elsewhere. Review your edits.'},409);}
   if(body.version!==config.version)return json({error:'Stale configuration'},409);
   config={...config,version:`v${writes.length+1}`,providers:[{id:body.id,name:body.name,baseUrl:body.baseUrl,wireApi:'responses',editable:true,auth:{source:body.credential.action==='clear'?'none':'stored',keySet:body.credential.action!=='clear',envKey:null}}]};
   return json(config);
  }
  try{const file=path.join(__dirname,'../out',route==='/'?'index.html':route);res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({executablePath:process.env.ELPIS_CHROMIUM||undefined,headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(7000);
 try{
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await openSettings(page);
  // Settings opens on General, as in the ChatGPT app; connections live under Models & accounts.
  if(await page.getByRole('tab',{name:'Models & accounts',exact:true}).count())await page.getByRole('tab',{name:'Models & accounts',exact:true}).click();
  await page.getByText('Advanced API connections',{exact:true}).click();
  await page.getByRole('button',{name:'Add API provider',exact:true}).click();
  assert.equal(await page.getByLabel('Provider ID',{exact:true}).count(),0,'internal connection keys are generated for the user');
  await page.getByLabel('Provider display name',{exact:true}).fill('My API');
  await page.getByLabel('API endpoint',{exact:true}).fill('https://example.test/v1');
  await chooseOption(page.getByLabel('API key action',{exact:true}), 'replace');
  await page.getByLabel('Provider API key',{exact:true}).fill('fixture-only-secret');
  await page.getByRole('button',{name:'Save provider',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'changed elsewhere'}).waitFor();
  await accountsFirst(page);
  assert.equal(await controlValue(page.getByLabel('Provider API key',{exact:true})),'fixture-only-secret');
  assert.equal(await controlValue(page.getByLabel('Provider display name',{exact:true})),'My API');
  await page.getByRole('button',{name:'Save provider',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Saved for new conversations'}).waitFor();
  assert.equal(writes[1].version,'v2');assert.deepEqual(writes[1].credential,{action:'replace',value:'fixture-only-secret'});
  assert.equal(writes[1].id,'api-my-api');
  assert(!(await page.content()).includes('fixture-only-secret'));
  await (await sidebar(page)).getByRole('button',{name:'New chat',exact:true}).click();
  await page.getByLabel('Model',{exact:true}).click();
  await page.getByText('Advanced: use an unlisted model',{exact:true}).click();
  await chooseOption(page.getByLabel('Provider',{exact:true}), 'api-my-api');
  await page.getByLabel('Model ID',{exact:true}).fill('custom/native-model');
  await page.getByRole('button',{name:'Use model',exact:true}).click();
  assert.equal(await controlValue(page.getByLabel('Model',{exact:true})),'custom/native-model');
  await openSettings(page);
  await page.getByRole('tab',{name:'Models & accounts',exact:true}).click();
  await page.getByRole('button',{name:'Edit My API',exact:true}).click();
  assert.equal(await page.getByLabel('Provider API key',{exact:true}).count(),0);
  await chooseOption(page.getByLabel('API key action',{exact:true}), 'clear');
  await page.getByRole('button',{name:'Save provider',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Saved for new conversations'}).waitFor();
  assert.deepEqual(writes.at(-1).credential,{action:'clear'});assert.equal(config.providers[0].auth.keySet,false);
 }finally{await browser.close();for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));}
});

const { fixture } = require('./parity-fixture.cjs');
const { accountsFirst, openAccounts } = require('./providers-order.cjs');

const ROUTER_KEY = { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', wireApi: 'responses', editable: true, auth: { source: 'key', keySet: true, envKey: null } };
const OTHER_KEY = { id: 'api-other', name: 'Other API', baseUrl: 'https://example.test/v1', wireApi: 'responses', editable: true, auth: { source: 'key', keySet: true, envKey: null } };
const keyRoutes = ({ writable = true, speech = { source: 'local', model: null, voice: null }, failing = null } = {}) => {
 const off = { state: 'notConnected', models: [], usage: [] };
 const listed = item => ({ id: item.id, name: item.name, baseUrl: item.baseUrl, envKey: null, keySet: true });
 return {
  '/api/settings': () => ({ version: 'v1', main: { model: 'sol', provider: 'openai' }, background: {}, smartPrune: { explicitOverride: {} }, memory: {}, write: { available: writable }, managed: {}, providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'openrouter', displayName: 'OpenRouter' }, { id: 'api-other', displayName: 'Other API' }] }),
  '/api/providers': () => ({ openai: { auth: { state: 'signedOut' }, usage: [], usageError: null }, claude: off, gemini: off, openrouter: [listed(ROUTER_KEY)] }),
  '/api/providers/settings': () => ({ version: 'v1', write: { available: true }, managed: {}, providers: [ROUTER_KEY, OTHER_KEY] }),
  '/api/read-aloud/settings': body => failing === 'rejected' ? { __http: 503, error: 'Unavailable' } : failing === 'empty' ? {} : (body ? Object.assign(speech, body) : speech),
  '/api/mcp': () => failing === 'rejected' ? { __http: 503, error: 'Unavailable' } : failing === 'empty' ? {} : { version: 'v1', write: { available: true }, servers: [{ name: 'whispertype', whispertype: { backend: null, model: null } }] },
  '/api/models': (_, url) => url.searchParams.get('outputModality') === 'speech' ? { data: [{ model: 'fish/voice', displayName: 'Fish Audio' }] }
   : url.searchParams.get('outputModality') === 'transcription' ? { data: [{ model: 'openai/whisper', displayName: 'Whisper' }] }
   : { data: [{ id: 'sol', model: 'sol', displayName: 'Sol', isDefault: true }] },
 };
};

for (const response of ['rejected', 'empty']) test(`provider cards and key checkboxes stay visible when Use for routes are ${response}`, async () => {
 const app = await fixture({ routes: keyRoutes({ writable: false, failing: response }) });
 try {
  await openAccounts(app.page);
  const panel = app.page.getByRole('tabpanel', { name: 'Models & accounts', exact: true });
  const key = panel.getByRole('group', { name: 'Use OpenRouter for', exact: true });
  for (const name of ["Chat settings can't be saved here.", 'Read aloud settings unavailable.', 'Dictation settings unavailable.']) await key.getByText(name, { exact: true }).waitFor();
  for (const name of ['openai', 'claude', 'cloudroom', 'gemini', 'openrouter']) await panel.locator(`[data-provider="${name}"]`).waitFor();
  await panel.getByText('Advanced API connections', { exact: true }).waitFor();
  assert.deepEqual(app.errors, []);
 } finally { await app.close(); }
});

// Masih, 6 Nov: "optionally one key for everything; remember? we get to check and uncheck."
for (const colorScheme of ['light', 'dark']) test(`ticking Read aloud on the OpenRouter key routes read aloud there and unticking returns it to Kokoro (${colorScheme})`, async () => {
 const app = await fixture({ colorScheme, height: 900, routes: keyRoutes() });
 try {
  await openAccounts(app.page);
  const panel = app.page.getByRole('tabpanel', { name: 'Models & accounts', exact: true });
  const router = panel.getByRole('group', { name: 'Use OpenRouter for', exact: true });
  const other = panel.getByRole('group', { name: 'Use Other API for', exact: true });
  const box = (group, key, feature) => group.getByRole('checkbox', { name: `Use ${key} for ${feature}`, exact: true });
  await box(router, 'OpenRouter', 'Read aloud').waitFor();
  // Negative: what a key cannot do is disabled, with its reason beside it, and a click does nothing.
  for (const [group, key, feature] of [[other, 'Other API', 'Read aloud'], [other, 'Other API', 'Dictation'], [router, 'OpenRouter', 'Live voice']]) {
   assert.equal(await box(group, key, feature).getAttribute('aria-disabled') ?? await box(group, key, feature).getAttribute('data-disabled'), 'true');
   await box(group, key, feature).click({ force: true });
   assert.equal(await box(group, key, feature).getAttribute('aria-checked'), 'false');
  }
  await other.getByText('This provider has no speech models.', { exact: true }).waitFor();
  await router.getByText('Live voice runs only on the ChatGPT subscription.', { exact: true }).waitFor();
  // Positive: tick, choose the model beside it, save.
  assert.equal(await panel.getByRole('combobox', { name: 'Read aloud model for OpenRouter', exact: true }).count(), 0);
  await box(router, 'OpenRouter', 'Read aloud').click();
  const model = panel.getByRole('combobox', { name: 'Read aloud model for OpenRouter', exact: true });
  await chooseOption(model, 'fish/voice');
  await router.getByRole('button', { name: 'Save Read aloud for OpenRouter', exact: true }).click();
  await router.getByText('Read aloud now uses OpenRouter. Paid per use.', { exact: true }).waitFor();
  assert.deepEqual(app.posts.filter(item => item.path === '/api/read-aloud/settings').map(item => item.body), [{ source: 'openrouter', model: 'fish/voice', voice: null }]);
  assert.equal(await box(router, 'OpenRouter', 'Read aloud').getAttribute('aria-checked'), 'true');
  if (process.env.ELPIS_KEY_SCREENSHOTS) await router.locator('xpath=ancestor::section[@data-provider="openrouter"]').screenshot({ path: path.join(process.env.ELPIS_KEY_SCREENSHOTS, `key-checkboxes-${colorScheme}.png`) });
  // Unticking returns read aloud to its default.
  await box(router, 'OpenRouter', 'Read aloud').click();
  await router.getByText('Read aloud is back on local Kokoro.', { exact: true }).waitFor();
  assert.deepEqual(app.posts.filter(item => item.path === '/api/read-aloud/settings').map(item => item.body).at(-1), { source: 'local', model: null, voice: null });
  assert.equal(await box(router, 'OpenRouter', 'Read aloud').getAttribute('aria-checked'), 'false');
  assert.deepEqual(app.errors, []);
 } finally { await app.close(); }
});

for (const connected of [0, 3]) for (const colorScheme of ['light']) test(`accounts precede advanced APIs with ${connected} connected subscriptions in ${colorScheme}, including an open form and reload`, async () => {
 let config = { version: 'v1', write: { available: true }, managed: { modelProvider: null }, providers: [] };
 const subscription = state => ({ state, models: state === 'connected' ? ['Subscription model'] : [], usage: [] });
 const accounts = { openai: { auth: connected ? { state: 'signedIn', email: 'account-with-a-long-name@example.test', plan: 'Plus' } : { state: 'signedOut' }, usage: [], usageError: null },
  claude: subscription(connected === 3 ? 'connected' : 'notConnected'), gemini: subscription(connected === 3 ? 'connected' : 'notConnected'), openrouter: [] };
 let reportAccounts;
 const reported = connected === 0 && colorScheme === 'light' ? new Promise(resolve => { reportAccounts = () => resolve(accounts); }) : accounts;
 const app = await fixture({ colorScheme, storage: { 'elpis-theme': colorScheme }, routes: {
  '/api/settings': () => ({ main: { model: 'sol', provider: 'openai' }, background: {}, smartPrune: { explicitOverride: {} }, memory: {}, write: { available: false }, providers: [] }),
  '/api/providers': () => reported,
  '/api/providers/claude-accounts': () => ({ activeId: 'default', accounts: [{ id: 'default', label: 'Claude 1', email: null, authenticated: connected === 3 }] }),
  '/api/providers/settings': body => {
   if (body) config = { ...config, version: 'v2', providers: [{ id: body.id, name: body.name, baseUrl: body.baseUrl, editable: true, auth: { source: 'none', keySet: false, envKey: null } }] };
   return config;
  },
 } });
 const { page } = app;
 try {
  await openAccounts(page);
  if (reportAccounts) {
   await page.getByText('Reading providers…', { exact: true }).waitFor();
   assert.equal(await page.locator('.provider-advanced').getAttribute('open'), null, 'collapsed while accounts load');
   reportAccounts();
  }
  const panel = await accountsFirst(page);
  const advanced = panel.locator('.provider-advanced');
  assert.equal(await advanced.getAttribute('open'), null, 'advanced APIs start collapsed');
  assert.equal(await panel.getByRole('form', { name: 'API provider settings' }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: 'Add API provider', exact: true }).isVisible(), false);
  await fs.mkdir('/tmp/a96-shots', { recursive: true });
  for (const width of [1440, 600]) {
   await page.setViewportSize({ width, height: 1000 });
   await panel.locator('[data-provider="openai"]').scrollIntoViewIfNeeded();
   await page.screenshot({ path: `/tmp/a96-shots/renderer-${connected}-${colorScheme}-${width}-collapsed.png` });
   const summary = advanced.locator('summary');
   await summary.scrollIntoViewIfNeeded(); await summary.focus(); await page.keyboard.press('Enter');
   await panel.getByRole('button', { name: 'Add API provider', exact: true }).click();
   await panel.getByLabel('Provider display name', { exact: true }).fill(`Order check ${width}`);
   await panel.getByLabel('API endpoint', { exact: true }).fill('http://127.0.0.1:1234/v1');
   await accountsFirst(page);
   await page.getByRole('form', { name: 'API provider settings' }).screenshot({ path: `/tmp/a96-shots/renderer-${connected}-${colorScheme}-${width}-form.png` });
   await panel.getByRole('button', { name: 'Save provider', exact: true }).click();
   await panel.getByRole('status').filter({ hasText: 'Saved for new conversations' }).waitFor();
   assert.equal(app.posts.filter(post => post.path === '/api/providers/settings').at(-1).body.name, `Order check ${width}`);
   await page.reload(); await openAccounts(page);
   await accountsFirst(page);
   assert.equal(await advanced.getAttribute('open'), null, 'reload restores the collapsed default');
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  assert.deepEqual(app.errors, []);
 } finally { reportAccounts?.(); await app.close(); }
});
