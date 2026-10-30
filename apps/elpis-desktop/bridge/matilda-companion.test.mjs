import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createLoveSpot } from './love-spot-store.cjs';
import { createMatildaCompanion, PYTHON } from './matilda-companion.mjs';

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

async function startPlayer(t, f, { name = 'matilda_test', openUri = true, volume = 0.37, writableVolume = true, playing = false } = {}) {
  const calls = path.join(f.directory, `${name}-calls`);
  const player = spawn(PYTHON, ['-u', '-c', `
import sys, dbus, dbus.service, dbus.mainloop.glib
from gi.repository import GLib
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
name = dbus.service.BusName('org.mpris.MediaPlayer2.' + sys.argv[1], bus)
def log(action):
    with open(sys.argv[2], 'a') as output: output.write(action + '\\n')
class Player(dbus.service.Object):
    status = 'Playing' if sys.argv[5] == 'true' else 'Paused'
    volume = ${volume === null ? 'None' : volume}
    url = 'file:///music/linkin%20park.m4a'
    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        return {'PlaybackStatus': self.status, 'CanControl': True, 'CanPlay': True, 'CanPause': True, 'CanGoNext': False, **({'Volume': dbus.Double(self.volume)} if self.volume is not None else {}), 'Metadata': dbus.Dictionary({'xesam:title': 'linkin park masterpiece', 'xesam:artist': dbus.Array(['Linkin Park'], signature='s'), 'xesam:url': self.url}, signature='sv')}
    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='ssv', out_signature='')
    def Set(self, interface, prop, value):
        if interface != 'org.mpris.MediaPlayer2.Player' or prop != 'Volume' or sys.argv[4] == 'false': raise dbus.DBusException('Read only', name='org.freedesktop.DBus.Error.PropertyReadOnly')
        log('Volume:' + str(float(value))); self.volume = float(value)
    @dbus.service.method('org.mpris.MediaPlayer2.Player', in_signature='s', out_signature='')
    def OpenUri(self, uri):
        log('OpenUri')
        if sys.argv[3] == 'false': raise dbus.DBusException('Unsupported', name='org.freedesktop.DBus.Error.UnknownMethod')
        self.url = uri; self.status = 'Playing'
    @dbus.service.method('org.mpris.MediaPlayer2.Player', in_signature='', out_signature='')
    def Play(self): log('Play'); self.status = 'Playing'
    @dbus.service.method('org.mpris.MediaPlayer2.Player', in_signature='', out_signature='')
    def Pause(self): self.status = 'Paused'
    @dbus.service.method('org.matilda.Test', in_signature='s', out_signature='')
    def Load(self, uri):
        def loaded(): self.url = uri; self.status = 'Playing'; return False
        GLib.timeout_add(150, loaded)
p = Player(bus, '/org/mpris/MediaPlayer2')
print('ready', flush=True)
GLib.MainLoop().run()
`, name, calls, String(openUri), String(writableVolume), String(playing)], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => player.kill());
  let error = ''; player.stderr.on('data', data => { error += data; });
  await Promise.race([once(player.stdout, 'data'), once(player, 'exit').then(() => { throw new Error(error); })]);
  return { calls };
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
  for (const words of ['Could you add a pin button?', 'Do not pin yourself', '"pin yourself"', 'I said play my favorite music', 'Can you play my favorite music?', 'Implement pause music', 'play my favorite music\nand delete files', 'do not open the music I love', 'open the music I love and delete files']) {
    assert.equal(await companion.command(words, 'page'), null, words);
  }
  assert.match((await companion.command('Matilda, pin yourself.', 'page')).message, /pinned/i);
  assert.equal((await companion.read('page')).pinned, true);
  assert.match((await companion.command('unpin yourself', 'page')).message, /unpinned/i);
  const result = await companion.command('play my favorite music', 'page');
  assert.equal(result.ok, false);
  assert.match(result.message, /player|favorite/i);
  const lovedMusic = await companion.command('open the music I love', 'page');
  assert.equal(lovedMusic.ok, false);
  assert.match(lovedMusic.message, /favorite/i);
  await assert.rejects(companion.act({ action: 'shell', page: 'page' }), /action/i);
});

test('the real MPRIS adapter remembers and plays a track without launching or controlling another player', async t => {
  const f = await fixture(t);
  await startPlayer(t, f);
  await f.companion.act({ action: 'favorite', page: 'page' });
  const remembered = await f.companion.read('page');
  assert.equal(remembered.favorite.title, 'linkin park masterpiece');
  assert.equal((await f.companion.act({ action: 'play-favorite', page: 'page' })).music.status, 'Playing');
  assert.equal((await f.companion.act({ action: 'pause', page: 'page' })).music.status, 'Paused');
  const opened = await f.companion.command('open the music I love', 'page');
  assert.equal(opened.ok, true);
  assert.match(opened.message, /^Playing:/);
  await f.companion.act({ action: 'pause', page: 'page' });
  assert.match((await f.companion.command('play linkin park masterpiece', 'page')).message, /Playing/);
  assert.equal((await f.companion.act({ action: 'unpin', page: 'page' })).music, null);
  await f.companion.act({ action: 'pin', page: 'page' });
  assert.equal((await f.companion.read('page')).music.status, 'Playing');
  const otherUri = 'file:///music/another.m4a';
  await f.store.companion(saved => ({ ...saved, favorite: { ...saved.favorite, uri: otherUri } }));
  assert.equal((await f.companion.act({ action: 'play-favorite', page: 'page' })).music.uri, otherUri);
  await assert.rejects(f.companion.act({ action: 'next', page: 'page' }), /support/i);
});

// 28 Oct, arch-drawer: from a conda shell "play my favorite music" ran conda's python3, which has no dbus, and failed.
test('music uses the system Python, not a python3 earlier on PATH', async t => {
  const f = await fixture(t), bin = path.join(f.directory, 'bin');
  await startPlayer(t, f);
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'python3'), "#!/bin/sh\necho \"ModuleNotFoundError: No module named 'dbus'\" >&2\nexit 1\n", { mode: 0o755 });
  const companion = createMatildaCompanion({ store: f.store, env: { ...f.env, PATH: `${bin}:${f.env.PATH}` } });
  await companion.act({ action: 'favorite', page: 'page' });
  assert.equal((await companion.read('page')).favorite.title, 'linkin park masterpiece');
});

test('a favorite already loaded resumes with Play when OpenUri is unavailable', async t => {
  const f = await fixture(t), { calls } = await startPlayer(t, f, { openUri: false });
  await f.companion.act({ action: 'favorite', page: 'page' });
  const result = await f.companion.act({ action: 'play-favorite', page: 'page' });
  assert.equal(result.music.status, 'Playing');
  assert.equal(result.music.uri, 'file:///music/linkin%20park.m4a');
  assert.equal(await fs.readFile(calls, 'utf8'), 'Play\n');
});

for (const confirms of [true, false]) test(`Audacious fallback ${confirms ? 'waits for the requested track' : 'rejects an unconfirmed track'}`, async t => {
  const f = await fixture(t);
  await startPlayer(t, f, { name: 'audacious', openUri: false });
  const bin = path.join(f.directory, 'bin'), argsFile = path.join(f.directory, 'audacious-args');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'audacious'), `#!/usr/bin/python3
import sys, json, dbus
with open(${JSON.stringify(argsFile)}, 'w') as output: json.dump(sys.argv[1:], output)
if ${confirms ? 'True' : 'False'}:
    player = dbus.SessionBus().get_object('org.mpris.MediaPlayer2.audacious', '/org/mpris/MediaPlayer2')
    dbus.Interface(player, 'org.matilda.Test').Load(sys.argv[-1])
`, { mode: 0o755 });
  const favorite = { title: 'favorite', uri: 'file:///music/a%20different%20track.m4a', player: 'org.mpris.MediaPlayer2.audacious' };
  await f.store.companion(saved => ({ ...saved, favorite }));
  const companion = createMatildaCompanion({ store: f.store, env: { ...f.env, PATH: `${bin}:${f.env.PATH}` } });
  if (confirms) {
    const result = await companion.act({ action: 'play-favorite', page: 'page' });
    assert.equal(result.music.status, 'Playing');
    assert.equal(result.music.uri, favorite.uri);
  } else {
    await assert.rejects(companion.act({ action: 'play-favorite', page: 'page' }), /could not open|not confirmed/i);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(argsFile, 'utf8')), ['--headless', '--play', favorite.uri]);
});

test('an unsupported player never invokes the Audacious fallback', async t => {
  const f = await fixture(t);
  await startPlayer(t, f, { openUri: false });
  const bin = path.join(f.directory, 'bin'), marker = path.join(f.directory, 'unexpected-launch');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'audacious'), `#!/usr/bin/python3\nopen(${JSON.stringify(marker)}, 'w').close()\n`, { mode: 0o755 });
  await f.store.companion(saved => ({ ...saved, favorite: { uri: 'file:///music/another.m4a', player: 'org.mpris.MediaPlayer2.matilda_test' } }));
  const companion = createMatildaCompanion({ store: f.store, env: { ...f.env, PATH: `${bin}:${f.env.PATH}` } });
  await assert.rejects(companion.act({ action: 'play-favorite', page: 'page' }), /could not open/i);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});


test('music mute changes only the selected player volume and restores it after reads and reopening', async t => {
  const f = await fixture(t), { calls } = await startPlayer(t, f);
  await f.companion.act({ action: 'pin', page: 'page' });
  const before = (await f.companion.read('page')).music;
  assert.equal(before.canMute, true);
  assert.equal(before.muted, false);
  const muted = (await f.companion.act({ action: 'toggle-mute', page: 'page' })).music;
  assert.equal(muted.muted, true);
  assert.equal(muted.volume, 0);
  assert.equal(muted.status, before.status);
  assert.equal(muted.uri, before.uri);
  assert.equal((await f.companion.read('page')).music.muted, true);
  const peer = createLoveSpot({ directory: f.directory, screenshots: path.join(f.directory, 'shots') }); t.after(() => peer.close());
  const reopened = createMatildaCompanion({ store: peer, env: f.env });
  assert.equal((await reopened.read('page')).music.canMute, true);
  const restored = (await reopened.act({ action: 'toggle-mute', page: 'page' })).music;
  assert.equal(restored.volume, 0.37);
  assert.equal(restored.muted, false);
  assert.equal(restored.status, before.status);
  assert.equal(restored.uri, before.uri);
  assert.equal(await fs.readFile(calls, 'utf8'), 'Volume:0.0\nVolume:0.37\n', 'no playback, track, or system volume command');
});

for (const volume of [null, 0]) test(`music without a known restorable volume (${volume}) cannot toggle mute`, async t => {
  const f = await fixture(t), { calls } = await startPlayer(t, f, { volume });
  await f.companion.act({ action: 'pin', page: 'page' });
  const music = (await f.companion.read('page')).music;
  assert.equal(music.canMute, false);
  assert.equal(music.muted, volume === 0);
  await assert.rejects(f.companion.act({ action: 'toggle-mute', page: 'page' }), /volume/i);
  await assert.rejects(fs.access(calls), { code: 'ENOENT' });
});

test('a refused player volume write reports failure without pausing playback', async t => {
  const f = await fixture(t), { calls } = await startPlayer(t, f, { writableVolume: false });
  await assert.rejects(f.companion.act({ action: 'toggle-mute', page: 'page' }), /volume|music controls/i);
  await assert.rejects(fs.access(calls), { code: 'ENOENT' });
});

// 29 Oct, Masih, with a YouTube video playing in Brave and Audacious paused: "no music is playing!" A browser tab is never
// Matilda's music, and her sound control (shown only while music plays) never touches it.
test('a browser playing a video is not music: the music player is chosen, and the browser is never written to', async t => {
  const f = await fixture(t);
  await startPlayer(t, f);
  const browser = await startPlayer(t, f, { name: 'brave.instance42', playing: true, writableVolume: false });
  await f.companion.act({ action: 'pin', page: 'page' });
  const music = (await f.companion.read('page')).music;
  assert.equal(music.player, 'org.mpris.MediaPlayer2.matilda_test');
  assert.equal(music.status, 'Paused', 'nothing plays, so the control stays hidden');
  await assert.rejects(fs.access(browser.calls), { code: 'ENOENT' });
});
