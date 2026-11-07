import type { EventEmitter as NodeEmitter } from 'node:events';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBrowser } = require('./browser.cts') as typeof import('./browser.cts');
// createBrowser runs inside Electron, which names its Chromium version.
(process.versions as { chrome?: string }).chrome ??= '152.0.7977.130';

test('a destroyed sign-in popup closes safely after Electron detaches its webContents', async () => {
  const { EventEmitter } = require('node:events');
  const wc = new EventEmitter();
  Object.assign(wc, { setBackgroundColor() {}, setWindowOpenHandler() {}, navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    getURL: () => '', getZoomFactor: () => 1, isLoading: () => false, isDestroyed: () => false, close() {}, focus() {}, send() {}, loadURL: async () => {} });
  let view!: View;
  class View { declare webContents: typeof wc | undefined; constructor() { this.webContents = wc; view = this; } setVisible() {} setBounds() {} }
  const host = Object.assign(new EventEmitter(), { getContentBounds: () => ({ width: 1320, height: 900 }), contentView: { addChildView() {}, removeChildView() {} }, webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, send() {}, focus() {} }), isDestroyed: () => false, focus() {} });
  const browser = createBrowser({ host, WebContentsView: View, session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setUserAgent() {}, webRequest: { onHeadersReceived() {}, onBeforeSendHeaders() {} } }) }, origin: 'http://127.0.0.1:4000', ipcMain: { handle() {}, on() {}, removeHandler() {}, removeListener() {} } });
  browser.open('https://claude.ai');
  view.webContents = undefined;
  assert.doesNotThrow(() => wc.emit('destroyed'));
  assert.equal(browser.snapshot().tabs.length, 0);
  browser.dispose(); await new Promise<void>(resolve => setImmediate(resolve));
});
const { createBrowserSessions } = require('./browser-sessions.cts');

test('a window link is policy-checked before its session browser is initialized', async () => {
  const host = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { isDestroyed: () => false } });
  const store = { read: () => ({}), set: async () => {}, flush: async () => {} };
  const sessions = createBrowserSessions({ store });
  const browser = sessions.attach({ host, origin: 'http://127.0.0.1:4000', ipcMain: { handle() {}, on() {}, removeHandler() {}, removeListener() {} } });
  for (const url of ['javascript:alert(1)', 'http://127.0.0.1:4000/settings', 'file://server/share/x.pdf']) assert.throws(() => browser.open(url), /web address|file on this computer/);
  // Local files and PDFs open (29 Oct): a file: address or a plain path.
  const { browserUrl } = require('./browser-policy.cts') as typeof import('./browser-policy.cts');
  assert.equal(browserUrl('/home/me/Report 1.pdf', 'http://127.0.0.1:4000'), 'file:///home/me/Report%201.pdf');
  assert.equal(browserUrl('file:///tmp/a.html', 'http://127.0.0.1:4000'), 'file:///tmp/a.html');
  browser.dispose(); await sessions.flush();
});

test('stopping a navigation does not turn its rejected load promise into a page error', async () => {
  const origin = 'http://127.0.0.1:4000', states: { tabs: { error: string | null }[] }[] = [], handlers = new Map<string, (event: unknown, input: unknown) => void>(); let page!: NodeEmitter;
  const root = Object.assign(new EventEmitter(), { mainFrame: { url: origin }, isDestroyed: () => false, focus() {}, send: (_name: string, state: { tabs: { error: string | null }[] }) => states.push(state), getZoomFactor: () => 1 });
  const host = Object.assign(new EventEmitter(), { webContents: root, isDestroyed: () => false, getContentBounds: () => ({ width: 1320, height: 900 }), contentView: { addChildView() {}, removeChildView() {} } });
  class View {
    declare webContents: NodeEmitter;
    declare reject: (reason: Error) => void;
    constructor() { page = this.webContents = Object.assign(new EventEmitter(), { navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setWindowOpenHandler() {}, isDestroyed: () => false, close() {}, focus() {}, send() {}, getZoomFactor: () => 1, getURL: () => '',
      loadURL: () => new Promise((_resolve, reject) => { this.reject = reject; }),
      stop: () => { this.reject(Object.assign(Error("(-3) loading 'https://example.com/'"), { errno: -3 })); page.emit('did-stop-loading'); } }); }
    setVisible() {} setBounds() {}
  }
  const browser = createBrowser({ host, origin, WebContentsView: View, session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setUserAgent() {}, webRequest: { onHeadersReceived() {}, onBeforeSendHeaders() {} } }) },
    ipcMain: { handle: (name: string, fn: (event: unknown, input: unknown) => void) => handlers.set(name, fn), on() {}, removeHandler() {}, removeListener() {} } });
  browser.open('https://example.com');
  handlers.get('elpis:browser')!({ sender: root, senderFrame: root.mainFrame }, { action: 'stop' });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(states.at(-1)!.tabs[0]!.error, null);
  page.emit('did-fail-load', {}, -105, 'Could not resolve this website', 'https://example.com/', true);
  assert.equal(states.at(-1)!.tabs[0]!.error, 'Could not resolve this website');
  browser.dispose();
});
