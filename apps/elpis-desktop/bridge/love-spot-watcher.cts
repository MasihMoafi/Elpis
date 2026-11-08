const fs: typeof import("node:fs/promises") = require("node:fs/promises");
const { watch: watchFolder }: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const os: typeof import("node:os") = require("node:os");
const net: typeof import("node:net") = require("node:net");
const { randomUUID }: typeof import("node:crypto") = require("node:crypto");
import type { Drawing, IncomingDrawing } from "./love-spot-store.cts";
type Snapshot = {
  scene: Drawing;
  revision: string;
};
type Settings = {
  replies: boolean;
  model: string | null;
  provider: string | null;
};
async function namesImpl(dir: string) {
  try {
    return await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
const names = namesImpl;
type Ports = {
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
function createBoardWatcherImpl(
  directory: string,
  screenshots: string,
  {
    read,
    save,
    persist,
    locked,
    atomic,
    matildaSettings,
    validate,
    mergeImpl,
    record,
    hash,
    screenshotId,
    trashFile,
    fail,
    PNG,
    pause,
  }: Ports,
) {
  const inbox = path.join(directory, "inbox"),
    sceneFile = path.join(directory, "scene.excalidraw"),
    choicesFile = path.join(directory, ".screenshot-choices.json");
  const peerRoot = process.platform === "linux" ? "/tmp" : os.tmpdir();
  const peerDirectory = path.join(
    peerRoot,
    `elpis-shots-${process.getuid?.() ?? "user"}-${hash(path.resolve(directory)).slice(0, 16)}`,
  );
  const peerSocket = path.join(peerDirectory, `${randomUUID()}.sock`),
    sockets = new Set<import("node:net").Socket>();
  const trayError = "Love Spot could not sync its private screenshot trays between windows. It will retry.";
  let peerServer: import("node:net").Server | undefined,
    peerError: string | undefined,
    nextPeerAttempt = 0;
  // Folder watches wake tick(); a slow check covers a folder that cannot be watched yet (1 Nov: a 150 ms poll from app
  // start cost about 35 file operations a second while nobody drew).
  const watchers = new Map<string, import("node:fs").FSWatcher>();
  let wakeTimer: NodeJS.Timeout | undefined,
    again = false;
  let timer: NodeJS.Timeout | undefined,
    starting: Promise<void> | undefined,
    closed = false,
    running = false,
    seen: Set<string> | undefined,
    previous: string | undefined,
    sceneStamp: string | undefined,
    lastError: string | undefined,
    syncError: string | undefined;
  type StoreEvent =
    | {
        type: "screenshots";
        screenshots: ReturnType<typeof screenshotsList>;
      }
    | {
        type: "scene";
        scene: Drawing;
        revision: string;
      }
    | {
        type: "matilda";
        matilda: {
          replies: boolean;
          model: string | null;
          provider: string | null;
        };
      }
    | {
        type: "error";
        message: string;
      };
  const listeners = new Set<(event: StoreEvent) => void>();
  // Pending pixels stay in memory. Only explicit choices persist as opaque IDs,
  // so separate app processes cannot offer an already placed/dismissed screenshot.
  const pending = new Map<
    string,
    {
      id: string;
      name: string;
      bytes: Buffer;
      modified: number;
    }
  >();
  function track(socket: import("node:net").Socket) {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  }
  async function shareScreenshots() {
    peerServer = net.createServer(socket => {
      track(socket).setTimeout(5000, () => socket.destroy());
      socket.on("error", () => {});
      let input = "";
      socket.on("data", chunk => {
        input += chunk;
        if (input.length > 1024 * 1024) return socket.destroy();
        if (!input.includes("\n")) return;
        try {
          const ids = JSON.parse(input.trim());
          if (!Array.isArray(ids)) return socket.destroy();
          const known = new Set(ids),
            batch = [];
          let bytesInBatch = 0;
          for (const shot of pending.values()) {
            if (known.has(shot.id)) continue;
            if (batch.length && bytesInBatch + shot.bytes.length > 4 * 1024 * 1024) break;
            batch.push({ id: shot.id, name: shot.name, data: shot.bytes.toString("base64"), modified: shot.modified });
            bytesInBatch += shot.bytes.length;
          }
          socket.end(JSON.stringify(batch));
        } catch {
          socket.destroy();
        }
      });
    });
    await fs.mkdir(peerDirectory, { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve, reject) => {
      peerServer!.once("error", reject);
      peerServer!.listen(peerSocket, resolve);
    });
    peerServer.unref();
  }
  async function receiveScreenshots() {
    let peers;
    try {
      peers = (await names(peerDirectory)).filter(name => name.endsWith(".sock") && name !== path.basename(peerSocket));
      peerError = undefined;
    } catch {
      peerError = trayError;
      return false;
    }
    const replies = await Promise.all(
      peers.map(
        name =>
          new Promise<unknown[]>(resolve => {
            const socket = track(net.createConnection(path.join(peerDirectory, name)));
            let data = "",
              settled = false;
            const finish = (shots: unknown[]) => {
              if (!settled) {
                settled = true;
                resolve(shots);
                socket.destroy();
              }
            };
            socket.setTimeout(5000, () => finish([]));
            socket.on("error", () => finish([]));
            socket.once("connect", () => socket.write(`${JSON.stringify([...pending.keys()])}\n`));
            socket.on("data", chunk => {
              data += chunk;
            });
            socket.on("end", () => {
              try {
                const shots = JSON.parse(data);
                finish(Array.isArray(shots) ? shots : []);
              } catch {
                finish([]);
              }
            });
            socket.on("close", () => finish([]));
          }),
      ),
    );
    let added = false;
    for (const shots of replies)
      for (const shot of shots) {
        if (
          !record(shot) ||
          typeof shot.name !== "string" ||
          typeof shot.data !== "string" ||
          !Number.isFinite(shot.modified)
        )
          continue;
        const bytes = Buffer.from(shot.data, "base64");
        if (shot.id !== screenshotId(shot.name, bytes) || pending.has(shot.id)) continue;
        pending.set(shot.id, { id: shot.id, name: shot.name, bytes, modified: shot.modified as number });
        added = true;
      }
    return added;
  }
  async function ensureSharing() {
    if (closed || peerServer?.listening || Date.now() < nextPeerAttempt) return;
    nextPeerAttempt = Date.now() + 1000;
    try {
      await shareScreenshots();
      peerError = undefined;
    } catch {
      peerError = trayError;
    }
  }
  async function screenshotChoices() {
    try {
      const ids = JSON.parse(await fs.readFile(choicesFile, "utf8"));
      if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !/^shot-[a-f0-9]{32}$/.test(id)))
        throw fail("Screenshot choices could not be read. Please retry.", 409);
      return new Set(ids);
    } catch (e) {
      if (
        (
          e as NodeJS.ErrnoException & {
            loveSpot?: boolean;
          }
        ).code === "ENOENT"
      )
        return new Set();
      throw e;
    }
  }
  const screenshotsList = () =>
    [...pending.values()]
      .sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name))
      .map(({ id, name, bytes }) => ({ id, name, dataURL: `data:image/png;base64,${bytes.toString("base64")}` }));
  function publishScreenshots() {
    const update: StoreEvent = { type: "screenshots", screenshots: screenshotsList() };
    for (const listen of listeners) listen(update);
  }
  async function importScreenshot(name: string, bytes: Buffer, dataURL?: string) {
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
  async function chooseScreenshot(choice: unknown) {
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
      if (
        action !== "dismiss" &&
        !(await importScreenshot(shot.name, shot.bytes, choice.dataURL as string | undefined))
      )
        throw fail("Invalid screenshot");
      choices.add(id);
      await atomic(choicesFile, JSON.stringify([...choices]));
    });
    pending.delete(id);
    publishScreenshots();
    return action === "dismiss" ? { dismissed: true } : read();
  }
  function wake() {
    if (closed || wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      void tick();
    }, 25);
    wakeTimer.unref();
  }
  function watchFolders() {
    for (const folder of [directory, inbox, screenshots, peerDirectory]) {
      if (closed || watchers.has(folder)) continue;
      try {
        const watcher = watchFolder(folder, { persistent: false }, wake);
        watcher.on("error", () => {
          watcher.close();
          watchers.delete(folder);
        });
        watchers.set(folder, watcher);
      } catch {
        /* not there yet: the slow check retries */
      }
    }
  }
  async function tick() {
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await fs.mkdir(inbox, { recursive: true });
      watchFolders();
      for (const name of (await names(inbox)).filter(n => n.endsWith(".json")).sort()) {
        const file = path.join(inbox, name);
        let data;
        try {
          data = validate(JSON.parse(await fs.readFile(file, "utf8")));
        } catch {
          continue;
        }
        await save({ ...data, page: data.page ?? (await read()).scene.page });
        // Commit before consuming. Two readers may both merge the same inbox file; the merge is idempotent.
        await trashFile(file);
      }
      await ensureSharing();
      let added = peerServer?.listening ? await receiveScreenshots() : false;
      const choices = await screenshotChoices();
      for (const id of pending.keys())
        if (choices.has(id)) {
          pending.delete(id);
          added = true;
        }
      if (!seen) seen = new Set(await names(screenshots));
      for (const name of (await names(screenshots)).filter(n => /\.png$/i.test(n) && !seen!.has(n))) {
        let bytes;
        try {
          bytes = await fs.readFile(path.join(screenshots, name));
        } catch (e) {
          if (
            (
              e as NodeJS.ErrnoException & {
                loveSpot?: boolean;
              }
            ).code === "ENOENT"
          )
            continue;
          throw e;
        }
        // Wait for a complete PNG (IEND), so a notification while GNOME is writing retries.
        if (
          bytes.length < 24 ||
          !bytes.subarray(0, 8).equals(PNG) ||
          bytes.subarray(-8, -4).toString() !== "IEND" ||
          !bytes.readUInt32BE(16) ||
          !bytes.readUInt32BE(20)
        )
          continue;
        let stat;
        try {
          stat = await fs.stat(path.join(screenshots, name));
        } catch (e) {
          if (
            (
              e as NodeJS.ErrnoException & {
                loveSpot?: boolean;
              }
            ).code === "ENOENT"
          )
            continue;
          throw e;
        }
        const id = screenshotId(name, bytes);
        if (!choices.has(id)) {
          pending.set(id, { id, name, bytes, modified: stat.mtimeMs });
          added = true;
        }
        seen.add(name);
      }
      if (added) publishScreenshots();
      let stamp;
      try {
        const stat = await fs.stat(sceneFile);
        stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
      } catch (e) {
        if (
          (
            e as NodeJS.ErrnoException & {
              loveSpot?: boolean;
            }
          ).code !== "ENOENT"
        )
          throw e;
        stamp = "missing";
      }
      if (stamp !== sceneStamp || previous === undefined) {
        const current = await read();
        sceneStamp = stamp;
        if (current.revision !== previous) {
          previous = current.revision;
          for (const listen of listeners) listen({ type: "scene", ...current });
        }
      }
      if (peerError && lastError !== peerError)
        for (const listen of listeners) listen({ type: "error", message: peerError });
      lastError = peerError;
      syncError = peerError;
    } catch (e) {
      syncError = (
        e as NodeJS.ErrnoException & {
          loveSpot?: boolean;
        }
      ).loveSpot
        ? (
            e as NodeJS.ErrnoException & {
              loveSpot?: boolean;
            }
          ).message
        : "Love Spot could not sync the drawing.";
      if (
        lastError !==
        (
          e as NodeJS.ErrnoException & {
            loveSpot?: boolean;
          }
        ).message
      ) {
        lastError = (
          e as NodeJS.ErrnoException & {
            loveSpot?: boolean;
          }
        ).message;
        for (const listen of listeners) listen({ type: "error", message: syncError });
      }
    } finally {
      running = false;
      if (again) {
        again = false;
        wake();
      }
    }
  }
  async function start() {
    if (!starting)
      starting = (async () => {
        // Sample once at server startup, never again when a view subscribes.
        // A temporarily unavailable folder retries its baseline in tick().
        try {
          seen = new Set(await names(screenshots));
        } catch {}
        await ensureSharing();
        syncError = peerError;
        // One check at once: a later process takes the pending screenshots other Elpis windows already hold.
        if (!closed) {
          watchFolders();
          wake();
          timer = setInterval(() => void tick(), 2000);
          timer.unref();
        }
      })();
    return starting;
  }
  async function watch(listen: (event: StoreEvent) => void) {
    await start();
    listeners.add(listen);
    try {
      listen({ type: "scene", ...(await read()) });
    } catch (e) {
      listen({
        type: "error",
        message: (
          e as NodeJS.ErrnoException & {
            loveSpot?: boolean;
          }
        ).message,
      });
    }
    listen({ type: "screenshots", screenshots: screenshotsList() });
    try {
      listen({ type: "matilda", matilda: await matildaSettings() });
    } catch {
      /* the setting is read again on its next change */
    }
    if (syncError) listen({ type: "error", message: syncError });
    return () => {
      listeners.delete(listen);
    };
  }
  async function close() {
    closed = true;
    clearInterval(timer);
    timer = undefined;
    clearTimeout(wakeTimer);
    listeners.clear();
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    if (starting) await starting.catch(() => {});
    while (running) await pause(10);
    for (const socket of sockets) socket.destroy();
    if (peerServer?.listening) await new Promise<void>(resolve => peerServer!.close(() => resolve()));
    // Temporary peer cleanup must not prevent the app from quitting.
    await fs.unlink(peerSocket).catch(() => {});
    await fs.rmdir(peerDirectory).catch(() => {});
    pending.clear();
  }
  return {
    start,
    watch,
    close,
    screenshotsList,
    chooseScreenshot,
    publishMatilda(settings: Settings) {
      for (const listen of listeners) listen({ type: "matilda", matilda: settings });
    },
  };
}
export declare const createBoardWatcher: typeof createBoardWatcherImpl;
export declare const directoryNames: typeof namesImpl;
module.exports = { createBoardWatcher: createBoardWatcherImpl, directoryNames: namesImpl };
