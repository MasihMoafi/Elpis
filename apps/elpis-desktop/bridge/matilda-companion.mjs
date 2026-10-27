import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BridgeError, object, text } from './validate.mjs';
import { FACE_DATA_URL } from './matilda-face.cjs';

const exec = promisify(execFile);
// MPRIS stays on the user's session bus. Python/dbus is optional: no dependency is installed,
// no player is launched, and a missing local service is returned as an ordinary explanation.
const MPRIS = `
import sys, json, dbus
bus = dbus.SessionBus()
action, wanted, uri = sys.argv[1:]
players = []
for name in sorted(str(n) for n in bus.list_names() if n.startswith('org.mpris.MediaPlayer2.')):
    try:
        obj = bus.get_object(name, '/org/mpris/MediaPlayer2')
        props = dbus.Interface(obj, 'org.freedesktop.DBus.Properties').GetAll('org.mpris.MediaPlayer2.Player', timeout=2)
        players.append((name, obj, props))
    except dbus.DBusException: pass
if wanted:
    players = [p for p in players if p[0] == wanted]
else:
    playing = [p for p in players if str(p[2].get('PlaybackStatus')) == 'Playing']
    players = playing or players
if not players: raise Exception('Open your music player first; no compatible player is available.')
if len(players) != 1: raise Exception('Several music players are available. Leave one playing so Matilda can use the right one.')
name, obj, props = players[0]
player = dbus.Interface(obj, 'org.mpris.MediaPlayer2.Player')
if action != 'read':
    if not props.get('CanControl', False): raise Exception('This player does not support music controls.')
    capability = {'play': 'CanPlay', 'pause': 'CanPause', 'next': 'CanGoNext', 'open': 'CanPlay'}[action]
    if not props.get(capability, False): raise Exception('This player does not support that action.')
    if action == 'open': player.OpenUri(uri, timeout=2)
    elif action == 'play': player.Play(timeout=2)
    elif action == 'pause': player.Pause(timeout=2)
    elif action == 'next': player.Next(timeout=2)
    props = dbus.Interface(obj, 'org.freedesktop.DBus.Properties').GetAll('org.mpris.MediaPlayer2.Player', timeout=2)
meta = props.get('Metadata', {})
print(json.dumps({'player': name, 'title': str(meta.get('xesam:title', '')), 'artist': ', '.join(str(a) for a in meta.get('xesam:artist', [])), 'uri': str(meta.get('xesam:url', '')), 'status': str(props.get('PlaybackStatus', 'Stopped')), 'canPlay': bool(props.get('CanPlay')), 'canPause': bool(props.get('CanPause')), 'canNext': bool(props.get('CanGoNext'))}))
`;

export function createMatildaCompanion({ store, env = process.env }) {
  async function music(action = 'read', favorite) {
    if (process.platform !== 'linux') throw new BridgeError('Music controls currently need a Linux MPRIS player.');
    try {
      const { stdout } = await exec('python3', ['-c', MPRIS, action, favorite?.player ?? '', favorite?.uri ?? ''], { env, timeout: 6000, maxBuffer: 128 * 1024 });
      return JSON.parse(stdout);
    } catch (cause) {
      const detail = cause.stderr?.trim().split('\n').at(-1)?.replace(/^Exception: /, '');
      const explained = /^(Open your music player first|Several music players are available|This player does not support)/.test(detail ?? '');
      throw new BridgeError(explained ? detail : cause.killed ? 'The player has not confirmed this request. Check playback before trying again.' : action === 'open' ? 'The player could not open your favorite. Check that the track is still available.' : 'Music controls are unavailable. Open your music player and try again.');
    }
  }
  async function state(page, track) {
    const saved = await store.companion(), pinned = saved.pinned.includes(page);
    let reason = '';
    if (pinned && !track) try { track = await music(); } catch (cause) { reason = cause.message; }
    return { pinned, favorite: saved.favorite, music: pinned || track ? track ?? null : null, reason, face: pinned ? FACE_DATA_URL : undefined };
  }
  async function act(input) {
    object(input, ['action', 'page']); text(input.page, 'page', 200);
    const { action, page } = input;
    if (action === 'pin' || action === 'unpin') {
      await store.companion(saved => ({ ...saved, pinned: action === 'pin' ? [...new Set([...saved.pinned, page])] : saved.pinned.filter(id => id !== page) }));
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
      const message = action === 'pin' ? 'Matilda is pinned on this page.' : action === 'unpin' ? 'Matilda is unpinned. Music was left alone.' : action === 'favorite' ? `Remembered ${result.favorite.title} as your favorite.` : `${result.music?.status ?? 'Updated'}: ${result.music?.title || 'music'}.`;
      return { ok: true, message };
    } catch (cause) { return { ok: false, message: cause.message }; }
  }
  return { read: state, act, command };
}
