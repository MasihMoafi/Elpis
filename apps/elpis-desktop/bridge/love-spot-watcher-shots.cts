"use strict";
import type { Settings } from "./love-spot-watcher.cts";
import type { Drawing, IncomingDrawing } from "./love-spot-store-shared.cts";
import type { Snapshot } from "./love-spot-watcher.cts";

export type Ports = {
  read(): Promise<Snapshot>;
  save(value: unknown): Promise<Snapshot>;
  persist(scene: Drawing): Promise<Snapshot>;
  locked<T>(action: () => Promise<T>): Promise<T>;
  atomic(file: string, data: string | Buffer): Promise<void>;
  matildaSettings(): Promise<Settings>;
  validate(value: unknown): Drawing;
  mergeImpl(current: Drawing, incoming: IncomingDrawing): Drawing;
  record(value: unknown): value is Record<string, unknown>;
  hash(value: string | Buffer): string;
  screenshotId(name: string, bytes: Buffer): string;
  trashFile(file: string): Promise<void>;
  fail(message: string, status?: number): Error;
  PNG: Buffer;
  pause(ms: number): Promise<unknown>;
};

async function importScreenshotMoved(
  context: {
    PNG: Buffer<ArrayBufferLike>;
    screenshotId: (name: string, bytes: Buffer<ArrayBufferLike>) => string;
    read: () => Promise<Snapshot>;
    validate: (value: unknown) => import("./love-spot-store-shared.cts").Drawing;
    persist: (scene: import("./love-spot-store-shared.cts").Drawing) => Promise<Snapshot>;
    mergeImpl: (
      current: import("./love-spot-store-shared.cts").Drawing,
      incoming: import("./love-spot-store-shared.cts").IncomingDrawing,
    ) => import("./love-spot-store-shared.cts").Drawing;
  },
  name: string,
  bytes: Buffer,
  dataURL?: string,
) {
  const { PNG, screenshotId, read, validate, persist, mergeImpl } = context;
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG)) return false;
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height) return false;
  const id = screenshotId(name, bytes),
    scale = Math.min(1, 1200 / width);
  {
    const { scene } = await read();
    if (scene.elements.some(e => e.id === id)) return true;
    const live = scene.elements.filter(e => !e.isDeleted),
      now = Date.now();
    const element = {
      id,
      type: "image",
      fileId: id,
      version: 1,
      versionNonce: 0,
      isDeleted: false,
      x: live.length ? Math.min(...live.map(e => e.x)) : 0,
      y: live.length ? Math.max(...live.map(e => e.y + e.height)) + 60 : 0,
      width: width * scale,
      height: height * scale,
      angle: 0,
      strokeColor: "transparent",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1,
      boundElements: null,
      updated: now,
      link: null,
      locked: false,
      status: "saved",
      scale: [1, 1],
      crop: null,
    };
    const file = {
      id,
      dataURL: dataURL ?? `data:image/png;base64,${bytes.toString("base64")}`,
      mimeType: "image/png",
      created: now,
      lastRetrieved: now,
    };
    validate({ elements: [], files: { [id]: file } });
    await persist(mergeImpl(scene, { elements: [element], files: { [id]: file } }));
  }
  return true;
}

async function chooseScreenshotMoved(
  context: {
    record: (value: unknown) => value is Record<string, unknown>;
    fail: (message: string, status?: number | undefined) => Error;
    pending: Map<string, { id: string; name: string; bytes: Buffer<ArrayBufferLike>; modified: number }>;
    locked: <T>(action: () => Promise<T>) => Promise<T>;
    screenshotChoices: () => Promise<Set<string>>;
    publishScreenshots: () => void;
    importScreenshot: (name: string, bytes: Buffer<ArrayBufferLike>, dataURL?: string | undefined) => Promise<boolean>;
    atomic: (file: string, data: string | Buffer<ArrayBufferLike>) => Promise<void>;
    choicesFile: string;
    read: () => Promise<Snapshot>;
  },
  choice: unknown,
) {
  const {
    record,
    fail,
    pending,
    locked,
    screenshotChoices,
    publishScreenshots,
    importScreenshot,
    atomic,
    choicesFile,
    read,
  } = context;
  if (!record(choice)) throw fail("Invalid screenshot choice");
  const { id, action } = choice;
  if (typeof id !== "string" || !["place", "dismiss"].includes(action as string))
    throw fail("Invalid screenshot choice");
  const shot = pending.get(id);
  if (!shot) throw fail("This screenshot has already left the tray.", 404);
  await locked(async () => {
    const choices = await screenshotChoices();
    if (choices.has(id)) {
      pending.delete(id);
      publishScreenshots();
      throw fail("This screenshot has already left the tray.", 404);
    }
    if (action !== "dismiss" && !(await importScreenshot(shot.name, shot.bytes, choice.dataURL as string | undefined)))
      throw fail("Invalid screenshot");
    choices.add(id);
    await atomic(choicesFile, JSON.stringify([...choices]));
  });
  pending.delete(id);
  publishScreenshots();
  return action === "dismiss" ? { dismissed: true } : read();
}

export declare const importScreenshotMovedExport: typeof importScreenshotMoved;
export declare const chooseScreenshotMovedExport: typeof chooseScreenshotMoved;
module.exports = { importScreenshotMoved, chooseScreenshotMoved };
