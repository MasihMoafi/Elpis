"use strict";

import type { BrowserWindow, Dialog, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { createWindowIpc } from "./window-ipc.cts";
type Patch = { key: string; baseRevision: number; value?: string | null; changes?: Record<string, unknown> };
type Change = { key: string; value: string | null; revision: number; rebased: boolean };
type Version = { revision: number; writer: number | null | undefined };
type Listener = (change: Change) => void;
const { PREFERENCE_CHOICES }: typeof import("../lib/preference-choices.cts") = require("../lib/preference-choices.cts");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/** The keys the renderer may keep in the desktop store; anything else is refused (tests/controls.cts guards stubs with it). */
const storeKeys =
  /^(elpis-theme|elpis-chat-tabs-v1|elpis-browser-sessions-v1|elpis-browser-pins-v1|elpis-sidebar-width|elpis-matilda-persona|elpis-matilda-pending-v1|elpis-matilda-model|elpis-matilda-replies|elpis-matilda-float-v1|elpis-preferences-v1|elpis-projects-v1|elpis-project-chats-v1|elpis-pinned-chats-v1|elpis-bookmarked-chats-v1|elpis-terminal-height|elpis-last-chat|elpis-session-manager-v1|elpis-session-manager-actions-v1|elpis-follow-ups-v1|elpis-workflow-draft-v1|elpis-workflow-identities-v1|elpis-editor-v1|elpis-chat-attention-v1|elpis-chat-groups-v1|elpis-conversation-colours-v1|elpis-sidebar-folds-v1|elpis-canvas-panel|elpis-canvas-auto|(?:elpis-draft-v1|elpis-attachments-v1):[A-Za-z0-9_-]{1,200}|elpis:prompt-rail-bookmarks:[A-Za-z0-9_-]{1,200})$/;
const allowed = (key: unknown): key is string => typeof key === "string" && storeKeys.test(key);
const PREFERENCES_KEY = "elpis-preferences-v1";
const TEXT_JOURNAL_KEY = "elpis-draft-v1:love-spot-text-journal";
const textJournalPatch = (value: unknown) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.entries(value).every(([id, entry]) => id.length > 0 && id.length < 500 && typeof entry === "string");
const preferenceTypes: Record<string, string | readonly string[]> = {
  loveChatCharacters: "string",
  themeFollowsLoveChat: "boolean",
  speakMatildaReplies: "boolean",
  defaultFolder: "string",
  softWrap: "boolean",
  ...PREFERENCE_CHOICES,
  showContextUsage: "boolean",
  showAgentRuns: "boolean",
  sidebarWorkflows: "boolean",
  confirmClose: "boolean",
  preventSleep: "boolean",
  closeToTray: "boolean",
  quickEntryShortcut: "string",
  confirmDeleteChats: "boolean",
  inputNotifications: "boolean",
  notificationSound: "boolean",
  codeFont: "string",
  customThemes: "string",
  selectedPalette: "string",
  navOrder: "string",
  hiddenPages: "string",
  sessionManager: "boolean",
  profileName: "string",
  profileAsked: "boolean",
  settingsSectionOrder: "string",
  settingsPageOrder: "string",
  settingsPageGroups: "string",
  shortcutBindings: "string",
};
function preferencePatch(value: unknown) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, item]) => {
      const type = Object.hasOwn(preferenceTypes, key) ? preferenceTypes[key] : null;
      return (
        (Array.isArray(type) ? type.includes(item) : type && typeof item === type) &&
        (key !== "defaultFolder" || !item || (item as string).startsWith("/"))
      );
    })
  );
}

// App-owned preferences live outside the changing loopback origin. No runtime
// configuration or conversation history is written through this interface.
function createStateStoreImpl(file: string) {
  let values: Record<string, string> = {},
    error: string | undefined,
    revision = 0,
    queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<Listener>(),
    versions = new Map<string, Version>(),
    replacements = new Map<string, Version>(),
    fields = new Map<string, Version>();
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw Error("too large");
    values = JSON.parse(raw);
    if (
      !values ||
      Array.isArray(values) ||
      typeof values !== "object" ||
      Object.values(values).some(value => typeof value !== "string")
    )
      throw Error("invalid state");
    // A setting this version no longer knows is kept in the file and ignored: it must never stop the app from opening (23 Oct: removing two old Love Spot keys made every saved workspace unreadable). Writes are still limited to `allowed` keys.
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
      error = "Could not read saved Elpis workspace. The original file has been preserved.";
  }
  const snapshot = () => (error ? { error } : { values: { ...values }, revision });
  async function persist(next: Record<string, string>) {
    const temp = `${file}.${randomUUID()}.pending`;
    let handle;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      handle = await fs.promises.open(temp, "wx", 0o600);
      await handle.writeFile(JSON.stringify(next));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.rename(temp, file);
      // Acknowledgement includes the rename's directory entry, not just file data.
      handle = await fs.promises.open(path.dirname(file), "r");
      await handle.sync();
    } catch {
      throw Error("Could not save Elpis workspace. Keep this window open or copy your unsent text.");
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.unlink(temp).catch(() => {});
    }
  }
  function patch(input: Patch | null | undefined, writer?: number | null) {
    const run = async () => {
      if (error) throw Error(error);
      const { key, baseRevision, changes } = (input ?? {}) as Partial<Patch>;
      let value = input?.value;
      if (
        !allowed(key) ||
        typeof baseRevision !== "number" ||
        !Number.isSafeInteger(baseRevision) ||
        baseRevision < 0 ||
        baseRevision > revision ||
        (changes !== undefined
          ? value !== undefined ||
            !(key === PREFERENCES_KEY
              ? preferencePatch(changes)
              : key === TEXT_JOURNAL_KEY && textJournalPatch(changes))
          : value !== null && typeof value !== "string")
      )
        throw Error("Unsupported workspace patch");
      let changedFields: string[] | undefined;
      if (changes !== undefined) {
        let current: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(values[key] || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
        } catch {
          /* Same defaults recovery as lib/preferences.ts. */
        }
        changedFields = Object.keys(changes).filter(field => current[field] !== changes[field]);
        value = changedFields.length ? JSON.stringify({ ...current, ...changes }) : (values[key] ?? null);
      }
      const rebased = baseRevision < revision;
      // Startup/restoration and two windows can submit the same saved value.
      // An acknowledgement that changes nothing cannot overwrite another writer.
      if (values[key] === value || (value === null && values[key] === undefined))
        return { key, value, revision, rebased };
      // Ordered in-flight edits from one renderer may share a base revision.
      // Edits from another renderer always require an observed revision.
      const stale = (version: Version | undefined) =>
        version && version.revision > baseRevision && (writer === undefined || version.writer !== writer);
      const conflict =
        changes !== undefined
          ? stale(replacements.get(key)) || changedFields!.some(field => stale(fields.get(field)))
          : stale(versions.get(key));
      if (conflict)
        throw Object.assign(
          Error(
            "This setting or draft changed in another window. Your change was not saved. Check the current value and try again; copy unsent text before closing.",
          ),
          { code: "STATE_CONFLICT" },
        );
      if (
        typeof value === "string" &&
        Buffer.byteLength(value) > (key.startsWith("elpis-attachments-v1:") ? 6 * 1024 * 1024 : 1_000_000)
      )
        throw Error("Workspace value is too large");
      const next = { ...values };
      if (value === null) delete next[key];
      else next[key] = value as string;
      if (Buffer.byteLength(JSON.stringify(next)) > 8 * 1024 * 1024)
        throw Error("Saved drafts are too large. Copy or clear an older unsent draft.");
      await persist(next);
      values = next;
      ++revision;
      const version = { revision, writer };
      versions.set(key, version);
      if (changes !== undefined) for (const field of changedFields!) fields.set(field, version);
      else replacements.set(key, version);
      const change: Change = { key, value: value as string | null, revision, rebased };
      for (const listener of listeners) {
        try {
          listener(change);
        } catch {
          /* A closed window cannot invalidate a durable save. */
        }
      }
      return change;
    };
    const saved = queue.then(run);
    queue = saved.catch(() => {});
    return saved;
  }
  return {
    read: () => (error ? { error } : { ...values }),
    snapshot,
    patch,
    set: (key: string, value: string | null) => patch({ key, value, baseRevision: revision }, null),
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush: () => queue,
  };
}

function registerStateImpl({
  host,
  origin,
  ipcMain,
  dialog,
  store,
}: {
  host: BrowserWindow;
  origin: string;
  ipcMain: ReturnType<ReturnType<typeof createWindowIpc>>;
  dialog: Pick<Dialog, "showOpenDialog">;
  store: ReturnType<typeof createStateStoreImpl>;
}) {
  function authorize(event: IpcMainEvent | IpcMainInvokeEvent) {
    if (
      event.sender !== host.webContents ||
      event.senderFrame !== host.webContents.mainFrame ||
      new URL(event.senderFrame!.url).origin !== origin
    )
      throw Error("Elpis application frame required");
  }
  const read = (event: IpcMainEvent) => {
    try {
      authorize(event);
      event.returnValue = store.snapshot();
    } catch {
      event.returnValue = { error: "Elpis application frame required" };
    }
  };
  ipcMain.on("elpis:state:read", read);
  ipcMain.handle("elpis:state:write", async (event, patch) => {
    authorize(event);
    try {
      return await store.patch(patch as Patch, host.webContents.id);
    } catch (error) {
      const failure = error as Error & { code?: string };
      return { error: failure.message, code: failure.code ?? "STATE_SAVE_FAILED", snapshot: store.snapshot() };
    }
  });
  const unsubscribe = store.subscribe(change => {
    if (!host.webContents.isDestroyed() && new URL(host.webContents.mainFrame.url).origin === origin)
      host.webContents.send("elpis:state:changed", change);
  });
  ipcMain.handle("elpis:folder", async event => {
    authorize(event);
    const result = await dialog.showOpenDialog(host, { title: "Choose project folder", properties: ["openDirectory"] });
    return result.canceled ? null : fs.realpathSync(result.filePaths[0]!);
  });
  ipcMain.handle("elpis:folder:resolve", async (event, folder) => {
    authorize(event);
    if (typeof folder !== "string" || folder.length > 4096 || !path.isAbsolute(folder))
      throw Error("Choose an absolute folder path");
    try {
      const resolved = await fs.promises.realpath(folder);
      if (!(await fs.promises.stat(resolved)).isDirectory()) throw Error();
      return resolved;
    } catch {
      throw Error("This folder is unavailable. Choose an existing local folder.");
    }
  });
  return () => {
    unsubscribe();
    ipcMain.removeListener("elpis:state:read", read);
    for (const channel of ["elpis:state:write", "elpis:folder", "elpis:folder:resolve"]) ipcMain.removeHandler(channel);
  };
}
export declare const createStateStore: typeof createStateStoreImpl;
export declare const registerState: typeof registerStateImpl;
export declare const STORE_KEYS: RegExp;
module.exports = { STORE_KEYS: storeKeys, createStateStore: createStateStoreImpl, registerState: registerStateImpl };
