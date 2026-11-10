"use strict";
const fs: typeof import("node:fs/promises") = require("node:fs/promises");
const path = require("node:path");
const { directoryNames: names }: typeof import("./love-spot-watcher.cts") = require("./love-spot-watcher.cts");
const {
  fail,
  record,
  hash,
  trashFile,
  validate,
  merge: mergeImpl,
}: import("./love-spot-store-shared.cts").Shared = require("./love-spot-store-shared.cts");

// A closing editor may belong to the page another window just left.
// Flush only its text to that exact archived page, without switching anyone.
async function saveTextMoved(
  context: {
    pageName: (name: unknown) => string;
    locked: <T>(action: () => Promise<T>) => Promise<T>;
    read: () => Promise<{ scene: import("./love-spot-store-shared.cts").Drawing; revision: string }>;
    persist: (
      scene: import("./love-spot-store-shared.cts").Drawing,
    ) => Promise<{ scene: import("./love-spot-store-shared.cts").Drawing; revision: string }>;
    pageFile: (name: unknown) => string;
    droppedEmpty: Map<string, string>;
    samePage: (
      incoming: import("./love-spot-store-shared.cts").Page | undefined,
      current: import("./love-spot-store-shared.cts").Page,
    ) => void;
    pages: string;
    atomic: (file: string, data: string | Buffer<ArrayBufferLike>) => Promise<void>;
  },
  value: unknown,
) {
  const { pageName, locked, read, persist, pageFile, droppedEmpty, samePage, pages, atomic } = context;
  const incoming = validate(value);
  if (
    Object.keys(incoming).some(key => !["elements", "page"].includes(key)) ||
    incoming.elements.some(e => e.type !== "text") ||
    !record(incoming.page) ||
    typeof incoming.page.session !== "string" ||
    !incoming.page.session
  )
    throw fail("Invalid text draft");
  pageName(incoming.page.name);
  return locked(async () => {
    const current = await read();
    if (incoming.page.session === current.scene.page.session) return persist(mergeImpl(current.scene, incoming));
    let scene;
    try {
      scene = validate(JSON.parse(await fs.readFile(pageFile(incoming.page.name), "utf8")));
    } catch (e) {
      // A page left empty is not kept (changePage), yet words being typed on it in another window still belong there:
      // they bring it back. Only such a page: one deleted on purpose stays deleted, whatever arrives for it later.
      if (
        (e as NodeJS.ErrnoException & { loveSpot?: boolean }).code !== "ENOENT" ||
        droppedEmpty.get(incoming.page.name) !== incoming.page.session
      )
        throw fail("The original text page could not be read. Your draft is still local.", 409);
      droppedEmpty.delete(incoming.page.name);
      scene = {
        type: "excalidraw",
        version: 2,
        source: "Love Spot",
        elements: [],
        files: {},
        appState: {},
        page: incoming.page,
      };
    }
    samePage(incoming.page, scene.page);
    const merged = mergeImpl(scene, incoming),
      text = JSON.stringify(merged);
    await fs.mkdir(pages, { recursive: true });
    await atomic(pageFile(scene.page.name), text);
    return { scene: merged, revision: hash(text) };
  });
}

async function listPagesMoved(context: {
  lifecycle: () => Promise<{ since: number; kept: string[] }>;
  read: () => Promise<{ scene: import("./love-spot-store-shared.cts").Drawing; revision: string }>;
  locked: <T>(action: () => Promise<T>) => Promise<T>;
  pages: string;
  expiresAt: (modified: number, { since }: { since: number }) => number;
  pageName: (name: unknown) => string;
  pageFile: (name: unknown) => string;
  sceneFile: string;
}) {
  const { lifecycle, read, locked, pages, expiresAt, pageName, pageFile, sceneFile } = context;
  const life = await lifecycle(),
    now = Date.now(),
    current0 = (await read()).scene.page.name;
  await locked(async () => {
    for (const file of (await names(pages)).filter(n => n.endsWith(".excalidraw"))) {
      const name = file.slice(0, -11);
      if (name === current0 || life.kept.includes(name)) continue;
      const stat = await fs.stat(path.join(pages, file)).catch(() => null);
      if (stat?.isFile() && expiresAt(stat.mtimeMs, life) <= now) await trashFile(path.join(pages, file));
    }
  });
  const current = await read(),
    listed = new Map();
  for (const file of (await names(pages)).filter(n => n.endsWith(".excalidraw"))) {
    const name = file.slice(0, -11);
    try {
      pageName(name);
      const stat = await fs.stat(pageFile(name));
      if (stat.isFile()) listed.set(name, { name, modified: stat.mtimeMs });
    } catch (e) {
      if (
        !(e as NodeJS.ErrnoException & { loveSpot?: boolean }).loveSpot &&
        (e as NodeJS.ErrnoException & { loveSpot?: boolean }).code !== "ENOENT"
      )
        throw e;
    }
  }
  const modified = await fs
    .stat(sceneFile)
    .then(s => s.mtimeMs)
    .catch(e => {
      if ((e as NodeJS.ErrnoException & { loveSpot?: boolean }).code === "ENOENT") return Date.now();
      throw e;
    });
  listed.set(current.scene.page.name, { name: current.scene.page.name, modified });
  for (const page of listed.values())
    Object.assign(
      page,
      life.kept.includes(page.name) ? { kept: true } : { kept: false, expires: expiresAt(page.modified, life) },
    );
  return {
    current: current.scene.page, // Page 13 before Page 12 before Page 9: the order never depends on which page was touched last, which the person cannot see (Masih, 23 Oct: "the order of these don't make any sense").
    pages: [...listed.values()].sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })),
  };
}

export declare const saveTextMovedExport: typeof saveTextMoved;
export declare const listPagesMovedExport: typeof listPagesMoved;
module.exports = { saveTextMoved, listPagesMoved };
