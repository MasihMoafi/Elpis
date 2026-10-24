import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './client.mjs';
import { projectDirectory, skipped } from './folders.mjs';
import { ATTACHMENT_LIMITS, imageMime } from './attachments.mjs';

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
const MAX_PREVIEW = ATTACHMENT_LIMITS.fileBytes;
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
  try { real = await fs.realpath(abs); info = await fs.stat(real); }
  catch {
    // Masih, 24 Oct: "I should be able to open whatever I like here." An agent's link such as apps/elpis-desktop/SPEC.md
    // is often relative to a repository one folder below the chat's folder: open the newest such file there.
    const found = kind === 'file' && !path.isAbsolute(target) ? await oneFolderDown(base, top, rel) : null;
    if (!found) throw new BridgeError(`No such ${kind} in ${base}: ${rel.split(path.sep).join('/') || '.'}`, 404);
    return found;
  }
  if (!within(real, top)) throw outside(kind);
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw new BridgeError(`Not a ${kind}.`);
  return { real, rel: rel.split(path.sep).join('/'), info };
}
/** The most recently changed `<folder>/<rel>` file among the project's direct subfolders, still inside the project. */
async function oneFolderDown(base, top, rel) {
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  let best = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const candidate = path.join(base, entry.name, rel);
    const real = await fs.realpath(candidate).catch(() => null), info = real && await fs.stat(real).catch(() => null);
    if (!info?.isFile() || !within(real, top)) continue;
    if (!best || info.mtimeMs > best.info.mtimeMs) best = { real, rel: path.relative(base, candidate).split(path.sep).join('/'), info };
  }
  return best;
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

/** Only passive raster images and PDFs are served as assets. SVG stays source code. */
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const previewType = real => path.extname(real).toLowerCase() === '.pdf' ? 'pdf' : IMAGE_TYPES[path.extname(real).toLowerCase()] ? 'image' : null;
const assetMime = (real, bytes) => previewType(real) === 'pdf'
  ? /^%PDF-\d\.\d\b/.test(bytes.subarray(0, 12).toString('ascii')) ? 'application/pdf' : null
  : imageMime(bytes) === IMAGE_TYPES[path.extname(real).toLowerCase()] ? imageMime(bytes) : null;

/** Read-only metadata for documents/pictures, or text for the source editor. The asset route rechecks path and type. */
export async function readFile(cwd, target) {
  const { real, rel, info } = await inside(cwd, target, 'file');
  const preview = previewType(real), limit = preview ? MAX_PREVIEW : MAX_VIEW;
  if (info.size > limit) return { path: rel, tooLarge: true, size: info.size, ...(preview ? { limit } : {}) };
  const bytes = await fs.readFile(real).catch(() => { throw new BridgeError('This file cannot be read.'); });
  if (bytes.length > limit) return { path: rel, tooLarge: true, size: bytes.length, ...(preview ? { limit } : {}) };
  if (preview) return assetMime(real, bytes) ? { path: rel, preview, size: bytes.length } : { path: rel, binary: true, size: bytes.length };
  const content = bytes.toString('utf8');
  if (bytes.subarray(0, 8000).includes(0) || !Buffer.from(content).equals(bytes)) return { path: rel, binary: true, size: info.size };
  return { path: rel, content, size: info.size, mtimeMs: info.mtimeMs };
}

/** An authenticated preview response can contain no active HTML, SVG, script or arbitrary file bytes. */
export async function readFileAsset(cwd, target) {
  const { real, info } = await inside(cwd, target, 'file');
  if (!previewType(real)) throw new BridgeError('This file has no document or image preview.');
  if (info.size > MAX_PREVIEW) throw new BridgeError('This preview is larger than 30 MB.', 413);
  const bytes = await fs.readFile(real).catch(() => { throw new BridgeError('This file cannot be read.'); });
  if (bytes.length > MAX_PREVIEW) throw new BridgeError('This preview is larger than 30 MB.', 413);
  const mimeType = assetMime(real, bytes);
  if (!mimeType) throw new BridgeError('This file does not contain a supported document or image.');
  return { bytes, mimeType, name: path.basename(real) };
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
