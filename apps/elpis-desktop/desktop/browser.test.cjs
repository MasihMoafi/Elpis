const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBrowser } = require('./browser.cjs');

test('stopping a navigation does not turn its rejected load promise into a page error', async () => {
  const origin = 'http://127.0.0.1:4000', states = [], handlers = new Map(); let page;
  const root = Object.assign(new EventEmitter(), { mainFrame: { url: origin }, isDestroyed: () => false, focus() {}, send: (_name, state) => states.push(state), getZoomFactor: () => 1 });
  const host = Object.assign(new EventEmitter(), { webContents: root, isDestroyed: () => false, getContentBounds: () => ({ width: 1320, height: 900 }), contentView: { addChildView() {}, removeChildView() {} } });
  class View {
    constructor() { page = this.webContents = Object.assign(new EventEmitter(), { navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setWindowOpenHandler() {}, isDestroyed: () => false, close() {}, focus() {}, send() {}, getZoomFactor: () => 1, getURL: () => '',
      loadURL: () => new Promise((_resolve, reject) => { this.reject = reject; }),
      stop: () => { this.reject(Object.assign(Error("(-3) loading 'https://example.com/'"), { errno: -3 })); page.emit('did-stop-loading'); } }); }
    setVisible() {} setBounds() {}
  }
  const browser = createBrowser({ host, origin, WebContentsView: View, session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {}, removeHandler() {}, removeListener() {} } });
  browser.open('https://example.com');
  handlers.get('elpis:browser')({ sender: root, senderFrame: root.mainFrame }, { action: 'stop' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(states.at(-1).tabs[0].error, null);
  page.emit('did-fail-load', {}, -105, 'Could not resolve this website', 'https://example.com/', true);
  assert.equal(states.at(-1).tabs[0].error, 'Could not resolve this website');
  browser.dispose();
});
