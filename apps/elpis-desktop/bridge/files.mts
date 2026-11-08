import fs from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "./validate.mts";
import { projectDirectory, skipped } from "./folders.mts";
import { ATTACHMENT_LIMITS, imageMime } from "./attachments.mts";
import { BoundedCache } from "./bounded-cache.mts";

const MAX_DEPTH = 4;
const MAX_ENTRIES = 2000;

/** Breadth-first: the project's files (never directories, dot entries or symlinks) as repository-relative paths, each
 * level in name order, so the shallow files survive the cap. */
async function walkFiles(cwd: string, maxDepth: number, maxEntries: number) {
  const found = [];
  let level = [""];
  for (let depth = 0; depth <= maxDepth && level.length && found.length < maxEntries; depth++) {
    const next = [];
    for (const relative of level) {
      const entries = await fs.readdir(path.join(cwd, relative), { withFileTypes: true }).catch(() => {
        if (!relative) throw new BridgeError("cwd cannot be read");
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
export async function listFiles(cwd: unknown) {
  const root = await projectDirectory(cwd);
  return { data: await walkFiles(root, MAX_DEPTH, MAX_ENTRIES) };
}

// The Files pane (components/files-pane.tsx): a tree of one folder at a time, a viewer and editor of one file, a
// search of the contents. Every path is checked to lie inside the project folder after links are followed.
const MAX_VIEW = 512 * 1024;
const TEXT_PAGE = 32 * 1024;
const MAX_PREVIEW = ATTACHMENT_LIMITS.fileBytes;
const MAX_DIRECTORY = 5000;
const MAX_SEARCHED = 256 * 1024;
const SEARCH_DEPTH = 8;
const SEARCH_FILES = 5000;
const SEARCH_ROWS = 200;
const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
const outside = (kind: string) => new BridgeError(`That ${kind} is outside the project.`);

/** Where `target` (relative to the project, or absolute) really is, if it is an existing file or folder inside the project. */
async function inside(cwd: unknown, target: unknown, kind: string, root = false) {
  const folder = await projectDirectory(cwd);
  if (typeof target !== "string" || target.length > 4096 || target.includes("\0") || (!target && !root))
    throw new BridgeError("path must name a path inside the project");
  const base = path.resolve(folder),
    top = await fs.realpath(folder),
    abs = path.resolve(base, target);
  const rel = within(abs, base) ? path.relative(base, abs) : within(abs, top) ? path.relative(top, abs) : null;
  if (rel === null) throw outside(kind);
  let real, info;
  try {
    real = await fs.realpath(abs);
    info = await fs.stat(real);
  } catch {
    // Masih, 24 Oct: "I should be able to open whatever I like here." An agent's link such as apps/elpis-desktop/SPEC.md
    // is often relative to a repository one folder below the chat's folder: open the newest such file there.
    const found = kind === "file" && !path.isAbsolute(target) ? await oneFolderDown(base, top, rel) : null;
    if (!found) throw new BridgeError(`No such ${kind} in ${base}: ${rel.split(path.sep).join("/") || "."}`, 404);
    return found;
  }
  if (!within(real, top)) throw outside(kind);
  if (kind === "file" ? !info.isFile() : !info.isDirectory()) throw new BridgeError(`Not a ${kind}.`);
  return { real, rel: rel.split(path.sep).join("/"), info };
}
/** The most recently changed `<folder>/<rel>` file among the project's direct subfolders, still inside the project. */
async function oneFolderDown(base: string, top: string, rel: string) {
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  let best = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const candidate = path.join(base, entry.name, rel);
    const real = await fs.realpath(candidate).catch(() => null),
      info = real ? await fs.stat(real).catch(() => null) : null;
    if (!real || !info?.isFile() || !within(real, top)) continue;
    if (!best || info.mtimeMs > best.info.mtimeMs)
      best = { real, rel: path.relative(base, candidate).split(path.sep).join("/"), info };
  }
  return best;
}
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || (a.name < b.name ? -1 : 1);

/** Read-only: the entries of one folder (`dir`, relative to the project; '' is the project itself), folders first, each
 * kind in name order. Links are listed and marked. `hidden` adds the dot entries (never .git). */
export async function listDirectory(cwd: unknown, dir: unknown = "", hidden = false) {
  const { real } = await inside(cwd, dir, "folder", true);
  const entries = await fs.readdir(real, { withFileTypes: true }).catch(() => {
    throw new BridgeError("This folder cannot be read.");
  });
  const found = [];
  for (const entry of entries) {
    if (skipped(entry.name, hidden)) continue;
    let kind: { isDirectory(): boolean; isFile(): boolean } | null = entry;
    if (entry.isSymbolicLink()) {
      kind = await fs.stat(path.join(real, entry.name)).catch(() => null);
      if (!kind) continue;
    }
    if (!kind.isDirectory() && !kind.isFile()) continue;
    found.push({ name: entry.name, dir: kind.isDirectory(), ...(entry.isSymbolicLink() ? { link: true } : {}) });
  }
  found.sort((a, b) => Number(b.dir) - Number(a.dir) || byName(a, b));
  return { data: found.slice(0, MAX_DIRECTORY) };
}

/** Only passive raster images and PDFs are served as assets. SVG stays source code. */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const previewType = (real: string) =>
  path.extname(real).toLowerCase() === ".pdf" ? "pdf" : IMAGE_TYPES[path.extname(real).toLowerCase()] ? "image" : null;
const assetMime = (real: string, bytes: Buffer) =>
  previewType(real) === "pdf"
    ? /^%PDF-\d\.\d\b/.test(bytes.subarray(0, 12).toString("ascii"))
      ? "application/pdf"
      : null
    : imageMime(bytes) === IMAGE_TYPES[path.extname(real).toLowerCase()]
      ? imageMime(bytes)
      : null;

/** Read-only metadata for documents/pictures, or text for the source editor. The asset route rechecks path and type. */
export type FileRead = {
  path: string;
  size: number;
  preview?: "pdf" | "image" | "text";
  tooLarge?: boolean;
  limit?: number;
  binary?: boolean;
  content?: string;
  mtimeMs?: number;
  page?: number;
  pages?: number;
  firstLine?: number;
};

/** Find a requested region without keeping its prefix. Each disk read and newline scan is one small page. */
const fileRegions = new BoundedCache<string, { key: string; pages: BoundedCache<number, { line: number }> }>(16);
async function fileRegion(
  handle: fs.FileHandle,
  real: string,
  info: { size: number; mtimeMs: number; ino: number },
  wantedPage: number,
  wantedLine?: number,
) {
  if (wantedPage === 0 && (!wantedLine || wantedLine === 1)) return { page: 0, firstLine: 1 };
  const key = `${info.ino}:${info.size}:${info.mtimeMs}`,
    known = fileRegions.get(real);
  const regionIndex = known?.key === key ? known : { key, pages: new BoundedCache<number, { line: number }>(128) };
  fileRegions.set(real, regionIndex);
  const exact = wantedLine === undefined ? regionIndex.pages.get(wantedPage) : undefined;
  if (exact) return { page: wantedPage, firstLine: exact.line };
  const buffer = Buffer.alloc(TEXT_PAGE);
  let line = 1,
    start = 0;
  for (const [page, point] of regionIndex.pages)
    if (
      page * TEXT_PAGE > start &&
      page * TEXT_PAGE < info.size &&
      (wantedLine === undefined ? page < wantedPage : point.line < wantedLine)
    ) {
      start = page * TEXT_PAGE;
      line = point.line;
    }
  for (let offset = start; offset < info.size; offset += TEXT_PAGE) {
    const page = offset / TEXT_PAGE,
      firstLine = line;
    regionIndex.pages.set(page, { line });
    if (wantedLine === undefined && page === wantedPage) return { page, firstLine };
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
    if (!bytesRead) break;
    for (let index = 0; index < bytesRead; index++)
      if (buffer[index] === 10) {
        line++;
        if (wantedLine !== undefined && line === wantedLine)
          return index + 1 === TEXT_PAGE && offset + bytesRead < info.size
            ? { page: page + 1, firstLine: line }
            : { page, firstLine };
      }
    if (offset + bytesRead < info.size) regionIndex.pages.set(page + 1, { line });
    if (wantedLine !== undefined && offset + bytesRead >= info.size) return { page, firstLine };
  }
  return { page: 0, firstLine: 1 };
}

export async function readFile(
  cwd: unknown,
  target: unknown,
  options: { page?: number | undefined; line?: number | undefined; mtimeMs?: number | undefined } = {},
): Promise<FileRead> {
  const { real, rel } = await inside(cwd, target, "file");
  const handle = await fs.open(real, "r").catch(() => {
    throw new BridgeError("This file cannot be read.");
  });
  try {
    const info = await handle.stat(),
      preview = previewType(real),
      limit = MAX_PREVIEW;
    if (preview && info.size > limit) return { path: rel, tooLarge: true, size: info.size, limit };
    if (options.mtimeMs !== undefined && options.mtimeMs !== info.mtimeMs)
      throw new BridgeError("This file changed on disk. Reopen it before reading another page.", 409);
    const paged = info.size > MAX_VIEW || options.page !== undefined;
    const pages = Math.max(1, Math.ceil(info.size / TEXT_PAGE));
    const requestedPage = options.page ?? 0;
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 0 || requestedPage >= pages)
      throw new BridgeError("Invalid file page.");
    if (options.line !== undefined && (!Number.isSafeInteger(options.line) || options.line < 1))
      throw new BridgeError("Invalid file line.");
    if (options.line !== undefined && options.page !== undefined)
      throw new BridgeError("Choose a file page or a line.");
    const { page, firstLine } =
      paged && !preview ? await fileRegion(handle, real, info, requestedPage, options.line) : { page: 0, firstLine: 1 };
    const start = paged ? Math.max(0, page * TEXT_PAGE - 3) : 0;
    const end = paged ? Math.min(info.size, (page + 1) * TEXT_PAGE) : info.size;
    if (start > 0) {
      const head = Buffer.alloc(8000);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      if (head.subarray(0, bytesRead).includes(0)) return { path: rel, binary: true, size: info.size };
    }
    // Three preceding bytes recover a code point crossing the page boundary. End on the same
    // code point on both pages, so concatenating pages reproduces the original UTF-8 exactly.
    const buffer = Buffer.alloc(preview ? Math.min(info.size, 8000) : end - start + (end < info.size ? 1 : 0));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, preview ? 0 : start);
    let from = paged && !preview ? page * TEXT_PAGE - start : 0,
      to = Math.min(bytesRead, end - start);
    const continuation = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;
    while (from > 0 && continuation(buffer[from])) from--;
    if (end < info.size) while (to > from && continuation(buffer[to])) to--;
    const bytes = buffer.subarray(from, to);
    if (preview)
      return assetMime(real, bytes)
        ? { path: rel, preview, size: info.size }
        : { path: rel, binary: true, size: info.size };
    const content = bytes.toString("utf8");
    if (bytes.subarray(0, 8000).includes(0) || !Buffer.from(content).equals(bytes))
      return { path: rel, binary: true, size: info.size };
    const after = await handle.stat();
    if (after.mtimeMs !== info.mtimeMs || after.size !== info.size)
      throw new BridgeError("This file changed on disk. Reopen it before reading another page.", 409);
    return {
      path: rel,
      ...(paged ? { preview: "text" as const, page, pages, firstLine } : {}),
      content,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

/** An authenticated preview response can contain no active HTML, SVG, script or arbitrary file bytes. */
export async function readFileAsset(cwd: unknown, target: unknown) {
  const { real, info } = await inside(cwd, target, "file");
  if (!previewType(real)) throw new BridgeError("This file has no document or image preview.");
  if (info.size > MAX_PREVIEW) throw new BridgeError("This preview is larger than 30 MB.", 413);
  const bytes = await fs.readFile(real).catch(() => {
    throw new BridgeError("This file cannot be read.");
  });
  if (bytes.length > MAX_PREVIEW) throw new BridgeError("This preview is larger than 30 MB.", 413);
  const mimeType = assetMime(real, bytes);
  if (!mimeType) throw new BridgeError("This file does not contain a supported document or image.");
  return { bytes, mimeType, name: path.basename(real) };
}

/** Saves `content` over an existing file, unless the file changed on disk since it was read (`mtimeMs`). It never creates a
 * file, follows no link out of the project and leaves .git alone. */
export async function writeFile(cwd: unknown, target: unknown, content: unknown, mtimeMs: unknown) {
  if (typeof content !== "string") throw new BridgeError("content must be text");
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs))
    throw new BridgeError("mtimeMs must be the time the file was read");
  const { real, rel, info } = await inside(cwd, target, "file");
  if (rel.split("/").includes(".git")) throw new BridgeError("Files inside .git cannot be saved.");
  if (info.mtimeMs !== mtimeMs)
    throw new BridgeError("This file changed on disk after it was opened. Reload it before saving.", 409);
  await fs.writeFile(real, content).catch(() => {
    throw new BridgeError("This file cannot be written.");
  });
  const saved = await fs.stat(real);
  return { path: rel, size: saved.size, mtimeMs: saved.mtimeMs };
}

/** Read-only: the lines of the project's text files that hold `query` (ignoring case), by path then line, at most 200. */
export async function searchFiles(cwd: unknown, query: unknown) {
  const root = await projectDirectory(cwd);
  if (typeof query !== "string" || !query || query.length > 200)
    throw new BridgeError("Search must contain 1 through 200 characters");
  const needle = query.toLowerCase(),
    rows = [];
  const files = (await walkFiles(root, SEARCH_DEPTH, SEARCH_FILES)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let truncated = false;
  for (let at = 0; at < files.length && !truncated; at += 16) {
    const texts = await Promise.all(
      files.slice(at, at + 16).map(async file => {
        const full = path.join(root, file),
          info = await fs.stat(full).catch(() => null);
        if (!info || info.size > MAX_SEARCHED) return null;
        const bytes = await fs.readFile(full).catch(() => null);
        return !bytes || bytes.subarray(0, 8000).includes(0) ? null : bytes.toString("utf8");
      }),
    );
    for (const [index, text] of texts.entries()) {
      if (text === null || !text.toLowerCase().includes(needle)) continue;
      for (const [number, line] of text.split(/\r?\n/).entries()) {
        const found = line.toLowerCase().indexOf(needle);
        if (found < 0) continue;
        if (rows.length === SEARCH_ROWS) {
          truncated = true;
          break;
        }
        const shown = line.trim(),
          from = Math.max(0, shown.toLowerCase().indexOf(needle) - 60);
        rows.push({
          path: files[at + index],
          line: number + 1,
          text: `${from ? "…" : ""}${shown.slice(from, from + 200)}${shown.length > from + 200 ? "…" : ""}`,
        });
      }
      if (truncated) break;
    }
  }
  return { data: rows, truncated };
}
