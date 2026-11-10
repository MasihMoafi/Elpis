import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, object, text } from './validate.mts';
import { characterImage } from './character-image.mts';
import { BUILT_IN_THEMES } from '../lib/theme-palettes.ts';
import { CHARACTER_LIMITS, type CustomCharacter } from '../lib/custom-character-types.mts';

const ID = /^custom-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const builtin = (id: unknown): id is string => id === 'elpis' || BUILT_IN_THEMES.some(theme => theme.id === id);
const portraitUrl = (id: string) => `/api/characters/${id}/portrait`;
function characterId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !ID.test(id)) throw new BridgeError('Invalid character.');
}
function field(value: unknown, label: string, max: number) {
  const result = text(value, `character ${label}`, max).trim();
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result) || (label === 'name' && /[\r\n]/.test(result))) throw new BridgeError(`Invalid character ${label}.`);
  return result;
}
function profile(raw: Record<string, unknown>) {
  if (raw.themeId !== null && (typeof raw.themeId !== 'string' || !/^[\w-]{1,80}$/.test(raw.themeId))) throw new BridgeError('Choose an existing theme or keep your current theme.');
  return { name: field(raw.name, 'name', CHARACTER_LIMITS.name), description: field(raw.description, 'description', CHARACTER_LIMITS.description), personality: field(raw.personality, 'personality', CHARACTER_LIMITS.personality), themeId: raw.themeId as string | null };
}

/** The bridge owns durable custom characters and their private, normalized portraits. */
export function createCharacters(home: string) {
  const directory = path.join(home, 'characters'), manifest = path.join(directory, 'characters.json');
  let writing: Promise<unknown> = Promise.resolve();
  async function prepare() {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new BridgeError('Characters need a private folder owned by you.', 403);
    await fs.chmod(directory, 0o700);
  }
  async function readPrivate(file: string, limit: number) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > limit) throw new BridgeError('Character file is unsafe or too large.', 403);
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  async function list(): Promise<CustomCharacter[]> {
    await prepare();
    let bytes;
    try { bytes = await readPrivate(manifest, 1024 * 1024); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    try {
      const rows: unknown = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(rows) || rows.length > CHARACTER_LIMITS.count) throw new Error();
      const seen = new Set<string>();
      return rows.map((row: unknown) => {
        const raw = object(row, ['id', 'name', 'description', 'personality', 'themeId', 'portrait']) as Record<string, unknown>;
        characterId(raw.id); if (seen.has(raw.id)) throw new Error(); seen.add(raw.id);
        const portrait = object(raw.portrait, ['builtin', 'url']) as Record<string, unknown>;
        if (builtin(portrait.builtin) && Object.keys(portrait).length === 1) return { ...profile(raw), id: raw.id, portrait: { builtin: portrait.builtin } };
        if (portrait.url !== portraitUrl(raw.id) || Object.keys(portrait).length !== 1) throw new Error();
        return { ...profile(raw), id: raw.id, portrait: { url: portraitUrl(raw.id) } };
      });
    } catch { throw new BridgeError('Saved characters could not be read. Your files have been kept.', 500); }
  }
  async function atomic(file: string, bytes: string | Buffer) {
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  function mutate<T>(run: () => Promise<T>) {
    const task = writing.catch(() => {}).then(run); writing = task; return task;
  }
  async function save(input: unknown): Promise<CustomCharacter> {
    const raw = object(input, ['name', 'description', 'personality', 'themeId', 'portrait']) as Record<string, unknown>;
    const details = profile(raw), portrait = object(raw.portrait, ['builtin', 'dataUrl']) as Record<string, unknown>;
    if (Object.keys(portrait).length !== 1) throw new BridgeError('Choose one portrait.');
    const png = 'dataUrl' in portrait ? await characterImage(portrait.dataUrl) : null;
    if (!png && !builtin(portrait.builtin)) throw new BridgeError('Choose a built-in portrait.');
    return mutate(async () => {
      const rows = await list();
      if (rows.length >= CHARACTER_LIMITS.count) throw new BridgeError('Delete a character before saving another (maximum 100).');
      const id = `custom-${randomUUID()}`;
      const row: CustomCharacter = { ...details, id, portrait: png ? { url: portraitUrl(id) } : { builtin: portrait.builtin as string } };
      const file = path.join(directory, `${id}.png`);
      if (png) await atomic(file, png);
      try { await atomic(manifest, JSON.stringify([...rows, row])); }
      catch (error) { if (png) await fs.unlink(file).catch(() => {}); throw error; }
      return row;
    });
  }
  async function remove(id: unknown) {
    characterId(id);
    return mutate(async () => {
      const rows = await list();
      await atomic(manifest, JSON.stringify(rows.filter(row => row.id !== id)));
      await fs.unlink(path.join(directory, `${id}.png`)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      return { deleted: true };
    });
  }
  async function portrait(id: unknown) {
    characterId(id);
    const row = (await list()).find(row => row.id === id);
    if (!row || !('url' in row.portrait)) throw new BridgeError('Character portrait is unavailable.', 404);
    return readPrivate(path.join(directory, `${id}.png`), CHARACTER_LIMITS.portraitBytes);
  }
  async function personality(id: unknown, value: unknown) {
    characterId(id); const personality = field(value, 'personality', CHARACTER_LIMITS.personality);
    return mutate(async () => {
      const rows = await list(), current = rows.find(row => row.id === id);
      if (!current) throw new BridgeError('Character no longer exists.', 404);
      const character = { ...current, personality };
      await atomic(manifest, JSON.stringify(rows.map(row => row.id === id ? character : row)));
      return character;
    });
  }
  return { list, save, delete: remove, portrait, personality };
}
