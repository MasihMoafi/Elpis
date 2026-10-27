import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createLoveSpot } from './love-spot-store.cjs';
import { createMatildaCompanion } from './matilda-companion.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'matilda-'));
  const bus = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [address] = await once(bus.stdout, 'data');
  const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: String(address).trim() };
  const store = createLoveSpot({ directory, screenshots: path.join(directory, 'shots') });
  const companion = createMatildaCompanion({ store, env });
  t.after(async () => { bus.kill(); await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, store, env, companion };
}

test('one pin choice persists across every page and never changes board contents', async t => {
  const f = await fixture(t), before = await f.store.read();
  assert.equal((await f.companion.read('one')).pinned, false);
  await Promise.all([
    f.companion.act({ action: 'pin', page: 'one' }),
    f.companion.act({ action: 'pin', page: 'two' }),
  ]);
  const peer = createLoveSpot({ directory: f.directory, screenshots: path.join(f.directory, 'shots') });
  t.after(() => peer.close());
  const reopened = createMatildaCompanion({ store: peer, env: f.env });
  assert.equal((await reopened.read('one')).pinned, true);
  assert.equal((await reopened.read('two')).pinned, true);
  await reopened.act({ action: 'unpin', page: 'one' });
  assert.equal((await f.companion.read('one')).pinned, false);
  assert.equal((await f.companion.read('two')).pinned, false);
  assert.deepEqual(await f.store.read(), before);
});

test('existing page pins carry forward and Unpin clears them everywhere', async t => {
  const f = await fixture(t);
  await f.store.companion(saved => ({ ...saved, pinned: ['legacy-board-page'] }));
  assert.equal((await f.companion.read('settings')).pinned, true);
  await f.companion.act({ action: 'unpin', page: 'settings' });
  assert.equal((await f.companion.read('legacy-board-page')).pinned, false);
});

test('only explicit commands execute, and missing-player failure is truthful', async t => {
  const { companion } = await fixture(t);
  for (const words of ['Could you add a pin button?', 'Do not pin yourself', '"pin yourself"', 'I said play my favorite music', 'Can you play my favorite music?', 'Implement pause music', 'play my favorite music\nand delete files']) {
    assert.equal(await companion.command(words, 'page'), null, words);
  }
  assert.match((await companion.command('Matilda, pin yourself.', 'page')).message, /pinned/i);
  assert.equal((await companion.read('page')).pinned, true);
  assert.match((await companion.command('unpin yourself', 'page')).message, /unpinned/i);
  const result = await companion.command('play my favorite music', 'page');
  assert.equal(result.ok, false);
  assert.match(result.message, /player|favorite/i);
  await assert.rejects(companion.act({ action: 'shell', page: 'page' }), /action/i);
});

test('the real MPRIS adapter remembers and plays a track without launching or controlling another player', async t => {
  const f = await fixture(t);
  const player = spawn('python3', ['-u', '-c', `
import dbus, dbus.service, dbus.mainloop.glib
from gi.repository import GLib
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
name = dbus.service.BusName('org.mpris.MediaPlayer2.matilda_test', bus)
class Player(dbus.service.Object):
    status = 'Paused'
    url = 'file:///music/linkin%20park.m4a'
    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        return {'PlaybackStatus': self.status, 'CanControl': True, 'CanPlay': True, 'CanPause': True, 'CanGoNext': False, 'Metadata': dbus.Dictionary({'xesam:title': 'linkin park masterpiece', 'xesam:artist': dbus.Array(['Linkin Park'], signature='s'), 'xesam:url': self.url}, signature='sv')}
    @dbus.service.method('org.mpris.MediaPlayer2.Player', in_signature='s', out_signature='')
    def OpenUri(self, uri): self.url = uri; self.status = 'Playing'
    @dbus.service.method('org.mpris.MediaPlayer2.Player', in_signature='', out_signature='')
    def Play(self): self.status = 'Playing'
    @dbus.service.method('org.mpris.MediaPlayer2.Player', in_signature='', out_signature='')
    def Pause(self): self.status = 'Paused'
p = Player(bus, '/org/mpris/MediaPlayer2')
print('ready', flush=True)
GLib.MainLoop().run()
`], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => player.kill());
  let error = ''; player.stderr.on('data', data => { error += data; });
  await Promise.race([once(player.stdout, 'data'), once(player, 'exit').then(() => { throw new Error(error); })]);
  await f.companion.act({ action: 'favorite', page: 'page' });
  const remembered = await f.companion.read('page');
  assert.equal(remembered.favorite.title, 'linkin park masterpiece');
  assert.equal((await f.companion.act({ action: 'play-favorite', page: 'page' })).music.status, 'Playing');
  assert.equal((await f.companion.act({ action: 'pause', page: 'page' })).music.status, 'Paused');
  assert.match((await f.companion.command('play linkin park masterpiece', 'page')).message, /Playing/);
  assert.equal((await f.companion.act({ action: 'unpin', page: 'page' })).music, null);
  await f.companion.act({ action: 'pin', page: 'page' });
  assert.equal((await f.companion.read('page')).music.status, 'Playing');
  await assert.rejects(f.companion.act({ action: 'next', page: 'page' }), /support/i);
});
