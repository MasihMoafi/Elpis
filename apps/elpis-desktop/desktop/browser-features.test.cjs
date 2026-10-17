// The in-app browser's ChatGPT-parity features in the Electron main process, with Electron replaced by fakes:
// annotation (page picks, capture, comments, the agent's text), the page menu, zoom, find, errors and keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createBrowser } = require('./browser.cjs');

function fixture() {
  const origin = 'http://127.0.0.1:4000', states = [], handlers = new Map(), listeners = new Map(), pages = [], views = [], menus = [], externals = [];
  const root = Object.assign(new EventEmitter(), { mainFrame: { url: origin }, isDestroyed: () => false, focus() { root.focused = (root.focused ?? 0) + 1; }, send: (_name, state) => states.push(state), getZoomFactor: () => 1 });
  const host = Object.assign(new EventEmitter(), { webContents: root, isDestroyed: () => false, getContentBounds: () => ({ width: 1320, height: 900 }), contentView: { addChildView() {}, removeChildView() {} } });
  const image = { getSize: () => ({ width: 2560, height: 1440 }), isEmpty: () => false, resize(options) { image.resized = options; return image; }, toJPEG: quality => Buffer.from(`jpeg-${quality}`) };
  class View {
    constructor(options) {
      this.options = options; views.push(this);
      const wc = this.webContents = Object.assign(new EventEmitter(), { url: 'about:blank', zoom: 1, sent: [], finds: [], mainFrame: {},
        navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack() { wc.back = true; }, goForward() {} },
        setWindowOpenHandler() {}, isDestroyed: () => false, close() {}, focus() {}, getURL: () => wc.url,
        loadURL(url) { wc.url = url; return Promise.resolve(); }, send: (channel, message) => wc.sent.push({ channel, message }),
        capturePage: async () => image, getZoomFactor: () => wc.zoom, setZoomFactor(value) { wc.zoom = value; },
        findInPage(text, options) { wc.finds.push([text, options]); return wc.finds.length; }, stopFindInPage(action) { wc.stopped = action; },
        reload() { wc.reloaded = true; }, reloadIgnoringCache() { wc.hard = true; }, stop() {}, print() { wc.printed = true; },
        openDevTools(options) { wc.devtools = options; }, inspectElement(x, y) { wc.inspected = [x, y]; }, isDevToolsOpened: () => !!wc.devtools,
        copy() {}, cut() {}, paste() {}, selectAll() {}, copyImageAt() {}, downloadURL() {}, replaceMisspelling() {}, session: {} });
      pages.push(wc);
    }
    setVisible() {} setBounds() {}
  }
  const clipboard = { writeText(text) { clipboard.text = text; }, writeImage(value) { clipboard.image = value; } };
  const Menu = { buildFromTemplate: template => ({ popup() { menus.push(template); } }) };
  const browserSession = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, async clearStorageData(options) { browserSession.cleared = options; }, async clearCache() { browserSession.cacheCleared = true; } };
  const browser = createBrowser({ host, origin, WebContentsView: View, session: { fromPartition: () => browserSession }, Menu, clipboard,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn), removeHandler() {}, removeListener() {} }, openExternal: url => externals.push(url) });
  const app = { sender: root, senderFrame: root.mainFrame };
  const command = (action, data = {}) => handlers.get('elpis:browser')(app, { action, ...data });
  const fromPage = (wc, message) => listeners.get('elpis:browser:page')({ sender: wc, senderFrame: wc.mainFrame }, message);
  const state = () => states.at(-1);
  const toPage = (wc, type) => wc.sent.filter(item => item.channel === 'elpis:annotate' && item.message.type === type).map(item => item.message);
  return { browser, command, fromPage, state, pages, views, menus, externals, clipboard, image, root, browserSession, toPage };
}
const pick = { id: 'pick-1', kind: 'element', title: 'Login', selector: '#login > button.primary', elementPath: 'html > body > main > form > button', role: 'button', name: 'Sign in', nearbyText: 'Email Password', immediateText: 'Sign in', tag: 'button', rect: { x: 10, y: 20, width: 120, height: 32 }, isFixed: false, viewport: { width: 1280, height: 720 } };
const settle = () => new Promise(resolve => setImmediate(resolve));
async function picked(f, page, value = pick) {
  f.fromPage(page, { type: 'pick', pick: value });
  await settle();
  const paint = f.toPage(page, 'paint').at(-1);
  assert.equal(paint.id, value.id, 'the page draws the outline and number before the screenshot');
  f.fromPage(page, { type: 'painted', id: value.id });
  await new Promise(resolve => setTimeout(resolve, 150));
}

test('each tab page gets the annotation preload in a sandbox with context isolation', () => {
  const f = fixture(); f.browser.open('https://example.com');
  const preferences = f.views[0].options.webPreferences;
  assert.equal(preferences.preload, path.join(__dirname, 'browser-page-preload.cjs'));
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
});

test('annotate: a click on the page becomes a numbered draft with a screenshot, then a comment the agent reads', async () => {
  const f = fixture(); f.browser.open('https://example.com/login'); const page = f.pages[0];
  f.fromPage(page, { type: 'pick', pick });
  assert.equal(f.state()?.draft ?? null, null, 'a page cannot start annotating by itself');
  await f.command('annotate');
  assert.equal(f.state().annotating, true);
  assert.equal(f.toPage(page, 'state').at(-1).mode, true, 'the page layer turns on');
  f.fromPage({ sender: {}, senderFrame: {} }, { type: 'pick', pick });
  assert.equal(f.state().draft, null, 'only the tab itself may report a selection');
  f.fromPage(page, { type: 'pick', pick: { ...pick, kind: 'script' } });
  assert.equal(f.state().draft, null, 'malformed selections are dropped');
  const focusBefore = f.root.focused ?? 0;
  await picked(f, page);
  assert.deepEqual(f.state().draft, { id: 'pick-1', number: 1, kind: 'element', label: 'button “Sign in”', body: '', editing: false });
  assert.ok((f.root.focused ?? 0) > focusBefore, 'typing goes to Elpis, not the page');
  assert.deepEqual(f.image.resized, { width: 1280, quality: 'good' });
  await assert.rejects(() => f.command('comment', { body: '   ' }).then(result => { if (result.error) throw Error(result.error); }));
  await f.command('comment', { body: 'Make this the accent colour' });
  assert.equal(f.state().draft, null);
  assert.deepEqual(f.state().annotations, [{ id: 'pick-1', number: 1, kind: 'element', label: 'button “Sign in”', body: 'Make this the accent colour' }]);
  assert.equal(f.toPage(page, 'state').at(-1).comments[0].anchor.selector, '#login > button.primary', 'the page keeps a numbered marker');

  await picked(f, page, { ...pick, id: 'pick-2', kind: 'region', name: null, immediateText: null, selector: null, rect: { x: 0, y: 300, width: 400, height: 100 } });
  await f.command('comment', { body: 'Too much space' });
  await f.command('commentEdit', { id: 'pick-1' });
  assert.equal(f.state().draft.editing, true); assert.equal(f.state().draft.body, 'Make this the accent colour');
  await f.command('comment', { body: 'Use the primary colour' });
  assert.equal(f.state().annotations[0].body, 'Use the primary colour');
  assert.equal(f.state().annotations.length, 2);

  const { result } = await f.command('annotationsCollect', { value: 'images' });
  assert.equal(result.count, 2);
  assert.match(result.text, /^# Browser comments:\n\n## User Comment 1\nBrowser\n/);
  assert.match(result.text, /Page URL: https:\/\/example\.com\/login\n/);
  assert.match(result.text, /## User Comment 2\n[\s\S]*Area rectangle: x=0, y=300, width=400, height=100\n[\s\S]*Comment:\nToo much space\n/);
  assert.deepEqual(result.images.map(item => [item.number, item.dataUrl]), [[1, `data:image/jpeg;base64,${Buffer.from('jpeg-82').toString('base64')}`], [2, `data:image/jpeg;base64,${Buffer.from('jpeg-82').toString('base64')}`]]);
  assert.equal(f.state().annotations.length, 2, 'collecting does not lose comments if the message cannot be sent');
  await f.command('annotationsSent');
  assert.deepEqual(f.state().annotations, []); assert.equal(f.state().annotating, false, 'sending ends annotation mode');
});

test('annotations: delete renumbers, discard clears, markers hide, Escape in the page cancels then exits', async () => {
  const f = fixture(); f.browser.open('https://example.com'); const page = f.pages[0];
  await f.command('annotate');
  for (const id of ['a', 'b', 'c']) { await picked(f, page, { ...pick, id }); await f.command('comment', { body: `note ${id}` }); }
  await f.command('commentDelete', { id: 'a' });
  assert.deepEqual(f.state().annotations.map(item => [item.id, item.number]), [['b', 1], ['c', 2]]);
  await f.command('markers');
  assert.equal(f.state().markersVisible, false); assert.equal(f.toPage(page, 'state').at(-1).markersVisible, false);
  await picked(f, page, { ...pick, id: 'd' });
  f.fromPage(page, { type: 'cancel' });
  assert.equal(f.state().draft, null); assert.equal(f.state().annotating, true);
  f.fromPage(page, { type: 'exit' });
  assert.equal(f.state().annotating, false); assert.equal(f.state().annotations.length, 2, 'leaving keeps pending comments, as in ChatGPT');
  f.fromPage(page, { type: 'edit', id: 'b' });
  assert.equal(f.state().draft, null, 'markers open comments only while annotating');
  await f.command('annotate'); f.fromPage(page, { type: 'edit', id: 'b' });
  assert.equal(f.state().draft.id, 'b');
  await f.command('annotationsDiscard');
  assert.deepEqual(f.state().annotations, []); assert.equal(f.state().draft, null);
  for (let index = 0; index < 13; index++) { await picked(f, page, { ...pick, id: `n${index}` }).catch(() => {}); if (f.state().draft) await f.command('comment', { body: 'x' }); }
  assert.equal(f.state().annotations.length, 12, 'twelve comments per page, one screenshot sheet');
});

test('the page menu offers links, navigation, Comment and Inspect; Comment annotates what was clicked', async () => {
  const f = fixture(); f.browser.open('https://example.com'); const page = f.pages[0];
  page.emit('context-menu', {}, { x: 40, y: 50, linkURL: 'https://example.com/docs', editFlags: {}, selectionText: '', mediaType: 'none' });
  const labels = f.menus.at(-1).filter(item => item.label).map(item => item.label);
  assert.deepEqual(labels, ['Open link', 'Copy link', 'Open link in external browser', 'Back', 'Forward', 'Reload', 'Comment', 'Inspect']);
  const item = label => f.menus.at(-1).find(entry => entry.label === label);
  assert.equal(item('Forward').enabled, false);
  item('Copy link').click(); await settle(); assert.equal(f.clipboard.text, 'https://example.com/docs');
  item('Open link in external browser').click(); assert.deepEqual(f.externals, ['https://example.com/docs']);
  item('Open link').click(); assert.equal(f.state().tabs.length, 2); assert.equal(f.state().tabs[1].url, 'https://example.com/docs');
  page.emit('context-menu', {}, { x: 40, y: 50, linkURL: '', editFlags: { canCopy: true }, selectionText: 'hello', mediaType: 'none' });
  assert.deepEqual(f.menus.at(-1).filter(entry => entry.label).map(entry => entry.label), ['Copy', 'Back', 'Forward', 'Reload', 'Comment', 'Inspect']);
  await f.command('select', { id: f.state().tabs[0].id });
  f.menus.at(-1).find(entry => entry.label === 'Comment').click();
  assert.equal(f.state().annotating, true);
  assert.deepEqual(f.toPage(page, 'pickAt').at(-1), { type: 'pickAt', x: 40, y: 50 });
  f.menus.at(-1).find(entry => entry.label === 'Inspect').click();
  assert.deepEqual(page.inspected, [40, 50]);
});

test('zoom, find in page, print, screenshots, hard reload and clearing data', async () => {
  const f = fixture(); f.browser.open('https://example.com'); const page = f.pages[0];
  await f.command('zoom', { value: 'in' });
  assert.equal(page.zoom, 1.1); assert.equal(f.state().tabs[0].zoom, 110);
  page.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: '=', control: true, meta: false, alt: false, shift: false });
  assert.equal(page.zoom, 1.25, 'Ctrl+= on the page zooms in');
  page.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: '0', control: true, meta: false, alt: false, shift: false });
  assert.equal(f.state().tabs[0].zoom, 100);

  page.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'f', control: true, meta: false, alt: false, shift: false });
  assert.equal(f.state().find.open, true); assert.ok(f.state().find.focus > 0, 'Ctrl+F on the page opens and focuses the find bar');
  await f.command('find', { text: 'cache' });
  await f.command('find', { text: 'cache' });
  await f.command('find', { text: 'cache', value: 'previous' });
  assert.deepEqual(page.finds, [['cache', { forward: true, findNext: true }], ['cache', { forward: true, findNext: false }], ['cache', { forward: false, findNext: false }]]);
  page.emit('found-in-page', {}, { requestId: 3, activeMatchOrdinal: 2, matches: 7, finalUpdate: true });
  assert.deepEqual({ ...f.state().find, focus: 0 }, { open: true, text: 'cache', matches: 7, active: 2, focus: 0 });
  await f.command('findClose');
  assert.equal(page.stopped, 'keepSelection'); assert.equal(f.state().find.open, false);

  await f.command('print'); assert.equal(page.printed, true);
  await f.command('screenshot', { value: 'copy' }); assert.equal(f.clipboard.image, f.image);
  const attached = await f.command('screenshot', { value: 'attach' });
  assert.match(attached.result.image, /^data:image\/jpeg;base64,/);
  page.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'R', control: true, meta: false, alt: false, shift: true });
  assert.equal(page.hard, true, 'Ctrl+Shift+R reloads without the cache');
  page.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'ArrowLeft', control: false, meta: false, alt: true, shift: false });
  assert.equal(page.back, true, 'Alt+Left goes back');
  await f.command('clearData', { value: 'cookies' }); assert.deepEqual(f.browserSession.cleared, { storages: ['cookies'] });
  await f.command('clearData', { value: 'cache' }); assert.equal(f.browserSession.cacheCleared, true);
  await f.command('devtools'); assert.deepEqual(page.devtools, { mode: 'detach' });
});

test('a failed load reports its cause; a new navigation clears it; addresses carry their security', async () => {
  const f = fixture(); f.browser.open('http://localhost:3000/'); const page = f.pages[0];
  assert.equal(f.state().tabs[0].security, 'local');
  page.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:3000/', true);
  assert.equal(f.state().tabs[0].failure.summary, 'localhost refused to connect');
  page.emit('did-start-navigation', {}, 'http://localhost:3000/', false, true);
  assert.equal(f.state().tabs[0].failure, null);
  page.emit('did-navigate', {}, 'http://example.com/');
  assert.equal(f.state().tabs[0].security, 'insecure');
});

test('tab menu commands: duplicate opens beside the tab, Copy URL writes the address', async () => {
  const f = fixture(); f.browser.open('https://a.example/'); f.browser.open('https://b.example/');
  const [first] = f.state().tabs;
  await f.command('duplicate', { id: first.id });
  assert.deepEqual(f.state().tabs.map(tab => tab.url), ['https://a.example/', 'https://a.example/', 'https://b.example/']);
  await f.command('copyUrl', { id: first.id });
  assert.equal(f.clipboard.text, 'https://a.example/');
});

test('Ctrl+T, Ctrl+W and Ctrl+Tab in Elpis’s own window are left to the chat tabs; on a page they act on the side panel’s page tabs', () => {
  const f = fixture(); f.browser.open('https://a.test'); f.browser.open('https://b.test');
  assert.equal(f.state().visible, true);
  let prevented = 0; const event = { preventDefault() { prevented++; } };
  const key = (name, extra = {}) => ({ type: 'keyDown', key: name, control: true, meta: false, alt: false, shift: false, ...extra });
  for (const name of ['t', 'w', 'Tab']) f.root.emit('before-input-event', event, key(name));
  assert.equal(prevented, 0, 'the renderer gets these keys');
  assert.equal(f.state().tabs.length, 2);
  const focused = f.state().focusAddress;
  f.root.emit('before-input-event', event, key('l'));
  assert.equal(f.state().focusAddress, focused + 1, 'Ctrl+L still focuses the address bar');
  f.pages[1].emit('before-input-event', event, key('w'));
  assert.equal(f.state().tabs.length, 1, 'Ctrl+W on a page closes that page tab');
  f.pages[0].emit('before-input-event', event, key('t'));
  assert.equal(f.state().tabs.length, 2, 'Ctrl+T on a page opens a page tab');
});

test('Ctrl+Shift+F on a page asks the window for full view instead of opening find; in Elpis’s own window the renderer takes the key', () => {
  const f = fixture(); f.browser.open('https://a.test');
  assert.equal(f.state().fullView, 0);
  let prevented = 0; const event = { preventDefault() { prevented++; } };
  const key = (name, extra = {}) => ({ type: 'keyDown', key: name, control: true, meta: false, alt: false, shift: false, ...extra });
  f.root.emit('before-input-event', event, key('F', { shift: true }));
  assert.equal(prevented, 0, 'the renderer gets the key from its own window'); assert.equal(f.state().fullView, 0);
  f.pages[0].emit('before-input-event', event, key('F', { shift: true }));
  assert.equal(f.state().fullView, 1, 'a request the window answers by toggling full view'); assert.equal(prevented, 1, 'the page does not get the key');
  assert.equal(f.state().find.open, false, 'Ctrl+Shift+F is not Ctrl+F');
  f.pages[0].emit('before-input-event', event, key('f'));
  assert.equal(f.state().find.open, true, 'Ctrl+F still opens find'); assert.equal(f.state().fullView, 1);
});
