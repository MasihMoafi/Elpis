"use strict";
const fs: typeof import("node:fs/promises") = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { newer: newerImpl } = require("./love-spot-order.cts") as typeof import("./love-spot-order.cts");

// Shared by the bridge and the standalone window. Every writer takes the same directory lock,
// rereads the drawing, and atomically writes the union, including deletion tombstones.
export type DrawingElement = {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  isDeleted?: boolean;
  fileId?: string | null;
  groupIds?: string[];
  strokeColor: string;
  updated?: number;
  text?: string | undefined;
  originalText?: string | undefined;
  points?: [number, number][];
  customData?: { streaming?: boolean; [key: string]: unknown };
  [key: string]: unknown;
};

export type DrawingFile = {
  id: string;
  dataURL: string;
  mimeType: string;
  loveSpotResized?: boolean;
  [key: string]: unknown;
};

export type Page = { name: string; session: string };

export type Drawing = {
  elements: DrawingElement[];
  files: Record<string, DrawingFile>;
  appState: Record<string, unknown>;
  page: Page;
  [key: string]: unknown;
};

export type IncomingDrawing = {
  elements: DrawingElement[];
  files?: Record<string, DrawingFile>;
  appState?: Record<string, unknown>;
  page?: Page;
  [key: string]: unknown;
};

const FACE = 96,
  FACE_SIDE = FACE + 12;

const exec = promisify(execFile);

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status, loveSpot: true });

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function trashFile(file: string) {
  await exec("gio", ["trash", file]).catch(async (e: NodeJS.ErrnoException) => {
    try {
      await fs.access(file);
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException & { loveSpot?: boolean }).code === "ENOENT") return;
      throw missing;
    }
    if ((e as NodeJS.ErrnoException & { loveSpot?: boolean }).code === "ENOENT") {
      const trash = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), "Trash/files");
      await fs.mkdir(trash, { recursive: true });
      await fs.rename(file, path.join(trash, `${Date.now()}-${path.basename(file)}`));
      return;
    }
    throw e;
  });
}

function validate(scene: unknown): Drawing {
  if (
    !record(scene) ||
    !Array.isArray(scene.elements) ||
    (scene.files !== undefined && !record(scene.files)) ||
    (scene.appState !== undefined && !record(scene.appState))
  )
    throw fail("Invalid drawing");
  for (const e of scene.elements) {
    if (
      !record(e) ||
      typeof e.id !== "string" ||
      !e.id ||
      typeof e.type !== "string" ||
      !Number.isInteger(e.version) ||
      (e.version as number) < 1 ||
      !Number.isInteger(e.versionNonce) ||
      !["x", "y", "width", "height"].every(key => Number.isFinite(e[key]))
    )
      throw fail("Invalid drawing element");
  }
  for (const [id, file] of Object.entries(scene.files ?? {})) {
    if (
      !record(file) ||
      file.id !== id ||
      typeof file.dataURL !== "string" ||
      !/^data:image\/(png|jpeg|webp|gif|svg\+xml);/.test(file.dataURL) ||
      typeof file.mimeType !== "string"
    )
      throw fail("Invalid drawing image");
  }
  return scene as Drawing;
}

function mergeImpl(current: Drawing, incoming: IncomingDrawing) {
  const elements = new Map(current.elements.map(e => [e.id, e]));
  for (const e of incoming.elements)
    if (!elements.has(e.id) || newerImpl(e, elements.get(e.id)!)) elements.set(e.id, e);
  const files = { ...incoming.files, ...current.files };
  // A normalized image replaces its original, but a stale window cannot put the large bytes back.
  for (const [id, file] of Object.entries(incoming.files ?? {})) {
    if (
      !files[id] ||
      (file.loveSpotResized && !files[id].loveSpotResized) ||
      (file.loveSpotResized === files[id].loveSpotResized && file.dataURL.length < files[id].dataURL.length)
    )
      files[id] = file;
  }
  const referenced = new Set([...elements.values()].filter(e => !e.isDeleted && e.fileId).map(e => e.fileId));
  return {
    ...current,
    type: "excalidraw",
    version: 2,
    source: "Love Spot",
    elements: [...elements.values()],
    appState: { ...current.appState, ...incoming.appState },
    files: Object.fromEntries(Object.entries(files).filter(([id]) => referenced.has(id))),
  };
}

const exported = {
  FACE: FACE,
  FACE_SIDE: FACE_SIDE,
  exec: exec,
  pause: pause,
  fail: fail,
  record: record,
  hash: hash,
  trashFile: trashFile,
  validate: validate,
  merge: mergeImpl,
};
export type Shared = typeof exported;
module.exports = exported;
