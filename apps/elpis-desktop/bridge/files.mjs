import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './client.mjs';
import { projectDirectory, skipped } from './folders.mjs';

const MAX_DEPTH = 4;
const MAX_ENTRIES = 2000;

/** Breadth-first: the project's files (never directories, dot entries or symlinks) as repository-relative paths, each
 * level in name order, so the shallow files survive the cap. */
async function walkFiles(cwd, maxDepth, maxEntries) {
  const found = [];
  let level = [''];
  for (let depth = 0; depth <= maxDepth && level.length && found.length < maxEntries; depth++) {
    const next = [];
    for (const relative of level) {
      const entries = await fs.readdir(path.join(cwd, relative), { withFileTypes: true }).catch(() => {
        if (!relative) throw new BridgeError('cwd cannot be read');
        return [];
      });
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (skipped(entry.name)) continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isFile()) found.push(child);
        else if (entry.isDirectory()) next.push(child);
      }
    }
    level = next;
  }
  return found.slice(0, maxEntries);
}

/** Read-only: the project's files as repository-relative paths, the @-mention picker's list and the Files pane's find. */
export async function listFiles(cwd) {
  await projectDirectory(cwd);
  return { data: await walkFiles(cwd, MAX_DEPTH, MAX_ENTRIES) };
}

// The Files pane (components/files-pane.tsx): a tree of one folder at a time, a viewer and editor of one file, a
// search of the contents. Every path is checked to lie inside the project folder after links are followed.
const MAX_VIEW = 512 * 1024;
const MAX_DIRECTORY = 5000;
const MAX_SEARCHED = 256 * 1024;
const SEARCH_DEPTH = 8;
const SEARCH_FILES = 5000;
const SEARCH_ROWS = 200;
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const outside = kind => new BridgeError(`That ${kind} is outside the project.`);

/** Where `target` (relative to the project, or absolute) really is, if it is an existing file or folder inside the project. */
async function inside(cwd, target, kind, root = false) {
  await projectDirectory(cwd);
  if (typeof target !== 'string' || target.length > 4096 || target.includes('\0') || (!target && !root)) throw new BridgeError('path must name a path inside the project');
  const base = path.resolve(cwd), top = await fs.realpath(cwd), abs = path.resolve(base, target);
  const rel = within(abs, base) ? path.relative(base, abs) : within(abs, top) ? path.relative(top, abs) : null;
  if (rel === null) throw outside(kind);
  let real, info;
  try { real = await fs.realpath(abs); info = await fs.stat(real); } catch { throw new BridgeError(`This ${kind} is unavailable.`, 404); }
  if (!within(real, top)) throw outside(kind);
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw new BridgeError(`Not a ${kind}.`);
  return { real, rel: rel.split(path.sep).join('/'), info };
}
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || (a.name < b.name ? -1 : 1);

/** Read-only: the entries of one folder (`dir`, relative to the project; '' is the project itself), folders first, each
 * kind in name order. Links are listed and marked. `hidden` adds the dot entries (never .git). */
export async function listDirectory(cwd, dir = '', hidden = false) {
  const { real } = await inside(cwd, dir, 'folder', true);
  const entries = await fs.readdir(real, { withFileTypes: true }).catch(() => { throw new BridgeError('This folder cannot be read.'); });
  const found = [];
  for (const entry of entries) {
    if (skipped(entry.name, hidden)) continue;
    let kind = entry;
    if (entry.isSymbolicLink()) { kind = await fs.stat(path.join(real, entry.name)).catch(() => null); if (!kind) continue; }
    if (!kind.isDirectory() && !kind.isFile()) continue;
    found.push({ name: entry.name, dir: kind.isDirectory(), ...(entry.isSymbolicLink() ? { link: true } : {}) });
  }
  found.sort((a, b) => Number(b.dir) - Number(a.dir) || byName(a, b));
  return { data: found.slice(0, MAX_DIRECTORY) };
}

/** Read-only: one file's text. A binary file, one that is not UTF-8 or one over 512 KB is reported, not sent. */
export async function readFile(cwd, target) {
  const { real, rel, info } = await inside(cwd, target, 'file');
  if (info.size > MAX_VIEW) return { path: rel, tooLarge: true, size: info.size };
  const bytes = await fs.readFile(real).catch(() => { throw new BridgeError('This file cannot be read.'); });
  const content = bytes.toString('utf8');
  if (bytes.subarray(0, 8000).includes(0) || !Buffer.from(content).equals(bytes)) return { path: rel, binary: true, size: info.size };
  return { path: rel, content, size: info.size, mtimeMs: info.mtimeMs };
}

/** Saves `content` over an existing file, unless the file changed on disk since it was read (`mtimeMs`). It never creates a
 * file, follows no link out of the project and leaves .git alone. */
export async function writeFile(cwd, target, content, mtimeMs) {
  if (typeof content !== 'string') throw new BridgeError('content must be text');
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) throw new BridgeError('mtimeMs must be the time the file was read');
  const { real, rel, info } = await inside(cwd, target, 'file');
  if (rel.split('/').includes('.git')) throw new BridgeError('Files inside .git cannot be saved.');
  if (info.mtimeMs !== mtimeMs) throw new BridgeError('This file changed on disk after it was opened. Reload it before saving.', 409);
  await fs.writeFile(real, content).catch(() => { throw new BridgeError('This file cannot be written.'); });
  const saved = await fs.stat(real);
  return { path: rel, size: saved.size, mtimeMs: saved.mtimeMs };
}

/** Read-only: the lines of the project's text files that hold `query` (ignoring case), by path then line, at most 200. */
export async function searchFiles(cwd, query) {
  await projectDirectory(cwd);
  if (typeof query !== 'string' || !query || query.length > 200) throw new BridgeError('Search must contain 1 through 200 characters');
  const needle = query.toLowerCase(), rows = [];
  const files = (await walkFiles(cwd, SEARCH_DEPTH, SEARCH_FILES)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let truncated = false;
  for (let at = 0; at < files.length && !truncated; at += 16) {
    const texts = await Promise.all(files.slice(at, at + 16).map(async file => {
      const full = path.join(cwd, file), info = await fs.stat(full).catch(() => null);
      if (!info || info.size > MAX_SEARCHED) return null;
      const bytes = await fs.readFile(full).catch(() => null);
      return !bytes || bytes.subarray(0, 8000).includes(0) ? null : bytes.toString('utf8');
    }));
    for (const [index, text] of texts.entries()) {
      if (text === null || !text.toLowerCase().includes(needle)) continue;
      for (const [number, line] of text.split(/\r?\n/).entries()) {
        const found = line.toLowerCase().indexOf(needle);
        if (found < 0) continue;
        if (rows.length === SEARCH_ROWS) { truncated = true; break; }
        const shown = line.trim(), from = Math.max(0, shown.toLowerCase().indexOf(needle) - 60);
        rows.push({ path: files[at + index], line: number + 1, text: `${from ? '…' : ''}${shown.slice(from, from + 200)}${shown.length > from + 200 ? '…' : ''}` });
      }
      if (truncated) break;
    }
  }
  return { data: rows, truncated };
}
