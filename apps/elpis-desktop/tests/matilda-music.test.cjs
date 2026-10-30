const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

// 30 Oct (C7): her sound control is an icon that shows only while music really plays. Here the music is a real MPRIS player
// on a private session bus, read by the real bridge; nothing about the music is faked.
const PLAYER = `
import sys, dbus, dbus.service, dbus.mainloop.glib
from gi.repository import GLib
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
name = dbus.service.BusName('org.mpris.MediaPlayer2.audacious', bus)
class Player(dbus.service.Object):
    status = 'Paused'; volume = 0.5
    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        return {'PlaybackStatus': self.status, 'CanControl': True, 'CanPlay': True, 'CanPause': True, 'CanGoNext': False, 'Volume': dbus.Double(self.volume), 'Metadata': dbus.Dictionary({'xesam:title': 'Masterpiece', 'xesam:artist': dbus.Array(['Linkin Park'], signature='s'), 'xesam:url': 'file:///music/masterpiece.m4a'}, signature='sv')}
    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='ssv', out_signature='')
    def Set(self, interface, prop, value):
        self.volume = float(value); print('volume ' + str(self.volume), flush=True)
player = Player(bus, '/org/mpris/MediaPlayer2')
def command(source, condition):
    word = sys.stdin.readline().strip()
    if word in ('Playing', 'Paused'): player.status = word
    return True
GLib.io_add_watch(sys.stdin, GLib.IO_IN, command)
print('ready', flush=True)
GLib.MainLoop().run()
`;

for (const colorScheme of ['light', 'dark']) test(`the sound control is an icon that shows only while music really plays (${colorScheme})`, { timeout: 90000 }, async t => {
  const bus = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [address] = await once(bus.stdout, 'data');
  const outer = process.env.DBUS_SESSION_BUS_ADDRESS; process.env.DBUS_SESSION_BUS_ADDRESS = String(address).trim();
  t.after(() => { bus.kill(); if (outer === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = outer; });
  const python = require('node:fs').existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
  const player = spawn(python, ['-u', '-c', PLAYER], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => player.kill());
  let said = ''; player.stdout.on('data', data => { said += data; });
  await once(player.stdout, 'data');
  const f = await loveSpotFixture({ colorScheme });
  t.after(() => f.close());
  const page = f.page;
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.locator('.app-menus').waitFor();
  await page.getByRole('button', { name: 'Pin Matilda', exact: true }).click();
  const presence = page.getByRole('region', { name: 'Pinned Matilda', exact: true }); await presence.waitFor();
  const sound = presence.getByRole('button', { name: /^(Mute|Unmute) music$/ });
  const refresh = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const evidence = path.join(process.env.ELPIS_SHOTS || require('node:os').tmpdir(), `matilda-music-${colorScheme}`);
  await presence.hover();
  assert.equal(await sound.count(), 0, 'the player is paused: no sound control');
  await page.screenshot({ path: `${evidence}-paused.png` });

  player.stdin.write('Playing\n'); await refresh();
  await sound.waitFor();
  assert.equal((await sound.innerText()).trim(), '', 'an icon, no word');
  assert.equal(await sound.locator('svg').count(), 1);
  await presence.hover();
  await page.screenshot({ path: `${evidence}-playing.png` });
  await sound.click();
  await presence.getByRole('button', { name: 'Unmute music', exact: true }).waitFor();
  assert.match(said, /volume 0\.0/, 'the real player was muted');
  assert.equal(await page.locator('p[role=alert]').count(), 0, 'no error is shown');
  await presence.hover();
  await page.screenshot({ path: `${evidence}-muted.png` });
  await presence.getByRole('button', { name: 'Unmute music', exact: true }).click();
  await presence.getByRole('button', { name: 'Mute music', exact: true }).waitFor();
  assert.match(said, /volume 0\.5/, 'and unmuted to where it was');

  player.stdin.write('Paused\n'); await refresh();
  await sound.waitFor({ state: 'detached' });
  assert.equal(await page.locator('p[role=alert]').count(), 0);
  assert.deepEqual(f.errors, []);
});
