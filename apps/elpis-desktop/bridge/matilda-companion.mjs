import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { BridgeError, object, text } from './validate.mjs';
import { FACE_DATA_URL } from './matilda-face.cjs';
import { isAudioPath } from '../lib/audio-path.mjs';

const exec = promisify(execFile);
/** The system Python, which has dbus; a python3 earlier on PATH (conda) may not. */
export const PYTHON = existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
// MPRIS stays on the user's session bus. Python/dbus is optional: no dependency is installed,
// only an existing player is controlled, and a missing local service is returned as an ordinary explanation.
const MPRIS = `
import sys, json, re, dbus, subprocess, time
bus = dbus.SessionBus()
action, wanted, uri, volume = sys.argv[1:]
players = []
for name in sorted(str(n) for n in bus.list_names() if n.startswith('org.mpris.MediaPlayer2.')):
    try:
        obj = bus.get_object(name, '/org/mpris/MediaPlayer2')
        props = dbus.Interface(obj, 'org.freedesktop.DBus.Properties').GetAll('org.mpris.MediaPlayer2.Player', timeout=2)
        players.append((name, obj, props))
    except dbus.DBusException: pass
# A browser playing a video is not music: its tab is never Matilda's player (29 Oct, Masih, with YouTube playing in Brave:
# "no music is playing!").
players = [p for p in players if not re.search(r'brave|chrom|firefox|edge|opera|vivaldi|epiphany|plasma-browser|kdeconnect', p[0], re.I)]
if wanted:
    players = [p for p in players if p[0] == wanted]
else:
    playing = [p for p in players if str(p[2].get('PlaybackStatus')) == 'Playing']
    players = playing or players
if not players: raise Exception('Open your music player first; no compatible player is available.')
if len(players) != 1: raise Exception('Several music players are available. Leave one playing so Matilda can use the right one.')
name, obj, props = players[0]
player = dbus.Interface(obj, 'org.mpris.MediaPlayer2.Player')
if action == 'volume':
    if not props.get('CanControl', False) or 'Volume' not in props: raise Exception('This player does not support volume controls.')
    target = float(volume)
    if target < 0: raise Exception('This player volume is invalid.')
    dbus.Interface(obj, 'org.freedesktop.DBus.Properties').Set('org.mpris.MediaPlayer2.Player', 'Volume', dbus.Double(target), timeout=2)
    props = dbus.Interface(obj, 'org.freedesktop.DBus.Properties').GetAll('org.mpris.MediaPlayer2.Player', timeout=2)
    if abs(float(props.get('Volume', -1)) - target) > 0.000001: raise Exception('The player has not confirmed this volume change.')
elif action != 'read':
    if not props.get('CanControl', False): raise Exception('This player does not support music controls.')
    capability = {'play': 'CanPlay', 'pause': 'CanPause', 'next': 'CanGoNext', 'open': 'CanPlay', 'open-file': 'CanPlay'}[action]
    if not props.get(capability, False): raise Exception('This player does not support that action.')
    if action in ('open', 'open-file'):
        if action == 'open' and str(props.get('Metadata', {}).get('xesam:url', '')) == uri:
            player.Play(timeout=2)
        else:
            try: player.OpenUri(uri, timeout=2)
            except dbus.DBusException as error:
                if name != 'org.mpris.MediaPlayer2.audacious' or error.get_dbus_name() != 'org.freedesktop.DBus.Error.UnknownMethod': raise
                subprocess.run(['audacious', '--headless', '--play', uri], check=True, timeout=2, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 2
        while True:
            props = dbus.Interface(obj, 'org.freedesktop.DBus.Properties').GetAll('org.mpris.MediaPlayer2.Player', timeout=2)
            if str(props.get('Metadata', {}).get('xesam:url', '')) == uri and str(props.get('PlaybackStatus')) == 'Playing': break
            if time.monotonic() >= deadline: raise Exception('The player has not confirmed this request. Check playback before trying again.')
            time.sleep(0.05)
    elif action == 'play': player.Play(timeout=2)
    elif action == 'pause': player.Pause(timeout=2)
    elif action == 'next': player.Next(timeout=2)
    props = dbus.Interface(obj, 'org.freedesktop.DBus.Properties').GetAll('org.mpris.MediaPlayer2.Player', timeout=2)
meta = props.get('Metadata', {})
print(json.dumps({'player': name, 'title': str(meta.get('xesam:title', '')), 'artist': ', '.join(str(a) for a in meta.get('xesam:artist', [])), 'uri': str(meta.get('xesam:url', '')), 'status': str(props.get('PlaybackStatus', 'Stopped')), 'canPlay': bool(props.get('CanPlay')), 'canPause': bool(props.get('CanPause')), 'canNext': bool(props.get('CanGoNext')), 'volume': float(props['Volume']) if 'Volume' in props else None, 'canMute': bool(props.get('CanControl')) and 'Volume' in props}))
`;

export function createMatildaCompanion({ store, env = process.env }) {
  async function music(action = 'read', favorite, volume) {
    if (process.platform !== 'linux') throw new BridgeError('Music controls currently need a Linux MPRIS player.');
    try {
      const { stdout } = await exec(PYTHON, ['-c', MPRIS, action, favorite?.player ?? '', favorite?.uri ?? '', volume === undefined ? '' : String(volume)], { env, timeout: 6000, maxBuffer: 128 * 1024 });
      return JSON.parse(stdout);
    } catch (cause) {
      const detail = cause.stderr?.trim().split('\n').at(-1)?.replace(/^Exception: /, '');
      const explained = /^(Open your music player first|Several music players are available|This player does not support|The player has not confirmed)/.test(detail ?? '');
      throw new BridgeError(explained ? detail : cause.killed ? 'The player has not confirmed this request. Check playback before trying again.' : action === 'open' ? 'The player could not open your favorite. Check that the track is still available.' : action === 'open-file' ? 'The player could not open this audio file.' : 'Music controls are unavailable. Open your music player and try again.');
    }
  }
  async function state(page, track) {
    const saved = await store.companion(), pinned = saved.pinned.length > 0;
    let reason = '';
    if (pinned && !track) try { track = await music(); } catch (cause) { reason = cause.message; }
    if (track) {
      const volume = track.volume, previous = saved.musicVolumes?.[track.player];
      track = { ...track, muted: volume === 0, canMute: track.canMute && Number.isFinite(volume) && (volume > 0 || (volume === 0 && Number.isFinite(previous) && previous > 0)) };
    }
    return { pinned, favorite: saved.favorite, music: pinned || track ? track ?? null : null, reason, threadId: await store.chat(), face: pinned ? FACE_DATA_URL : undefined };
  }
  async function act(input) {
    object(input, input?.action === 'play-file' ? ['action', 'page', 'path'] : ['action', 'page']); text(input.page, 'page', 200);
    const { action, page } = input;
    if (action === 'pin' || action === 'unpin') {
      await store.companion(saved => ({ ...saved, pinned: action === 'pin' ? ['global'] : [] }));
      return state(page);
    }
    if (action === 'favorite') {
      const track = await music();
      if (!track.uri || !/^(file|https?):\/\//.test(track.uri)) throw new BridgeError('This track has no playable address to remember.');
      const { title, artist, uri, player } = track;
      await store.companion(saved => ({ ...saved, favorite: { title, artist, uri, player } }));
      return state(page, track);
    }
    if (action === 'play-favorite') {
      const { favorite } = await store.companion();
      if (!favorite) throw new BridgeError('Play a track and ask me to remember this song as your favorite first.');
      if (!/^(file|https?):\/\//.test(favorite.uri ?? '') || !/^org\.mpris\.MediaPlayer2\.[\w.-]+$/.test(favorite.player ?? '')) throw new BridgeError('The saved favorite is invalid. Remember the track again.');
      return state(page, await music('open', favorite));
    }
    if (action === 'play-file') {
      const file = text(input.path, 'audio path', 4096);
      if (!path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) throw new BridgeError('Choose an absolute audio file path.');
      if (!isAudioPath(file)) throw new BridgeError('Choose an audio file.');
      let resolved;
      try { resolved = await fs.realpath(file); if (!(await fs.stat(resolved)).isFile()) throw Error('Not a file'); }
      catch { throw new BridgeError('This audio file is unavailable.'); }
      return state(page, await music('open-file', { uri: pathToFileURL(resolved).href }));
    }
    if (action === 'toggle-mute') {
      const track = await music(), saved = await store.companion();
      const previous = saved.musicVolumes?.[track.player];
      if (!track.canMute || !Number.isFinite(track.volume) || track.volume < 0) throw new BridgeError('This player does not support volume controls.');
      if (track.volume === 0 && (!Number.isFinite(previous) || previous <= 0)) throw new BridgeError('This player is muted, but its previous volume is unknown. Unmute it in the music player first.');
      if (track.volume > 0) await store.companion(current => ({ ...current, musicVolumes: { ...current.musicVolumes, [track.player]: track.volume } }));
      return state(page, await music('volume', track, track.volume > 0 ? 0 : previous));
    }
    if (['play', 'pause', 'next'].includes(action)) return state(page, await music(action));
    throw new BridgeError('Unknown Matilda action.');
  }
  async function command(words, page) {
    if (typeof words !== 'string' || words.length > 180 || /[\n\r"“”]/.test(words)) return null;
    const said = words.trim().toLowerCase().replace(/^(?:hey\s+)?matilda[,!:\s]+/, '').replace(/^please\s+/, '').replace(/[.!]+$/, '').trim();
    const commands = new Map([
      ['pin yourself', 'pin'], ['pin yourself to this page', 'pin'], ['pin yourself to the page', 'pin'], ['pin you to the page', 'pin'], ['come here', 'pin'],
      ['unpin yourself', 'unpin'], ['unpin', 'unpin'], ['tuck yourself away', 'unpin'],
      ['play my favorite music', 'play-favorite'], ['play my favourite music', 'play-favorite'], ['play my favorites', 'play-favorite'], ['play my favorite', 'play-favorite'],
      ['open the music i love', 'play-favorite'], ['play the music i love', 'play-favorite'], ['open my favorite music', 'play-favorite'], ['open my favourite music', 'play-favorite'],
      ['remember this song as my favorite', 'favorite'], ['remember this track as my favorite', 'favorite'],
      ['pause music', 'pause'], ['pause the music', 'pause'], ['resume music', 'play'], ['resume the music', 'play'], ['next track', 'next'],
    ]);
    let action = commands.get(said);
    if (!action && said.startsWith('play ')) {
      const { favorite } = await store.companion();
      if (favorite?.title && said === `play ${favorite.title.toLowerCase()}`) action = 'play-favorite';
    }
    if (!action) return null;
    try {
      const result = await act({ action, page });
      const message = action === 'pin' ? 'Matilda is pinned at the top of every page.' : action === 'unpin' ? 'Matilda is unpinned everywhere. Music was left alone.' : action === 'favorite' ? `Remembered ${result.favorite.title} as your favorite.` : `${result.music?.status ?? 'Updated'}: ${result.music?.title || 'music'}.`;
      return { ok: true, message };
    } catch (cause) { return { ok: false, message: cause.message }; }
  }
  return { read: state, act, command };
}
