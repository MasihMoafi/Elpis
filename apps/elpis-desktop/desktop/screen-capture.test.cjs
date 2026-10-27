'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScreenCapture } = require('./screen-capture.cjs');

function fixture(t, { wayland = false } = {}) {
  let current = 'chat-a', captureCalls = 0, options, popup, template;
  const image = (value, size = { width: 1280, height: 720 }) => ({ isEmpty: () => false, getSize: () => size,
    toJPEG: () => Buffer.from(value), resize: next => image(value, next) });
  let sources = [{ name: 'Elpis', thumbnail: image('elpis') }, { name: 'External app', thumbnail: image('external') }];
  const mainFrame = { url: 'http://127.0.0.1:45001/' };
  const host = { webContents: { mainFrame, isDestroyed: () => false }, isDestroyed: () => false, isFocused: () => false };
  const service = createScreenCapture({ env: { XDG_SESSION_TYPE: wayland ? 'wayland' : 'x11' }, platform: 'linux',
    desktopCapturer: { async getSources(value) { captureCalls++; options = value; return typeof sources === 'function' ? sources() : sources; } },
    Menu: { buildFromTemplate(value) { template = value; return { popup(value) { popup = value; }, closePopup() { popup.callback(); } }; } },
  });
  const handlers = new Map(), ipcMain = { handle: (name, callback) => handlers.set(name, callback), removeHandler: name => handlers.delete(name) };
  const event = { sender: host.webContents, senderFrame: mainFrame };
  const dispose = service.attach({ host, origin: 'http://127.0.0.1:45001', ipcMain, session: () => current });
  t.after(() => service.close());
  return { service, host, image, dispose, event, bind: (id, sender = event) => handlers.get('elpis:screen-capture:session')(sender, id), calls: () => captureCalls, options: () => options, template: () => template,
    session: value => { current = value; }, sources: value => { sources = value; },
    async menu() { while (!popup) await new Promise(setImmediate); },
    choose(index) { template[index].click(); popup.callback(); }, cancel() { popup.callback(); } };
}

test('one explicit source selection shares the chosen external image, without recording or saved files', async t => {
  const f = fixture(t);
  assert.equal(f.calls(), 0);
  const capture = f.service.call('chat-a', 'screen_screenshot', {});
  await f.menu(); assert.equal(f.calls(), 1);
  assert.deepEqual(f.options().types, ['screen', 'window']);
  assert.deepEqual(f.template().slice(0, 2).map(item => item.label), ['Elpis', 'External app']);
  f.choose(1);
  assert.deepEqual(await capture, { content: [{ type: 'image', mimeType: 'image/jpeg', data: Buffer.from('external').toString('base64') }] });
  await new Promise(setImmediate); assert.equal(f.calls(), 1);
});

test('another chat, foreign origin and injected source arguments cannot capture', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.call('chat-b', 'screen_screenshot', {}), /Open this chat/);
  for (const args of [{ sourceId: 'guessed' }, null, []]) await assert.rejects(f.service.call('chat-a', 'screen_screenshot', args), /picker/);
  f.host.webContents.mainFrame.url = 'https://external.example/';
  await assert.rejects(f.service.call('chat-a', 'screen_screenshot', {}), /Open this chat/);
  assert.equal(f.calls(), 0);
});

test('only the trusted main frame can bind the pinned companion chat, without replacing the shown chat', async t => {
  const f = fixture(t, { wayland: true });
  f.sources([{ name: 'Chosen page', thumbnail: f.image('portal') }]);
  for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: { url: f.event.senderFrame.url } }]) assert.throws(() => f.bind('companion', event), /application frame/);
  assert.throws(() => f.bind('../foreign'), /Invalid screenshot session/);
  await assert.rejects(f.service.call('companion', 'screen_screenshot', {}), /Open this chat/);
  assert.deepEqual(f.bind('companion'), { bound: true });
  for (const id of ['companion', 'chat-a']) assert.equal((await f.service.call(id, 'screen_screenshot', {})).content[0].type, 'image');
  f.bind(null); await assert.rejects(f.service.call('companion', 'screen_screenshot', {}), /Open this chat/);
});

test('closing or switching the requesting chat while choosing discards the pixels and prevents parallel capture', async t => {
  const f = fixture(t);
  const first = f.service.call('chat-a', 'screen_screenshot', {}); await f.menu();
  await assert.rejects(f.service.call('chat-a', 'screen_screenshot', {}), /already/);
  f.session('chat-b'); f.choose(1);
  await assert.rejects(first, /no longer shown/);
  f.session('chat-a');
  const second = f.service.call('chat-a', 'screen_screenshot', {}); await new Promise(setImmediate);
  f.dispose(); await assert.rejects(second, /closed/);
  assert.equal(f.calls(), 2);
});

test('portal and menu cancellation return a clear error with no image; a later request still works', async t => {
  const f = fixture(t, { wayland: true });
  f.sources(() => { throw Error('Picker dismissed'); });
  await assert.rejects(f.service.call('chat-a', 'screen_screenshot', {}), /cancelled/);
  f.sources([]); await assert.rejects(f.service.call('chat-a', 'screen_screenshot', {}), /No screen/);
  f.sources([{ name: 'Chosen page', thumbnail: f.image('portal') }]);
  assert.equal((await f.service.call('chat-a', 'screen_screenshot', {})).content[0].data, Buffer.from('portal').toString('base64'));
  const native = fixture(t);
  const cancelled = native.service.call('chat-a', 'screen_screenshot', {}); await native.menu(); native.cancel();
  await assert.rejects(cancelled, /cancelled/);
});

test('empty and oversized screenshots never report successful capture', async t => {
  const f = fixture(t, { wayland: true });
  for (const thumbnail of [null, { isEmpty: () => true }, f.image('', { width: 0, height: 0 }), f.image(''), f.image(Buffer.alloc(8 * 1024 * 1024 + 1))]) {
    f.sources([{ name: 'Chosen page', thumbnail }]);
    await assert.rejects(f.service.call('chat-a', 'screen_screenshot', {}), /empty|large/);
  }
});
