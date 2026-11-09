"use strict";
import type { Page, DrawingElement, Drawing } from "./love-spot-store-shared.cts";

const {
  FACE,
  FACE_SIDE,
  fail,
  record,
  trashFile,
  validate,
  merge: mergeImpl,
}: import("./love-spot-store-shared.cts").Shared = require("./love-spot-store-shared.cts");
const { directoryNames: names }: typeof import("./love-spot-watcher.cts") = require("./love-spot-watcher.cts");
const fs: typeof import("node:fs/promises") = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { paintElements, paintingSize, splitPainting } =
  require("./love-spot-painting.cts") as typeof import("./love-spot-painting.cts");
const { replyPortrait } = require("./matilda-face.cts");

async function changePageMoved(
  context: {
    lifecycle: () => Promise<{ since: number; kept: string[] }>;
    locked: <T>(action: () => Promise<T>) => Promise<T>;
    read: () => Promise<{ scene: Drawing; revision: string }>;
    samePage: (incoming: import("./love-spot-store-shared.cts").Page | undefined, current: Page) => void;
    pages: string;
    pageName: (name: unknown) => string;
    atomic: (file: string, data: string | Buffer<ArrayBufferLike>) => Promise<void>;
    lifecycleFile: string;
    pageFile: (name: unknown) => string;
    persist: (scene: Drawing) => Promise<{ scene: Drawing; revision: string }>;
    droppedEmpty: Map<string, string>;
  },
  value: unknown,
) {
  const { lifecycle, locked, read, samePage, pages, pageName, atomic, lifecycleFile, pageFile, persist, droppedEmpty } =
    context;
  const input = value as { action: string; name?: string; page?: Page };
  if (
    !record(input) ||
    !["new", "switch", "rename", "delete", "keep", "release", "clear"].includes(input.action) ||
    Object.keys(input).some(k => !["action", "name", "page"].includes(k)) ||
    (["delete", "keep", "release"].includes(input.action) && (input.name === undefined || !input.page)) ||
    (input.action === "clear" && (!input.page || input.name !== undefined))
  )
    throw fail("Invalid page action");
  // Delete all (Masih, 31 Oct: "so many chats here. I said there should be an option to delete them all"): every page but the
  // open one and the kept ones goes to the system trash, where it can be restored.
  if (input.action === "clear") {
    const life = await lifecycle();
    return locked(async () => {
      const current = await read();
      samePage(input.page, current.scene.page);
      for (const file of (await names(pages)).filter(n => n.endsWith(".excalidraw"))) {
        const name = file.slice(0, -11);
        if (name !== current.scene.page.name && !life.kept.includes(name)) await trashFile(path.join(pages, file));
      }
      return current;
    });
  }
  if (input.name !== undefined) pageName(input.name);
  if (["keep", "release", "rename", "delete"].includes(input.action)) {
    const life = await lifecycle(),
      current = (await read()).scene.page.name;
    const from = input.action === "rename" ? current : input.name,
      kept = new Set(life.kept);
    // A renamed page stays kept under its new name; the old name stays listed too, in case the rename is refused.
    if (input.action === "keep" || (input.action === "rename" && kept.has(from!)))
      kept.add((input.action === "keep" ? from : input.name)!);
    else if (input.action !== "rename") kept.delete(from!);
    await atomic(lifecycleFile, JSON.stringify({ since: life.since, kept: [...kept] }));
    if (input.action === "keep" || input.action === "release") return read();
  }
  return locked(async () => {
    const current = await read();
    if (input.page) samePage(input.page, current.scene.page);
    const listed = await names(pages);
    let name = input.name;
    if (input.action === "delete") {
      const file = pageFile(name);
      try {
        await fs.access(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException & { loveSpot?: boolean }).code === "ENOENT")
          throw fail("That page could not be found.", 404);
        throw e;
      }
      if (name !== current.scene.page.name) {
        await trashFile(file);
        return current;
      }
      await fs.mkdir(pages, { recursive: true });
      await atomic(file, JSON.stringify(current.scene));
      let index = new Set([...listed, `${current.scene.page.name}.excalidraw`]).size + 1;
      let nextName;
      do {
        nextName = `Page ${index++}`;
      } while (listed.includes(`${nextName}.excalidraw`) || nextName === name);
      await trashFile(file);
      return persist({
        type: "excalidraw",
        version: 2,
        source: "Love Spot",
        elements: [],
        files: {},
        appState: {},
        page: { name: nextName, session: randomUUID() },
      });
    }
    if (input.action === "new" && name === undefined) {
      let index = new Set([...listed, `${current.scene.page.name}.excalidraw`]).size + 1;
      do {
        name = `Page ${index++}`;
      } while (listed.includes(`${name}.excalidraw`));
    }
    pageName(name);
    if (name === current.scene.page.name && input.action !== "new") return current;
    if (input.action !== "switch" && (name === current.scene.page.name || listed.includes(`${name}.excalidraw`)))
      throw fail("A page with that name already exists.", 409);
    let scene;
    if (input.action === "switch") {
      try {
        scene = validate(JSON.parse(await fs.readFile(pageFile(name), "utf8")));
      } catch (e) {
        if ((e as NodeJS.ErrnoException & { loveSpot?: boolean }).code === "ENOENT")
          throw fail("That page could not be found.", 404);
        throw fail("That page could not be read. It has been left untouched.", 409);
      }
    } else
      scene =
        input.action === "new"
          ? { type: "excalidraw", version: 2, elements: [], files: {}, appState: {} }
          : current.scene;
    await fs.mkdir(pages, { recursive: true });
    // A page left with nothing on it is not kept (Masih, 5 Nov: "the pages are too many and piled up … delete the empty pages").
    const leaving = pageFile(current.scene.page.name);
    if (
      input.action !== "rename" &&
      !current.scene.elements.some(e => !e.isDeleted) &&
      !(await lifecycle()).kept.includes(current.scene.page.name)
    ) {
      await fs.rm(leaving, { force: true });
      droppedEmpty.set(current.scene.page.name, current.scene.page.session);
    } else await atomic(leaving, JSON.stringify(mergeImpl(current.scene, { elements: [] })));
    if (input.action === "rename") await fs.rename(pageFile(current.scene.page.name), pageFile(name));
    return persist(
      mergeImpl(
        {
          ...scene,
          page: { name: name!, session: input.action === "rename" ? current.scene.page.session : randomUUID() },
        },
        { elements: [] },
      ),
    );
  });
}

/** Writes the reply as a black note with her face to its left, and draws her painting (shapes from bridge/love-spot-painting.cts) beneath it; either may be missing. Face, note and painting are one group. */
async function replyMoved(
  context: {
    locked: <T>(action: () => Promise<T>) => Promise<T>;
    read: () => Promise<{ scene: Drawing; revision: string }>;
    samePage: (incoming: import("./love-spot-store-shared.cts").Page | undefined, current: Page) => void;
    persist: (scene: Drawing) => Promise<{ scene: Drawing; revision: string }>;
  },
  turnId: string,
  text: string,
  agentColor: (color: string, id?: string) => boolean,
  page?: Page,
  shapes: ReturnType<typeof splitPainting>["shapes"] = [],
  { preview = false } = {},
) {
  const { locked, read, samePage, persist } = context;
  if (typeof text === "string") text = text.replaceAll("💙", "❤️");
  const portrait = replyPortrait(text, preview);
  text = portrait.text;
  const note = typeof text === "string" && text.trim() !== "";
  if (!note && !shapes.length) return;
  return locked(async () => {
    const { scene } = await read(),
      id = note ? `love-reply-${turnId}` : `love-paint-${turnId}-0`;
    if (page) samePage(page, scene.page);
    const previousFace = scene.elements.find(e => e.id === `love-face-${turnId}`);
    if (previousFace && !previousFace.customData?.streaming) return;
    const live = scene.elements.filter(e => !e.isDeleted && !e.groupIds?.includes(`love-reply-group-${turnId}`));
    const anchor = live
      .filter(e => e.type === "text" && !agentColor(e.strokeColor, e.id))
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
    // Her note is set in Nunito, the board's friendly sans; its lines are cut at 38 columns, so its height is known without measuring text.
    const lines = (note ? text.trim() : "").split("\n").flatMap(line => {
      const chars = Array.from(line),
        wrapped = [];
      // Wide glyphs and expanded tabs need more room than Latin letters when Excalidraw restores the font.
      const columns = (char: string) => (char === "\t" ? 8 : char.codePointAt(0)! > 127 ? 2 : 1);
      while (chars.length) {
        let at = 0,
          used = 0;
        while (at < chars.length && used + columns(chars[at]!) <= 38) used += columns(chars[at++]!);
        if (at === chars.length) {
          wrapped.push(chars.join(""));
          break;
        }
        const space = chars.slice(0, at + 1).lastIndexOf(" ");
        if (space >= 8) at = space;
        wrapped.push(chars.splice(0, at).join(""));
        if (chars[0] === " ") chars.shift();
      }
      return wrapped.length ? wrapped : [""];
    });
    const noteHeight = note ? Math.max(1, lines.length) * 25 : 0,
      painted = paintingSize(shapes),
      gap = note && shapes.length ? 24 : 0;
    const width = FACE_SIDE + Math.max(note ? 480 : 0, painted.width),
      height = Math.max(FACE, noteHeight + gap + painted.height);
    const bounds = (e: DrawingElement) => {
      const angle = e.angle || 0,
        w = Math.abs(e.width * Math.cos(angle)) + Math.abs(e.height * Math.sin(angle)),
        h = Math.abs(e.width * Math.sin(angle)) + Math.abs(e.height * Math.cos(angle));
      return { x: e.x + e.width / 2 - w / 2, y: e.y + e.height / 2 - h / 2, width: w, height: h };
    };
    const a = previousFace
      ? { x: previousFace.x, y: previousFace.y - 40, height: 0 }
      : anchor
        ? bounds(anchor)
        : { x: 0, y: -40, height: 0 };
    const x = a.x,
      group = `love-reply-group-${turnId}`;
    let y = a.y + a.height + 40;
    for (;;) {
      const hits = live
        .map(bounds)
        .filter(
          e => x < e.x + e.width + 24 && x + width + 24 > e.x && y < e.y + e.height + 24 && y + height + 24 > e.y,
        );
      if (!hits.length) break;
      y = Math.max(...hits.map(e => e.y + e.height)) + 40;
    }
    const now = Date.now(),
      file = { id: `matilda-face-${portrait.expression}`, ...portrait.board, created: now, lastRetrieved: now };
    const drawn = {
      angle: 0,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [group],
      frameId: null,
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 0,
      isDeleted: false,
      boundElements: null,
      updated: now,
      link: null,
      locked: false,
    };
    const face: DrawingElement = {
      id: `love-face-${turnId}`,
      type: "image",
      fileId: file.id,
      x,
      y,
      width: FACE,
      height: FACE,
      ...drawn,
      strokeColor: "transparent",
      status: "saved",
      scale: [1, 1],
      crop: null,
    };
    const element = !note
      ? null
      : {
          id,
          type: "text",
          x: x + FACE_SIDE,
          y,
          width: 480,
          height: noteHeight,
          ...drawn,
          strokeColor: "#000000",
          fontSize: 20,
          fontFamily: 6,
          text: lines.join("\n"),
          originalText: text.trim(),
          textAlign: "left",
          verticalAlign: "top",
          containerId: null,
          autoResize: false,
          lineHeight: 1.25,
        };
    face.customData = { streaming: preview, expression: portrait.expression };
    const updated = [
      face,
      ...(element ? [element] : []),
      ...paintElements(shapes, { x: x + FACE_SIDE, y: y + noteHeight + gap }, turnId, group),
    ].map(e => {
      const previous = scene.elements.find(old => old.id === e.id);
      return previous ? { ...e, version: previous.version + 1, versionNonce: previous.versionNonce + 1 } : e;
    });
    await persist(mergeImpl(scene, { elements: updated, files: { [file.id]: file } }));
  });
}

/** Correct the ignored-origin bug only when the recorded geometry still matches the drawing. */
async function repairPaintingsMoved(
  context: {
    locked: <T>(action: () => Promise<T>) => Promise<T>;
    read: () => Promise<{ scene: Drawing; revision: string }>;
    persist: (scene: Drawing) => Promise<{ scene: Drawing; revision: string }>;
  },
  paintings: { turnId: string; shapes: ReturnType<typeof splitPainting>["shapes"] }[],
) {
  const { locked, read, persist } = context;
  if (!paintings.length) return;
  return locked(async () => {
    const { scene } = await read(),
      byId = new Map(scene.elements.map(e => [e.id, e])),
      updates: DrawingElement[] = [];
    for (const { turnId, shapes } of paintings) {
      const id = (index: number) => `love-paint-${turnId}-${index}`;
      if (
        scene.elements.some(
          e => e.id.startsWith(`love-paint-${turnId}-`) && Number(e.id.match(/-(\d+)$/)?.[1]) >= shapes.length,
        )
      )
        continue;
      const anchorIndex = shapes.findIndex((shape, index) => {
        const e = byId.get(id(index));
        return !["line", "arrow"].includes(shape.type) && e?.type === shape.type && !e!.isDeleted && !e!.angle;
      });
      if (anchorIndex < 0) continue;
      const anchor = byId.get(id(anchorIndex)),
        x = anchor!.x - shapes[anchorIndex]!.x,
        y = anchor!.y - shapes[anchorIndex]!.y;
      if (
        shapes.some((shape, index) => {
          if (["line", "arrow"].includes(shape.type)) return false;
          const e = byId.get(id(index));
          if (!e || e.isDeleted) return false;
          return (
            e.type !== shape.type ||
            e.angle ||
            Math.abs(e.x - (x + shape.x)) > 0.001 ||
            Math.abs(e.y - (y + shape.y)) > 0.001 ||
            (shape.type !== "text" &&
              (Math.abs(e.width - shape.width) > 0.001 || Math.abs(e.height - shape.height) > 0.001))
          );
        })
      )
        continue;
      shapes.forEach((shape, index) => {
        if (!shape.offsetX && !shape.offsetY) return;
        const e = byId.get(id(index));
        if (
          !e ||
          e.isDeleted ||
          e.angle ||
          e.type !== shape.type ||
          JSON.stringify(e.points) !== JSON.stringify((shape as typeof shape & { points?: [number, number][] }).points)
        )
          return;
        if (
          Math.abs(e.x - (x + shape.x - shape.offsetX!)) > 0.001 ||
          Math.abs(e.y - (y + shape.y - shape.offsetY!)) > 0.001
        )
          return;
        updates.push({
          ...e,
          x: x + shape.x,
          y: y + shape.y,
          version: e.version + 1,
          versionNonce: e.versionNonce + 1,
          updated: Date.now(),
        });
      });
    }
    if (updates.length) await persist(mergeImpl(scene, { elements: updates }));
  });
}

export declare const changePageMovedExport: typeof changePageMoved;
export declare const replyMovedExport: typeof replyMoved;
export declare const repairPaintingsMovedExport: typeof repairPaintingsMoved;
module.exports = { changePageMoved, replyMoved, repairPaintingsMoved };
