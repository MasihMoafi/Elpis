import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
export const ownedSkill = skill => ['user', 'repo'].includes(skill.scope) && !skill.plugin;
const inside = (root, target) => { const rel = path.relative(root, target); return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); };
const missing = error => { if (error.code !== 'ENOENT') throw error; return null; };

/** The engine lists SKILL.md files, not roots: the parent of each listed skill folder is its known root.
 * Only exact listed files can be removed; resolving both ends prevents symlinks escaping that root. */
async function skillFolder(file, skills) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || file.split(path.sep).includes('..') || path.basename(file) !== 'SKILL.md') throw Error('Invalid skill path');
  const skill = skills.find(skill => skill.path === file);
  if (!skill) throw Error('That skill is not listed');
  if (!ownedSkill(skill)) throw Error('This skill is protected; it can be turned off instead');
  const folder = path.dirname(file), root = path.dirname(folder);
  const [realRoot, realFolder, realFile, folderStat, fileStat] = await Promise.all([
    fs.realpath(root), fs.realpath(folder), fs.realpath(file), fs.lstat(folder), fs.lstat(file),
  ]);
  if (folderStat.isSymbolicLink() || fileStat.isSymbolicLink() || !folderStat.isDirectory() || !fileStat.isFile()
      || !inside(realRoot, realFolder) || path.dirname(realFile) !== realFolder
      || (process.getuid && folderStat.uid !== process.getuid())) throw Error('Skill folder must be owned and inside its known root, without symbolic links');
  if (skills.some(other => other.path !== file && inside(folder, other.path) && !ownedSkill(other))) throw Error('Skill folder contains other listed skills that are protected');
  return { skill, folder, realRoot, realFolder, folderStat };
}

/** Local freedesktop Trash, including per-volume trash. Undo uses only the .trashinfo produced by gio for this
 * exact operation; no renderer-supplied restore path. Entries remain in Trash after the short Undo expires. */
export class SkillTrash {
  #pending = new Map();
  constructor({ env = process.env, now = Date.now } = {}) { this.env = env; this.now = now; }
  async #locations(folder) {
    const locations = [path.join(this.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'Trash')];
    let mount = folder, stat = await fs.stat(mount);
    while (path.dirname(mount) !== mount) {
      const parent = path.dirname(mount), next = await fs.stat(parent);
      if (stat.dev !== next.dev) break;
      mount = parent; stat = next;
    }
    const uid = process.getuid?.();
    if (uid !== undefined) locations.push(path.join(mount, `.Trash-${uid}`), path.join(mount, '.Trash', String(uid)));
    return [...new Set(locations)];
  }
  async #entries(locations, folder) {
    const entries = [];
    for (const location of locations) {
      for (const name of (await fs.readdir(path.join(location, 'info')).catch(missing)) ?? []) {
        if (!name.endsWith('.trashinfo')) continue;
        const info = path.join(location, 'info', name), raw = await fs.readFile(info, 'utf8').catch(missing);
        const encoded = raw?.match(/^Path=(.*)$/m)?.[1];
        if (!encoded) continue;
        let original; try { original = decodeURIComponent(encoded); } catch { continue; }
        // Per-volume Trash paths may be relative to the mount root.
        if (!path.isAbsolute(original)) original = path.resolve(location.includes(`${path.sep}.Trash${path.sep}`) ? path.dirname(path.dirname(location)) : path.dirname(location), original);
        if (original === folder) entries.push({ info, file: path.join(location, 'files', name.slice(0, -10)) });
      }
    }
    return entries;
  }
  async delete(file, skills) {
    for (const [token, entry] of this.#pending) if (entry.until <= this.now()) this.#pending.delete(token);
    const target = await skillFolder(file, skills), locations = await this.#locations(target.folder);
    const previous = new Set((await this.#entries(locations, target.folder)).map(entry => entry.info));
    // Check again immediately before invoking gio; the renderer cannot substitute a different folder.
    const checked = await skillFolder(file, skills);
    if (checked.realFolder !== target.realFolder || checked.folderStat.ino !== target.folderStat.ino) throw Error('Skill folder changed; refresh Ledger');
    try { await run('gio', ['trash', '--', target.folder], { env: this.env, timeout: 10000 }); }
    catch { throw Error('Could not move skill to Trash'); }
    const entry = (await this.#entries(locations, target.folder)).find(entry => !previous.has(entry.info));
    if (!entry) throw Error('Skill moved to Trash, but its Undo information could not be read');
    const token = randomUUID();
    // Allow transport/listing latency beyond the renderer's four-second notice.
    this.#pending.set(token, { ...entry, ...target, until: this.now() + 60000 });
    return { name: target.skill.name, token };
  }
  async undo(token) {
    const entry = this.#pending.get(token);
    if (!entry || entry.until <= this.now()) { this.#pending.delete(token); throw Error('Undo has expired; the skill is still in Trash'); }
    if (await fs.lstat(entry.folder).catch(missing)) throw Error('Skill folder already exists; cannot restore over it');
    if (await fs.realpath(path.dirname(entry.folder)) !== entry.realRoot) throw Error('Skill root changed; cannot restore');
    const stored = await fs.lstat(entry.file);
    if (!stored.isDirectory() || stored.isSymbolicLink() || stored.ino !== entry.folderStat.ino) throw Error('Skill in Trash changed; cannot restore');
    // Restore from the recorded freedesktop trash entry (works without a GVfs trash:// daemon).
    await fs.rename(entry.file, entry.folder);
    await fs.unlink(entry.info); // Consume only the restored item's Trash metadata.
    this.#pending.delete(token);
  }
}
