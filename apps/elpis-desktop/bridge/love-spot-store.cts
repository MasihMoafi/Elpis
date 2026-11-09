const { saveTextMoved, listPagesMoved }: { saveTextMoved: typeof import("./love-spot-store-pages.cts").saveTextMovedExport; listPagesMoved: typeof import("./love-spot-store-pages.cts").listPagesMovedExport } = require("./love-spot-store-pages.cts");
export type { Page, DrawingElement, DrawingFile, Drawing, IncomingDrawing } from "./love-spot-store-shared.cts";
import type { Page, Drawing } from "./love-spot-store-shared.cts";
const { changePageMoved, replyMoved, repairPaintingsMoved }: { changePageMoved: typeof import("./love-spot-store-reply.cts").changePageMovedExport; replyMoved: typeof import("./love-spot-store-reply.cts").replyMovedExport; repairPaintingsMoved: typeof import("./love-spot-store-reply.cts").repairPaintingsMovedExport } = require("./love-spot-store-reply.cts");
const { pause, fail, record, hash, trashFile, validate, merge: mergeImpl }: import("./love-spot-store-shared.cts").Shared = require("./love-spot-store-shared.cts");
const {
  createBoardWatcher,
  directoryNames: names,
}: typeof import("./love-spot-watcher.cts") = require("./love-spot-watcher.cts");
const fs: typeof import("node:fs/promises") = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { newer: newerImpl } = require("./love-spot-order.cts") as typeof import("./love-spot-order.cts");
const { paintElements, splitPainting } =
  require("./love-spot-painting.cts") as typeof import("./love-spot-painting.cts");
const { BOARD_FACE, OLD_BOARD_FACES, OLD_BOARD_SHOTS, replyPortrait } = require("./matilda-face.cts");
const WELCOME_SHAPES = splitPainting(
  "```excalidraw\n" +
    JSON.stringify([
      {
        type: "text",
        x: 0,
        y: 0,
        text: "Welcome to Love Spot",
        fontSize: 28,
        fontFamily: 5,
        textAlign: "center",
        strokeColor: "#000000",
      },
      {
        type: "line",
        x: 144,
        y: 68,
        points: [
          [0, 15],
          [2, 8],
          [7, 3],
          [14, 0],
          [22, 1],
          [29, 7],
          [31, 13],
          [34, 7],
          [41, 1],
          [49, 0],
          [56, 3],
          [60, 8],
          [62, 14],
          [61, 20],
          [57, 25],
          [31, 45],
          [5, 25],
          [1, 20],
          [0, 15],
        ],
        strokeColor: "#e03131",
        strokeWidth: 2.5,
        roughness: 1,
      },
    ]) +
    "\n```",
).shapes;
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const screenshotId = (name: string, bytes: Buffer) =>
  `shot-${hash(Buffer.concat([Buffer.from(name), bytes])).slice(0, 32)}`;
// Masih, 7 Nov: the Love Spot app and Love Spot inside Elpis are separate, boards included ("Separate boards"). The app
// (LOVE_SPOT_APP, desktop/main-profile.cts) keeps the board it always had; inside Elpis the board lives in the Elpis home.
const defaultBoard = () =>
  process.env.EXCALIDRAW_LOCAL_DIR ||
  (process.env.LOVE_SPOT_APP === "1"
    ? path.join(os.homedir(), ".local/share/excalidraw-local")
    : path.join(process.env.ELPIS_HOME || path.join(os.homedir(), ".elpis-next"), "love-spot"));
function createLoveSpotImpl({
  directory = defaultBoard(),
  screenshots = process.env.EXCALIDRAW_SCREENSHOTS_DIR || path.join(os.homedir(), "Pictures/Screenshots"),
} = {}) {
  const sceneFile = path.join(directory, "scene.excalidraw"),
    lock = path.join(directory, ".scene-lock"),
    inbox = path.join(directory, "inbox"),
    pages = path.join(directory, "pages");
  // Same-user local IPC keeps private trays available to a later dock process
  // without journaling screenshot names or pixels to the board directory.
  // Linux limits Unix socket paths to 107 bytes. TMPDIR can be a long isolated test/app home,
  // so keep these tiny private sockets under the short system temp root.
  async function read() {
    let text;
    try {
      text = await fs.readFile(sceneFile, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException & { loveSpot?: boolean }).code !== "ENOENT") throw e;
    }
    try {
      const scene = (
        text === undefined
          ? { type: "excalidraw", version: 2, elements: [], files: {}, appState: {} }
          : validate(JSON.parse(text))
      ) as Drawing;
      scene.elements = scene.elements.map(element => {
        if (element.type !== "text" || !element.id.startsWith("love-reply-")) return element;
        const redHearts = (value: string | undefined) =>
          typeof value === "string" ? value.replaceAll("💙", "❤️") : value;
        return {
          ...element,
          strokeColor: "#000000",
          text: redHearts(element.text),
          originalText: redHearts(element.originalText),
        };
      });
      // Existing replies share this preset asset; an older face is replaced, a custom portrait kept.
      if (OLD_BOARD_FACES.includes(scene.files["matilda-face"]?.dataURL)) {
        scene.files["matilda-face"] = { ...scene.files["matilda-face"], ...BOARD_FACE };
      }
      // Each reply's expression face moves to its raster picture the same way.
      for (const [id, file] of Object.entries(scene.files)) {
        const expression = id.startsWith("matilda-face-") && OLD_BOARD_SHOTS[file?.dataURL];
        if (expression) scene.files[id] = { ...file, ...replyPortrait(`<!--matilda:${expression}-->`).board };
      }
      if (!scene.page) {
        const pageFiles = await names(pages),
          existing = new Set(pageFiles);
        let name = "Current page",
          suffix = 2;
        if (text === undefined && !pageFiles.some(file => file.endsWith(".excalidraw"))) {
          scene.elements = paintElements(WELCOME_SHAPES, { x: -174, y: -56 }, "welcome", undefined, 0);
        }
        while (existing.has(`${name}.excalidraw`)) name = `Current page ${suffix++}`;
        scene.page = { name, session: "legacy" };
      }
      pageName(scene.page.name);
      if (typeof scene.page.session !== "string" || !scene.page.session) throw fail("Invalid page");
      return { scene, revision: hash(text ?? "") };
    } catch {
      throw fail("The drawing could not be read. It has been left untouched.", 409);
    }
  }
  function pageName(name: unknown): string {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name !== name.trim() ||
      name.length > 100 ||
      /[/\\\x00-\x1f]/.test(name) ||
      /^\.+$/.test(name)
    )
      throw fail("Use a page name of 1–100 characters without slashes.");
    return name;
  }
  const pageFile = (name: unknown) => path.join(pages, `${pageName(name)}.excalidraw`);
  function samePage(incoming: Page | undefined, current: Page) {
    if ((incoming && incoming.session !== current.session) || (!incoming && current.session !== "legacy"))
      throw fail("The page changed in another window. Your old drawing was not added to it.", 409);
  }
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    await fs.mkdir(inbox, { recursive: true });
    // A process crash leaves an empty lock. The pid is part of the owner file; only a dead
    // owner (or an empty lock older than 30 seconds) can be recovered.
    const started = Date.now();
    while (true) {
      try {
        await fs.mkdir(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException & { loveSpot?: boolean }).code !== "EEXIST") throw e;
        let directoryHandle;
        try {
          // Pin Linux cleanup to the directory whose owner was read. Another
          // process may release it and acquire a new lock at the same path.
          if (process.platform === "linux") directoryHandle = await fs.open(lock, "r");
          const ownerFile = directoryHandle ? `/proc/self/fd/${directoryHandle.fd}/owner` : path.join(lock, "owner");
          try {
            const owner = Number(await fs.readFile(ownerFile, "utf8"));
            // A crash between creating the owner file and writing its pid leaves it empty, and process.kill(0, 0)
            // reads as alive forever. After the same grace as an empty lock, the claimant whose rename wins removes it.
            if (
              (!Number.isSafeInteger(owner) || owner <= 0) &&
              Date.now() - (await fs.stat(ownerFile)).mtimeMs > 30000
            ) {
              const claim = `${ownerFile}.${process.pid}.${randomUUID()}`;
              await fs.rename(ownerFile, claim);
              await fs.unlink(claim);
              await fs.rmdir(lock);
            } else {
              try {
                process.kill(owner, 0);
              } catch (probe) {
                if ((probe as NodeJS.ErrnoException & { loveSpot?: boolean }).code === "ESRCH") {
                  await fs.unlink(ownerFile);
                  await fs.rmdir(lock);
                }
              }
            }
          } catch (probe) {
            if ((probe as NodeJS.ErrnoException & { loveSpot?: boolean }).code === "ENOENT") {
              const stat = directoryHandle ? await directoryHandle.stat() : await fs.stat(lock);
              if (Date.now() - stat.mtimeMs > 30000) {
                // Claim the empty generation before removing it. A handle to
                // an already removed directory cannot create this owner file.
                const claim = await fs.open(ownerFile, "wx");
                try {
                  await claim.writeFile(String(process.pid));
                } finally {
                  await claim.close();
                }
                await fs.unlink(ownerFile);
                await fs.rmdir(lock);
              }
            }
          }
        } catch (probe) {
          if (
            !["ENOENT", "EEXIST", "ENOTEMPTY"].includes((probe as NodeJS.ErrnoException & { loveSpot?: boolean }).code!)
          )
            throw probe;
        } finally {
          await directoryHandle?.close();
        }
        if (Date.now() - started > 5000) throw fail("The drawing is busy. Please retry.", 503);
        await pause(10);
      }
    }
    try {
      await fs.writeFile(path.join(lock, "owner"), String(process.pid));
      return await action();
    } finally {
      await fs.unlink(path.join(lock, "owner"));
      await fs.rmdir(lock);
    }
  }
  async function atomic(file: string, data: string | Buffer) {
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, data);
      await fs.rename(temp, file);
    } finally {
      await fs.unlink(temp).catch(e => {
        if ((e as NodeJS.ErrnoException & { loveSpot?: boolean }).code !== "ENOENT") throw e;
      });
    }
  }
  const droppedEmpty = new Map<string, string>(); // page name → session of each page left empty and so not kept (changePage, saveText)
  async function persist(scene: Drawing) {
    const text = JSON.stringify(scene);
    await fs.mkdir(pages, { recursive: true });
    await atomic(pageFile(scene.page.name), text);
    await atomic(sceneFile, text);
    return { scene, revision: hash(text) };
  }
  async function save(value: unknown) {
    const incoming = validate(value);
    return locked(async () => {
      const current = await read();
      samePage(incoming.page, current.scene.page);
      const scene = mergeImpl(current.scene, incoming),
        text = JSON.stringify(scene);
      if (hash(text) !== current.revision) return persist(scene);
      return { scene, revision: hash(text) };
    });
  }
  // A closing editor may belong to the page another window just left.
  // Flush only its text to that exact archived page, without switching anyone.
  async function saveText(value: unknown) {
    return saveTextMoved({ pageName, locked, read, persist, pageFile, droppedEmpty, samePage, pages, atomic }, value);
  }
  // Page lifecycle (Masih, 31 Oct: "pages have accumulated; things shouldn't just stay here permanently"). A page he has not
  // marked Keep goes to the system trash, where it can be restored, after PAGE_DAYS untouched; the page he is on never does.
  // Pages from before this rule count from the day it first ran, so nothing old leaves without a week shown in the page menu.
  const lifecycleFile = path.join(directory, ".page-lifecycle.json"),
    PAGE_DAYS = 7,
    DAY = 24 * 60 * 60 * 1000;
  async function lifecycle() {
    try {
      const value = JSON.parse(await fs.readFile(lifecycleFile, "utf8"));
      if (record(value) && Number.isFinite(value.since) && Array.isArray(value.kept))
        return { since: value.since as number, kept: value.kept.filter(name => typeof name === "string") };
    } catch (e) {
      if ((e as NodeJS.ErrnoException & { loveSpot?: boolean }).code !== "ENOENT" && !(e instanceof SyntaxError))
        throw e;
    }
    const fresh = { since: Date.now(), kept: [] };
    await atomic(lifecycleFile, JSON.stringify(fresh));
    return fresh;
  }
  const expiresAt = (modified: number, { since }: { since: number }) => Math.max(modified, since) + PAGE_DAYS * DAY;
  // One Matilda (Masih, 31 Oct: "what happens with Matilda in the chat isn't the same as what happens on the board"): whether
  // she answers, and with which model, is one setting here that the board, the small chat and her chat tab all read.
  // Each app has its own board, so each keeps its own choice (7 Nov).
  const matildaFile = path.join(directory, ".matilda-settings.json");
  async function matildaSettings(update?: Record<string, unknown>) {
    let value: Record<string, unknown> = {};
    try {
      const saved = JSON.parse(await fs.readFile(matildaFile, "utf8"));
      if (record(saved)) value = saved;
    } catch (e) {
      if ((e as NodeJS.ErrnoException & { loveSpot?: boolean }).code !== "ENOENT" && !(e instanceof SyntaxError))
        throw e;
    }
    if (update) {
      value = { ...value, ...update };
      for (const key of Object.keys(value)) if (value[key] === null) delete value[key];
      // A new board (Love Spot inside Elpis since 7 Nov) may get her model before anything is drawn.
      await fs.mkdir(directory, { recursive: true });
      await atomic(matildaFile, JSON.stringify(value));
    }
    const settings = {
      replies: value.replies !== false,
      model: typeof value.model === "string" ? value.model : null,
      provider: typeof value.provider === "string" ? value.provider : null,
    };
    // Every open window hears a change on the Love Spot stream it already has open (no extra connection per window).
    if (update) watcher.publishMatilda(settings);
    return settings;
  }
  async function listPages() {
    return listPagesMoved({ lifecycle, read, locked, pages, expiresAt, pageName, pageFile, sceneFile });
  }
  async function changePage(value: unknown) {
    return changePageMoved({ lifecycle, locked, read, samePage, pages, pageName, atomic, lifecycleFile, pageFile, persist, droppedEmpty }, value);
  }
  async function picture({ revision, png }: { revision?: string; png?: string } = {}) {
    if (typeof png !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(png)) throw fail("Invalid PNG");
    const bytes = Buffer.from(png, "base64");
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG) || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20))
      throw fail("Invalid PNG");
    return locked(async () => {
      if (revision !== (await read()).revision) throw fail("The drawing changed. Export its current picture.", 409);
      await atomic(path.join(directory, "view.png"), bytes);
      await atomic(path.join(directory, ".view-revision"), revision!);
      return { saved: true };
    });
  }
  // The chat and its replies use the same lock as every board writer, including the standalone window.
  // `stale` names a saved chat Elpis no longer has: it is replaced, unless another window already did so.
  async function chat(create?: (directory: string) => Promise<string>, stale?: string) {
    return locked(async () => {
      const file = path.join(directory, ".love-spot-chat.json");
      try {
        const saved = JSON.parse(await fs.readFile(file, "utf8"));
        if (typeof saved.threadId !== "string" || !saved.threadId) throw fail("Love Spot chat could not be read.", 409);
        if (saved.threadId !== stale) return saved.threadId;
      } catch (e) {
        if ((e as NodeJS.ErrnoException & { loveSpot?: boolean }).code !== "ENOENT") throw e;
      }
      if (!create) return null;
      const id = await create(directory);
      await atomic(file, JSON.stringify({ threadId: id }));
      return id;
    });
  }
  async function boardPicture(revision: string) {
    return locked(async () => {
      const current = await read();
      if (
        revision !== current.revision ||
        (await fs.readFile(path.join(directory, ".view-revision"), "utf8").catch(() => "")) !== revision
      )
        throw fail("The drawing changed. Try sending again with its current picture.", 409);
      return (await fs.readFile(path.join(directory, "view.png"))).toString("base64");
    });
  }
  /** The last exported picture while it still shows the current drawing, else null: for a chat away from the board. */
  async function currentPicture() {
    return locked(async () => {
      const current = await read();
      if ((await fs.readFile(path.join(directory, ".view-revision"), "utf8").catch(() => "")) !== current.revision)
        return null;
      return (await fs.readFile(path.join(directory, "view.png")).catch(() => null))?.toString("base64") ?? null;
    });
  }
  /** Writes the reply as a black note with her face to its left, and draws her painting (shapes from bridge/love-spot-painting.cts) beneath it; either may be missing. Face, note and painting are one group. */
  async function reply(
    turnId: string,
    text: string,
    agentColor: (color: string, id?: string) => boolean,
    page?: Page,
    shapes: ReturnType<typeof splitPainting>["shapes"] = [],
    arg5 = {},
  ) {
    return replyMoved({ locked, read, samePage, persist }, turnId, text, agentColor, page, shapes, arg5);
  }
  async function voice(muted?: boolean) {
    return locked(async () => {
      const file = path.join(directory, ".voice.json");
      if (muted !== undefined) {
        if (typeof muted !== "boolean") throw fail("Invalid voice preference");
        const temporary = `${file}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, JSON.stringify({ muted }), { mode: 0o600 });
        await fs.rename(temporary, file);
      }
      try {
        const saved = JSON.parse(await fs.readFile(file, "utf8"));
        if (typeof saved?.muted !== "boolean") throw fail("Invalid Voice preference");
        return saved.muted;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException & { loveSpot?: boolean }).code !== "ENOENT") throw cause;
        return false;
      }
    });
  }
  /** Correct the ignored-origin bug only when the recorded geometry still matches the drawing. */
  async function repairPaintings(paintings: { turnId: string; shapes: ReturnType<typeof splitPainting>["shapes"] }[]) {
    return repairPaintingsMoved({ locked, read, persist }, paintings);
  }
  async function companion(
    update?: (value: {
      pinned: unknown[];
      favorite: Record<string, unknown> | null;
      [key: string]: unknown;
    }) => Record<string, unknown>,
  ) {
    return locked(async () => {
      const file = path.join(directory, ".matilda-companion.json");
      let value;
      try {
        value = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException & { loveSpot?: boolean }).code !== "ENOENT")
          throw fail("Matilda settings could not be read; they were left untouched.", 409);
        value = { pinned: [], favorite: null };
      }
      if (!record(value) || !Array.isArray(value.pinned))
        throw fail("Matilda settings are invalid; they were left untouched.", 409);
      if (update) {
        value = update(
          value as { pinned: unknown[]; favorite: Record<string, unknown> | null; [key: string]: unknown },
        );
        await atomic(file, JSON.stringify(value));
      }
      return value;
    });
  }
  const watcher = createBoardWatcher(directory, screenshots, {
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
  });
  const { start, watch, close, screenshotsList, chooseScreenshot } = watcher;
  return {
    matildaSettings,
    read,
    save,
    saveText,
    listPages,
    changePage,
    picture,
    boardPicture,
    currentPicture,
    chat,
    reply,
    voice,
    start,
    watch,
    screenshotsList,
    chooseScreenshot,
    companion,
    repairPaintings,
    close,
  };
}
export declare const createLoveSpot: typeof createLoveSpotImpl;
export declare const merge: typeof mergeImpl;
export declare const newer: typeof import("./love-spot-order.cts").newer;
module.exports = { createLoveSpot: createLoveSpotImpl, newer: newerImpl, merge: mergeImpl };
