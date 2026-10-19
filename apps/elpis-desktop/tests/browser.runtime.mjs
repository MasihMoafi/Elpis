// The in-app browser end to end in the real desktop app: Electron main + preload + renderer + the native page view.
// Runs on a private Xvfb display with a throwaway profile and engine. Inference uses
// a local scripted provider only. Screenshots of the whole window go to the evidence folder.
//   node tests/browser.runtime.mjs /absolute/elpis-next [--shots DIR]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existingSocket } from '../bridge/client.mjs';
const require = createRequire(import.meta.url);
const { Provider, message: modelMessage, call: modelCall } = require('../../../scripts/lib/mock-provider.js');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const binary = process.argv[2];
const approvalEval = process.argv.includes('--approvals') || process.argv.includes('--only-approvals');
const sessionsOnly = process.argv.includes('--only-sessions');
assert(binary && path.isAbsolute(binary), 'Give the absolute path of an Elpis executable');
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const shots = process.argv.includes('--shots') ? path.resolve(process.argv[process.argv.indexOf('--shots') + 1]) : await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-browser-shots-'));
await fs.mkdir(shots, { recursive: true });
const profiles = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(profiles, { recursive: true });
const root = await fs.mkdtemp(path.join(profiles, 'elpis-browser-profile-'));
const home = path.join(root, 'home'), config = path.join(root, 'config'); for (const dir of [home, config]) await fs.mkdir(dir);
const provider = new Provider();
if (approvalEval) {
await provider.start();
const catalog = require('../../../codex-rs/models-manager/models.json');
await fs.writeFile(path.join(home, 'models.json'), JSON.stringify({models:catalog.models.filter(model=>model.slug==='gpt-5.5')}));
await fs.writeFile(path.join(home, 'hooks.json'), '{}');
await fs.writeFile(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home,'models.json'))}\napproval_policy="on-request"\nsandbox_mode="workspace-write"\n[features]\ncode_mode=false\n[model_providers.fixture]\nname="Local browser fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(root)}]\ntrust_level="trusted"\n`);
}
let display;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) { try { const value = await check(); if (value) return value; } catch (error) { if (Date.now() > deadline) throw error; } if (Date.now() > deadline) throw Error(`Timed out: ${label}`); await wait(100); }
}
let windowBox = { x: 0, y: 0, width: 1320, height: 900 };
const grab = name => { const file = path.join(shots, `${name}.png`), { x, y, width, height } = windowBox; execFileSync('python3', ['-c', `from PIL import ImageGrab;ImageGrab.grab(xdisplay=${JSON.stringify(display)}).crop((${x},${y},${x + width},${y + height})).save(${JSON.stringify(file)})`]); console.log(`shot ${file}`); };
// Real X key presses (CDP keys bypass Electron's before-input-event, where the browser's shortcuts live).
const xkey = (...names) => execFileSync('python3', ['-c', `from Xlib import display, X, XK;from Xlib.ext import xtest;d=display.Display(${JSON.stringify(display)});ks=[d.keysym_to_keycode(XK.string_to_keysym(n)) for n in ${JSON.stringify(names)}]
for k in ks: xtest.fake_input(d,X.KeyPress,k)
for k in reversed(ks): xtest.fake_input(d,X.KeyRelease,k)
d.sync()`]);

// A local "development server" with a login form, as Masih's own apps are.
const site = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>Fixture login</title><style>body{margin:0;font:16px system-ui,sans-serif;background:#f6f7fb;color:#1d2433}header{padding:18px 40px;background:#1d2433;color:#fff;font-weight:600}main{max-width:460px;margin:40px auto;background:#fff;border-radius:12px;padding:28px 32px;box-shadow:0 2px 12px #0001}h1{margin:0 0 18px;font-size:24px}label{display:block;margin:12px 0 4px;font-size:14px}input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #c8cdd8;border-radius:6px}button{margin-top:20px;padding:10px 18px;border:0;border-radius:6px;background:#6b4fd8;color:#fff;font-size:15px}p{color:#5b6475;font-size:14px}</style>
<header>Fixture app</header><main><h1>Welcome back</h1><form id="login"><label>Email <input name="email" placeholder="you@example.com"></label><label>Password <input name="password" type="password"></label>
<button class="primary" type="button">Sign in</button></form><p id="note">Forgot your password? Reset it from the account page. The cache keeps one session per device.</p></main>
<script>if(location.pathname==='/scroll')document.body.style.minHeight='2400px';document.querySelector('button.primary').onclick=()=>{document.querySelector('#note').textContent='Signed in as '+document.querySelector('[name=email]').value;console.log('fixture sign-in clicked');};</script>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}/login`;

const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x960x24', '-nolisten', 'tcp'], { stdio: ['ignore','ignore','ignore','pipe'] });
display=await new Promise((resolve,reject)=>{xvfb.once('error',reject);xvfb.once('exit',code=>reject(Error(`Xvfb exited (${code})`)));let value='';xvfb.stdio[3].on('data',chunk=>{value+=chunk;if(value.includes('\n'))resolve(`:${value.trim()}`);});});
const socket = path.join(root, 'runtime.sock');
const runtime = spawn(binary, [...(path.basename(binary).includes('app-server') ? [] : ['app-server']), '--listen', `unix://${socket}`], { cwd: root, env: { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, LANG: 'C.UTF-8' }, stdio: 'ignore' });
let desktop, engineSocket, failed = false;
const results = [];
async function check(name, run) {
  try { await run(); results.push(name); console.log(`PASS ${name}`); }
  catch (error) { failed = true; console.log(`FAIL ${name}: ${String(error.message).split('\n')[0]}`); if(provider.error)console.log(`Mock failure: ${provider.error.stack}`);await fs.writeFile(path.join(shots,'mock-requests.json'),JSON.stringify(provider.requests,null,2));try { grab(`failed-${results.length}`); } catch {} }
}
try {
  await until(() => fs.stat(socket).then(() => true), 'engine socket');
  // The engine links the given path to its socket; the app connects to the private socket itself.
  await fs.chmod(socket, 0o600); const bridge = await fs.realpath(socket); existingSocket(bridge);
  const launchDesktop = () => _electron.launch({ executablePath: path.join(appRoot, 'node_modules/electron/dist/electron'), args: [appRoot, '--disable-gpu', '--ozone-platform=x11'], cwd: appRoot,
    env: { PATH: process.env.PATH, DISPLAY: display, HOME: home, XDG_CONFIG_HOME: config, TMPDIR: root, ELPIS_NODE_BIN: process.execPath, ELPIS_APP_BRIDGE_SOCKET: bridge, ELPIS_HOME: home, LANG: 'C.UTF-8' } });
  desktop = await launchDesktop();
  let app = await desktop.firstWindow();
  windowBox = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
  const focusPage = url => desktop.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(item => item.getURL().startsWith(url))?.focus(), url);
  app.setDefaultTimeout(8000);
  await app.getByRole('textbox', { name: 'Message Elpis', exact: true }).waitFor();
  await until(()=>app.evaluate(async()=>(await fetch('/api/health')).ok),'private app session');
  await app.locator('.startup-splash').waitFor({state:'detached',timeout:10000});
  const pageView = async url => until(() => desktop.context().pages().find(page => page !== app && page.url().startsWith(url)), `page ${url}`);

  // Exercise the engine's registered MCP connection, not a renderer/Playwright click substitute.
  const WebSocket=require('ws'),pending=new Map();let rpcId=0;
  engineSocket=new WebSocket(`ws+unix://${bridge}:/`);
  await new Promise((resolve,reject)=>{engineSocket.once('open',resolve);engineSocket.once('error',reject);});
  engineSocket.on('message',raw=>{const message=JSON.parse(raw);const handler=pending.get(message.id);if(handler){pending.delete(message.id);message.error?handler.reject(Error(message.error.message)):handler.resolve(message.result);}});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++rpcId,timer=setTimeout(()=>{pending.delete(id);reject(Error(`Timed out: ${method}`));},35000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});engineSocket.send(JSON.stringify({id,method,params}));});
  await rpc('initialize',{clientInfo:{name:'browser-runtime-test',version:'1.0.0'},capabilities:{experimentalApi:true}});
  engineSocket.send(JSON.stringify({method:'initialized',params:{}}));
  let toolCall,agentTab,browserFixtureThread;
  await check('engine discovers the desktop browser MCP without model calls',async()=>{
    const created=await app.evaluate(async()=>{const response=await fetch('/api/threads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Browser tool fixture',permissions:'ask'})});const value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value;});
    browserFixtureThread=created.thread;
    const threadId=created.thread.id;
    const listed=await rpc('mcpServerStatus/list',{threadId,serverName:'elpis_browser'});
    const browser=listed.data.find(server=>server.name==='elpis_browser');
    assert(browser,'registered browser server');assert.equal(Object.keys(browser.tools).length,11);
    toolCall=async(name,args={})=>{const value=await rpc('mcpServer/tool/call',{threadId,server:'elpis_browser',tool:name,arguments:args});if(value.isError)throw Error(value.content[0].text);return value.content[0].type==='image'?value:JSON.parse(value.content[0].text);};
    const target=new URL(app.url());target.searchParams.set('session',threadId);await app.goto(target.href);
    await app.getByRole('textbox',{name:'Message Elpis',exact:true}).waitFor();
  });
  if (sessionsOnly) await check('two actual engine MCP processes retain separate browsers during concurrent calls and switching', async () => {
    const second = await app.evaluate(async () => {
      const response = await fetch('/api/threads', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:'Second browser session',permissions:'full'}) });
      return (await response.json()).thread;
    });
    const other = async (name,args={}) => { const result=await rpc('mcpServer/tool/call',{threadId:second.id,server:'elpis_browser',tool:name,arguments:args});if(result.isError)throw Error(result.content[0].text);return result.content[0].type==='image'?result:JSON.parse(result.content[0].text); };
    const [a,b]=await Promise.all([toolCall('browser_open',{url:new URL('/session-a',siteUrl).href}),other('browser_open',{url:new URL('/session-b',siteUrl).href})]);
    await Promise.all([toolCall('browser_wait',{tabId:a.tabId}),other('browser_wait',{tabId:b.tabId})]);
    const [sa,sb]=await Promise.all([toolCall('browser_snapshot',{tabId:a.tabId}),other('browser_snapshot',{tabId:b.tabId})]);
    assert.equal(new URL(sa.url).pathname,'/session-a');assert.equal(new URL(sb.url).pathname,'/session-b');
    assert.ok(sb.viewport.width>0&&sb.viewport.height>0,'a never-shown engine session has a viewport');
    await other('browser_type',{tabId:b.tabId,selector:'[name=email]',text:'hidden-session-b@example.invalid'});
    await other('browser_click',{tabId:b.tabId,selector:'button.primary'});
    assert.match((await other('browser_snapshot',{tabId:b.tabId})).text,/Signed in as hidden-session-b@example.invalid/);
    assert.equal((await other('browser_screenshot',{tabId:b.tabId})).content[0].type,'image');
    await assert.rejects(toolCall('browser_snapshot',{tabId:b.tabId}),/closed/);
    assert.deepEqual((await toolCall('browser_tabs')).tabs.map(tab=>tab.id),[a.tabId]);
    assert.deepEqual((await other('browser_tabs')).tabs.map(tab=>tab.id),[b.tabId]);
    const forged = await rpc('mcpServer/tool/call',{threadId:browserFixtureThread.id,server:'elpis_browser',tool:'browser_tabs',arguments:{},meta:{threadId:second.id}});
    assert.deepEqual(JSON.parse(forged.content[0].text).tabs.map(tab=>tab.id),[a.tabId],'the engine overwrites a forged host session');
    await app.getByRole('textbox',{name:'Search or enter a URL'}).waitFor();
    assert.match(await app.getByRole('textbox',{name:'Search or enter a URL'}).inputValue(),/\/session-a$/);
    const target=new URL(app.url());target.searchParams.set('session',second.id);await app.goto(target.href);
    await until(async()=>/\/session-b$/.test(await app.getByRole('textbox',{name:'Search or enter a URL'}).inputValue()),'second session address');
  });
  if (sessionsOnly) await check('an inherited MCP capability still uses the calling engine thread, never its parent pages', async () => {
    const profile=await desktop.evaluate(({app})=>app.getPath('userData'));
    const connectionFile=path.join(profile,'browser-connection.json'), connection=JSON.parse(await fs.readFile(connectionFile,'utf8'));
    const capability=Object.keys(connection.scopes).find(token=>connection.scopes[token]===browserFixtureThread.id);
    const { browserMcpConfig }=await import('../bridge/browser-mcp.mjs');
    const child=(await rpc('thread/start',{cwd:root,config:browserMcpConfig(connection.socketPath,process.execPath,capability,connectionFile)})).thread;
    const inherited=async(name,args={})=>{const value=await rpc('mcpServer/tool/call',{threadId:child.id,server:'elpis_browser',tool:name,arguments:args});if(value.isError)throw Error(value.content[0].text);return JSON.parse(value.content[0].text);};
    assert.deepEqual((await inherited('browser_tabs')).tabs,[]);
    const tab=await inherited('browser_open',{url:new URL('/child-session',siteUrl).href});await inherited('browser_wait',{tabId:tab.tabId});
    assert.match((await inherited('browser_snapshot',{tabId:tab.tabId})).url,/\/child-session$/);
    assert.equal((await toolCall('browser_tabs')).tabs.length,1);
    await assert.rejects(toolCall('browser_snapshot',{tabId:tab.tabId}),/closed/);
  });
  if (sessionsOnly) await check('desktop restart restores pages and reconnects the browser tools of still-loaded engine sessions', async () => {
    await rpc('thread/resume',{threadId:browserFixtureThread.id,excludeTurns:true});
    await desktop.close(); desktop = await launchDesktop(); app = await desktop.firstWindow(); app.setDefaultTimeout(8000);
    await app.getByRole('textbox',{name:'Message Elpis',exact:true}).waitFor();
    const target=new URL(app.url());target.searchParams.set('session',browserFixtureThread.id);await app.goto(target.href);
    await until(async()=>/\/session-a$/.test(await app.getByRole('textbox',{name:'Search or enter a URL'}).inputValue()),'restored first session address');
    const listed=await toolCall('browser_tabs');assert.equal(listed.tabs.length,1);assert.match(listed.tabs[0].url,/\/session-a$/);
    const snapshot=await toolCall('browser_snapshot',{tabId:listed.tabs[0].id});assert.match(snapshot.url,/\/session-a$/);
  });
  if (approvalEval) await check('Ask browser call succeeds through the card; session approval avoids repeated prompts',async()=>{
    provider.actions.push({type:'tool_search_call',call_id:'discover_browser',execution:'client',arguments:{query:'elpis_browser browser_open',limit:1}});
    const openTool=request=>{
      const exposed=[...request.tools,...request.input.filter(item=>item.type==='tool_search_output').flatMap(item=>item.tools??[])];
      const tools=exposed.flatMap(tool=>tool.type==='namespace'?tool.tools.map(child=>({...child,namespace:tool.name})):[tool]);
      const tool=tools.find(tool=>tool.name==='mcp__elpis_browser__browser_open'||tool.name==='browser_open');assert(tool,'browser tool advertised to the mock model');
      return {...modelCall(`browser_${provider.requests.length}`,tool.name,{url:siteUrl}),...(tool.namespace?{namespace:tool.namespace}:{})};
    };
    for(const marker of ['BROWSER_APPROVED_FIXTURE','BROWSER_SESSION_FIXTURE']){
      provider.actions.push(openTool,request=>{assert.match(JSON.stringify(request.input),/tabId/,'actual browser result reaches inference');return modelMessage(marker);});
    }
    await app.evaluate(id=>window.elpisDesktop.storage.setItem('elpis-last-chat',id),browserFixtureThread.id);
    await app.reload();await app.getByRole('textbox',{name:'Message Elpis',exact:true}).waitFor();
    await app.getByRole('textbox',{name:'Message Elpis',exact:true}).fill('Open the local browser fixture.');await app.getByRole('textbox',{name:'Message Elpis',exact:true}).press('Enter');
    const allow=app.getByRole('button',{name:'Allow for this session',exact:true});await allow.waitFor({timeout:20000});await app.screenshot({path:path.join(shots,'ask-browser-approval.png')});await allow.click();
    await pageView(siteUrl);await app.locator('aside').getByRole('button',{name:'Browser tool fixture',exact:true}).click();await app.getByText('BROWSER_APPROVED_FIXTURE',{exact:true}).waitFor({timeout:20000});
    let repeated=0;
    const observer=await app.evaluateHandle(()=>{const state={count:0};const observer=new MutationObserver(()=>{if(document.querySelector('.approval'))state.count++;});observer.observe(document.body,{childList:true,subtree:true});return {state,observer};});
    await app.getByRole('textbox',{name:'Message Elpis',exact:true}).fill('Open the fixture again in this chat.');await app.getByRole('textbox',{name:'Message Elpis',exact:true}).press('Enter');
    await until(()=>provider.requests.length===5,'second browser result');await app.locator('aside').getByRole('button',{name:'Browser tool fixture',exact:true}).click();await app.getByText('BROWSER_SESSION_FIXTURE',{exact:true}).waitFor({timeout:20000});repeated=await observer.evaluate(value=>{value.observer.disconnect();return value.state.count;});await observer.dispose();assert.equal(repeated,0,'session grant must not ask again');assert.equal(provider.requests.length,5);assert.equal(provider.error,undefined);
  });
  if (!process.argv.includes('--only-approvals') && !sessionsOnly) {
  await check('agent tools open, snapshot, fill and click the visible fixture; screenshot is an MCP image',async()=>{
    agentTab=(await toolCall('browser_open',{url:siteUrl})).tabId;
    await toolCall('browser_wait',{tabId:agentTab,selector:'[name=email]'});
    await app.getByText('Agent is using this tab',{exact:true}).waitFor();
    const snapshot=await toolCall('browser_snapshot',{tabId:agentTab});
    const email=snapshot.nodes.find(node=>node.name==='Email');assert(email,'DOM node for Email');
    await toolCall('browser_type',{tabId:agentTab,nodeId:email.nodeId,text:'agent@example.com'});
    await toolCall('browser_press',{tabId:agentTab,key:'Tab'});
    await toolCall('browser_type',{tabId:agentTab,selector:'[name=password]',text:'fixture-only'});
    await toolCall('browser_click',{tabId:agentTab,selector:'button.primary'});
    await until(async()=>/Signed in as agent@example.com/.test((await toolCall('browser_snapshot',{tabId:agentTab})).text),'tool-driven click result');
    assert((await toolCall('browser_console',{tabId:agentTab})).messages.some(entry=>entry.message==='fixture sign-in clicked'));
    const screenshot=await toolCall('browser_screenshot',{tabId:agentTab});
    assert.equal(screenshot.content[0].type,'image');assert.equal(screenshot.content[0].mimeType,'image/jpeg');
    const bytes=Buffer.from(screenshot.content[0].data,'base64');assert(bytes.length>1000);
    await fs.writeFile(path.join(shots,'agent-browser.jpg'),bytes);
    await app.screenshot({path:path.join(shots,'agent-control-light.png')});
    await app.evaluate(()=>document.documentElement.classList.add('dark'));
    await app.screenshot({path:path.join(shots,'agent-control-dark.png')});
    await wait(200);grab('elpis-real-agent-control-dark');
    await app.evaluate(()=>document.documentElement.classList.remove('dark'));
    await wait(200);grab('elpis-real-agent-control');
  });
  await check('takeover blocks agent input and policy blocks files and Elpis UI',async()=>{
    await app.getByRole('button',{name:'Take over',exact:true}).click();
    await assert.rejects(toolCall('browser_click',{tabId:agentTab,selector:'button.primary'}),/taken over/);
    await assert.rejects(toolCall('browser_open',{url:siteUrl}),/taken over/);
    grab('elpis-real-agent-takeover');
    await app.getByRole('button',{name:'Allow agent control',exact:true}).click();
    for(const url of ['file:///etc/passwd',app.url().split('/#')[0]])await assert.rejects(toolCall('browser_open',{url}),/HTTP or HTTPS/);
  });

  await check('agent navigation, history, reload, scrolling and coordinates operate on the page',async()=>{
    try {
    const scrollUrl=new URL('/scroll',siteUrl).href;
    await toolCall('browser_navigate',{tabId:agentTab,url:scrollUrl});
    await toolCall('browser_wait',{tabId:agentTab});
    await toolCall('browser_scroll',{tabId:agentTab,x:100,y:100,deltaY:400});
    await until(async()=>(await toolCall('browser_snapshot',{tabId:agentTab})).viewport.scrollY>0,'page scroll');
    await toolCall('browser_press',{tabId:agentTab,key:'Control+Home'});
    await until(async()=>(await toolCall('browser_snapshot',{tabId:agentTab})).viewport.scrollY===0,'native Home key');
    const snapshot=await toolCall('browser_snapshot',{tabId:agentTab}),button=snapshot.nodes.find(node=>node.name==='Sign in');
    await toolCall('browser_click',{tabId:agentTab,x:button.rect.x+button.rect.width/2,y:button.rect.y+button.rect.height/2});
    await until(async()=>/Signed in as/.test((await toolCall('browser_snapshot',{tabId:agentTab})).text),'coordinate click');
    for(const action of ['back','forward','reload']){
      await toolCall('browser_navigate',{tabId:agentTab,action});await toolCall('browser_wait',{tabId:agentTab});
      const expected=action==='back'?'/login':'/scroll';
      await until(async()=>new URL((await toolCall('browser_snapshot',{tabId:agentTab})).url).pathname===expected,`${action} URL`);
    }
    } finally {await app.evaluate(id=>window.elpisDesktop.browser.command('close',{id}),agentTab);}
  });

  await check('open a local page from the side panel’s + menu and the address bar', async () => {
    const show = app.getByRole('button', { name: 'Show side panel', exact: true }); // the agent's earlier page may have opened it
    if (await show.count()) await show.click();
    await app.getByRole('button', { name: 'New side panel tab', exact: true }).click();
    await app.getByRole('menuitem', { name: 'Browser tab', exact: true }).click();
    const address = app.getByRole('textbox', { name: 'Search or enter a URL' });
    await address.fill(siteUrl.replace('http://', '')); await address.press('Enter');
    const page = await pageView(siteUrl); await page.waitForLoadState('domcontentloaded');
    await app.getByRole('tab', { name: 'Fixture login' }).waitFor();
  });
  const page = await pageView(siteUrl);
  const center = async selector => { const box = await page.locator(selector).boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };

  await check('annotate an element: outline, number, editor in Elpis, comment saved', async () => {
    await app.getByRole('button', { name: 'Annotate this page' }).click();
    await app.getByText('Click anything on the page to comment on it').waitFor();
    const button = await center('button.primary');
    await page.mouse.move(button.x - 30, button.y); await page.mouse.move(button.x, button.y, { steps: 3 });
    await wait(200); grab('elpis-real-annotate-hover');
    await page.mouse.click(button.x, button.y);
    const comment = app.getByRole('textbox', { name: 'Comment', exact: true });
    await comment.waitFor();
    assert.match(await app.locator('.annotation-target').innerText(), /button “Sign in”/);
    await until(() => comment.evaluate(element => element === document.activeElement), 'the comment has the cursor');
    await comment.pressSequentially('Make this button the accent colour and full width');
    grab('elpis-real-annotate-editor');
    await comment.press('Enter');
    await app.getByRole('button', { name: 'Edit comment 1: button “Sign in”' }).waitFor();
  });

  await check('drag an area and comment on it; markers stay on the page', async () => {
    const box = await page.locator('#note').boundingBox();
    await page.mouse.move(box.x - 8, box.y - 8); await page.mouse.down(); await page.mouse.move(box.x + box.width + 8, box.y + box.height + 8, { steps: 6 }); await page.mouse.up();
    const comment = app.getByRole('textbox', { name: 'Comment', exact: true });
    await until(async () => /Area 2/.test(await app.locator('.annotation-target').innerText()), 'area draft');
    await wait(300); grab('elpis-real-annotate-area');
    await comment.fill('Too much text here; shorten it'); await comment.press('Enter');
    await app.getByRole('button', { name: 'Send 2 pending annotations' }).waitFor();
    await wait(300); grab('elpis-real-annotate-pending');
  });

  await check('Add to message: the composer receives the comments and one screenshot sheet', async () => {
    await app.getByRole('button', { name: 'Add to message' }).click();
    const files = app.locator('.composer').getByRole('list', { name: 'Message attachments', exact: true });
    await files.getByRole('button', { name: 'Remove Browser comments', exact: true }).waitFor();
    await files.getByRole('button', { name: 'Remove Browser comments.jpg', exact: true }).waitFor();
    // A new chat's composer files are kept under the "new" draft key in the app's own storage.
    const parts = JSON.parse(await app.evaluate(() => window.elpisDesktop.storage.getItem('elpis-attachments-v1:new') ?? '[]'));
    const text = parts.find(part => part.type === 'text'), image = parts.find(part => part.type === 'image');
    assert.ok(image?.dataUrl?.startsWith('data:image/jpeg;base64,'), 'a JPEG sheet is attached');
    await fs.writeFile(path.join(shots, 'browser-comments.jpg'), Buffer.from(image.dataUrl.split(',')[1], 'base64'));
    assert.ok(text, 'the comments are attached as text');
    {
      await fs.writeFile(path.join(shots, 'browser-comments.txt'), text.text);
      assert.match(text.text, /^# Browser comments:\n\n## User Comment 1\nBrowser\n/);
      assert.match(text.text, new RegExp(`Page URL: ${siteUrl.replace(/[.?]/g, '\\$&')}\\n`));
      assert.match(text.text, /Target: "Sign in"\nTarget role: "button"\nTarget selector: #login > button\.primary\n/);
      assert.match(text.text, /## User Comment 2\n[\s\S]*Area rectangle: /);
    }
    grab('elpis-real-composer');
  });

  await check('page menu: right-click shows the browser items', async () => {
    await app.getByRole('tab', { name: 'Fixture login' }).click();
    const note = await center('h1');
    await page.mouse.click(note.x, note.y, { button: 'right' });
    await wait(500); grab('elpis-real-page-menu');
    xkey('Escape');
  });

  await check('find in page with Ctrl+F counts real matches', async () => {
    await focusPage(siteUrl); xkey('Control_L', 'f');
    const find = app.getByRole('textbox', { name: 'Find in page' });
    await until(() => find.evaluate(element => element === document.activeElement), 'find bar focus');
    await find.pressSequentially('the');
    await until(async () => /of [1-9]/.test(await app.locator('.browser-find-count').innerText()), 'match count');
    grab('elpis-real-find');
    await find.press('Escape');
  });

  await check('zoom with Ctrl+= on the page shows the zoom badge, which resets', async () => {
    await focusPage(siteUrl); xkey('Control_L', 'equal');
    const badge = app.getByRole('button', { name: '110%' });
    await badge.waitFor(); grab('elpis-real-zoom'); await badge.click();
    await until(async () => await badge.count() === 0, 'zoom reset');
  });

  await check('a stopped development server gets an explanation and Reload', async () => {
    const address = app.getByRole('textbox', { name: 'Search or enter a URL' });
    await address.fill('127.0.0.1:9/'); await address.press('Enter');
    await app.getByRole('heading', { name: "This site can't be reached" }).waitFor();
    assert.match(await app.locator('.browser-failure').innerText(), /refused to connect|could not be loaded/);
    grab('elpis-real-failure');
  });
  await check('native Copy reply writes exact text; clipboard reads and website writes stay denied', async () => {
    const address = app.getByRole('textbox', { name: 'Search or enter a URL' });
    await address.fill(siteUrl); await address.press('Enter'); await page.waitForURL(siteUrl);
    await focusPage(siteUrl);
    await assert.rejects(() => page.evaluate(() => navigator.clipboard.writeText('WEBSITE_MUST_NOT_COPY')), /denied|permission|NotAllowed/i);
    const text = 'ELPIS_NATIVE_CLIPBOARD_SENTINEL_1701';
    const thread = browserFixtureThread;
    assert(thread?.id, 'the earlier engine/browser fixture created a real local thread');
    await app.route(`**/api/threads/${thread.id}**`, route => route.fulfill({ json: route.request().url().endsWith('/context') ? { tokenUsage: null } : { thread, activeTurnId: null, data: [{ turnId: 'clipboard-turn', item: { id: 'clipboard-reply', type: 'agentMessage', text } }], nextCursor: null } }));
    await app.evaluate(id => window.elpisDesktop.storage.setItem('elpis-last-chat', id), thread.id);
    await app.reload(); await app.getByText(text, { exact: true }).waitFor();
    await app.locator('.startup-splash').waitFor({ state: 'detached' });
    // The native copy button, not a mocked navigator.clipboard or granted browser permission.
    await app.getByRole('button', { name: 'Copy reply', exact: true }).click();
    await app.getByRole('status').filter({ hasText: 'Copied' }).waitFor();
    assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), text);
    await assert.rejects(() => app.evaluate(() => navigator.clipboard.readText()), /denied|permission|NotAllowed/i);
    grab('elpis-real-copy');
  });
  }
} finally {
  engineSocket?.close();
  await desktop?.close().catch(() => {});
  runtime.kill(); xvfb.kill(); site.close();
  if (approvalEval) provider.close();
}
console.log(`${results.length} passed${failed ? ', some failed' : ''}; shots in ${shots}; throwaway profile in ${root}`);
process.exit(failed ? 1 : 0);
