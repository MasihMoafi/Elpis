const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const { createBrowserAgent, startBrowserAgentSocket } = require('./browser-agent.cjs');

function fixture() {
  const tabs = new Map(), inputs = [], scripts = []; let selected, count = 0;
  const open = url => {
    const id = `tab-${++count}`;
    const wc = Object.assign(new EventEmitter(), { getURL: () => url, isDestroyed: () => false, isLoading: () => false,
      navigationHistory: { canGoBack: () => true, canGoForward: () => true, goBack: () => inputs.push('back'), goForward: () => inputs.push('forward') },
      loadURL: async value => { url = value; }, reload: () => inputs.push('reload'), stop() {}, focus() {},
      getZoomFactor: () => 1, sendInputEvent: event => inputs.push(event), insertText: async text => inputs.push(text),
      executeJavaScriptInIsolatedWorld: async (world, source) => { scripts.push({world, source}); return { x: 10, y: 20 }; },
      capturePage: async () => ({ isEmpty: () => false, toJPEG: () => Buffer.from('jpeg') }) });
    tabs.set(id, { id, url, title: 'Fixture', view: { webContents: wc } }); return id;
  };
  const agent = createBrowserAgent({ tabs, open, select: id => { selected = id; }, origin: 'http://127.0.0.1:4000', emit() {}, prepare() {} });
  return { agent, tabs, inputs, scripts, selected: () => selected };
}

test('open/list/select use visible browser tabs and mark agent control', async () => {
  const f = fixture(), result = await f.agent.call('browser_open', { url: 'https://example.com' });
  assert.equal(result.tabId, 'tab-1'); assert.equal(f.selected(), 'tab-1');
  assert.equal(f.agent.state().tabId, 'tab-1');
  assert.equal((await f.agent.call('browser_tabs', {})).tabs[0].id, 'tab-1');
});

test('policy rejects files, credentials and Elpis before creating or navigating a tab', async () => {
  const f = fixture();
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://127.0.0.1:4000/settings', 'https://user:pass@example.com']) {
    await assert.rejects(f.agent.call('browser_open', { url }));
  }
  assert.equal(f.tabs.size, 0);
  await f.agent.call('browser_open', {url:'https://example.com'});
  await assert.rejects(f.agent.call('browser_navigate', {tabId:'tab-1',url:'file:///etc/passwd'}));
  await assert.rejects(f.agent.call('browser_snapshot', {tabId:'renderer-webcontents'}));
});

test('click/type/press dispatch native input; scroll and target lookup use the isolated page', async () => {
  const f = fixture(); await f.agent.call('browser_open', {url:'https://example.com'});
  await f.agent.call('browser_click', {tabId:'tab-1',selector:'#submit'});
  await f.agent.call('browser_type', {tabId:'tab-1',selector:'#email',text:'agent@example.com'});
  await f.agent.call('browser_press', {tabId:'tab-1',key:'Control+A'});
  await f.agent.call('browser_scroll', {tabId:'tab-1',x:50,y:50,deltaY:120});
  assert.equal(f.inputs.filter(item => item.type === 'mouseDown').length, 1);
  assert(f.inputs.includes('agent@example.com'));
  assert(f.inputs.some(item => item.type === 'keyDown' && item.modifiers.includes('control')));
  assert(f.scripts.some(item => item.source[0].code.includes(')("scroll",')));
  assert(f.scripts.every(item => item.world === 999));
});

test('navigation actions, screenshot bytes and bounded console entries', async () => {
  const f = fixture(); await f.agent.call('browser_open', {url:'https://example.com'});
  const wc = f.tabs.get('tab-1').view.webContents; f.agent.observe(f.tabs.get('tab-1'));
  wc.emit('console-message', {}, {level:'info',message:'fixture console',lineNumber:4,sourceId:'fixture.js'});
  for (const action of ['back','forward','reload']) await f.agent.call('browser_navigate', {tabId:'tab-1',action});
  assert.deepEqual(f.inputs, ['back','forward','reload']);
  assert.equal((await f.agent.call('browser_screenshot', {tabId:'tab-1'})).content[0].data, Buffer.from('jpeg').toString('base64'));
  assert.equal((await f.agent.call('browser_console', {tabId:'tab-1'})).messages[0].message, 'fixture console');
});

test('takeover aborts waits and blocks open/input until a user enables access', async () => {
  const f = fixture(); await f.agent.call('browser_open', {url:'https://example.com'});
  f.tabs.get('tab-1').view.webContents.isLoading = () => true;
  const waiting = f.agent.call('browser_wait', {tabId:'tab-1',timeoutMs:2000});
  f.agent.stop();
  await assert.rejects(waiting, /taken over/);
  await assert.rejects(f.agent.call('browser_open', {url:'https://example.com'}), /taken over/);
  await assert.rejects(f.agent.call('browser_click', {tabId:'tab-1',x:1,y:2}), /taken over/);
  f.agent.allow(); await f.agent.call('browser_click', {tabId:'tab-1',x:1,y:2});
});

test('invalid arguments and unknown tools fail before action', async () => {
  const f = fixture(); await f.agent.call('browser_open', {url:'https://example.com'});
  for (const [name,args] of [['browser_click',{x:-1,y:1}],['browser_type',{text:42}],['browser_press',{key:''}],['browser_wait',{timeoutMs:90000}],['browser_open',{url:'https://example.com',unexpected:true}],['browser_evaluate',{expression:'process.env'}]]) {
    await assert.rejects(f.agent.call(name,{tabId:'tab-1',...args}));
  }
  assert.equal(f.inputs.length,0);
});

test('takeover cancels in-flight DOM input and queued calls even after access is enabled again', async () => {
  const f=fixture();await f.agent.call('browser_open',{url:'https://example.com'});
  let finish;
  f.tabs.get('tab-1').view.webContents.executeJavaScriptInIsolatedWorld=()=>new Promise(resolve=>{finish=resolve;});
  const first=f.agent.call('browser_click',{tabId:'tab-1',selector:'#button'});
  const second=f.agent.call('browser_click',{tabId:'tab-1',x:10,y:10});
  const rejected=[assert.rejects(first,/taken over/),assert.rejects(second,/taken over/)];
  await new Promise(resolve=>setImmediate(resolve));f.agent.stop();f.agent.allow();finish({x:10,y:10});
  await Promise.all(rejected);assert.equal(f.inputs.length,0);
});

test('waits succeed for loaded/visible pages and fail for missing selectors or failed loads', async () => {
  const f=fixture();await f.agent.call('browser_open',{url:'https://example.com'});
  assert.deepEqual(await f.agent.call('browser_wait',{tabId:'tab-1'}),{ready:true});
  const tab=f.tabs.get('tab-1');tab.view.webContents.executeJavaScriptInIsolatedWorld=async()=>true;
  assert.deepEqual(await f.agent.call('browser_wait',{tabId:'tab-1',selector:'#ready'}),{ready:true});
  tab.view.webContents.executeJavaScriptInIsolatedWorld=async()=>false;
  await assert.rejects(f.agent.call('browser_wait',{tabId:'tab-1',selector:'#missing',timeoutMs:0}),/timed out/);
  tab.error='ERR_CONNECTION_REFUSED';await assert.rejects(f.agent.call('browser_wait',{tabId:'tab-1'}),/REFUSED/);
});

test('private Unix socket permissions and round-trip dispatch', async () => {
  const net = require('node:net');
  const endpoint = await startBrowserAgentSocket();
  try {
    assert.equal((await fs.stat(endpoint.path)).mode & 0o777,0o600);
    assert.equal((await fs.stat(require('node:path').dirname(endpoint.path))).mode & 0o777,0o700);
    endpoint.setAgent({call: async (name,args) => ({name,args})});
    const value = await new Promise((resolve,reject) => {
      const socket=net.createConnection(endpoint.path);socket.on('error',reject);
      socket.on('connect',()=>socket.write(JSON.stringify({name:'browser_tabs',arguments:{}})+'\n'));
      socket.once('data',data=>{socket.end();resolve(JSON.parse(data));});
    });
    assert.deepEqual(value.result,{name:'browser_tabs',args:{}});
  } finally { await endpoint.close(); }
});
