const test: typeof import("node:test").test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStateStore, registerState } = require("./state.cts");
import type { Handler } from "./state.fixtures.cts";

test("chat groups, their chats and the sidebar order persist across a desktop restart; other versions are rejected", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-groups-state-")), "workspace.json");
  const store = createStateStore(file),
    groups = JSON.stringify({
      groups: [{ id: "g1", name: "Work" }],
      members: { "chat-1": "g1" },
      groupBy: "custom",
      sortBy: "name",
      collapsed: [],
    });
  await store.set("elpis-chat-groups-v1", groups);
  await store.set("elpis-session-manager-v1", "manager-thread");
  assert.equal(createStateStore(file).read()["elpis-chat-groups-v1"], groups);
  assert.equal(createStateStore(file).read()["elpis-session-manager-v1"], "manager-thread");
  await assert.rejects(store.set("elpis-chat-groups-v2", groups), /Unsupported/);
  await assert.rejects(store.set("elpis-session-manager-v2", "manager-thread"), /Unsupported/);
});

test("the Workflows side-panel and auto-arrange choices survive a desktop restart", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-canvas-state-")), "workspace.json");
  const store = createStateStore(file);
  await store.set("elpis-canvas-panel", "closed");
  await store.set("elpis-canvas-auto", "off");
  const reopened = createStateStore(file).read();
  assert.deepEqual([reopened["elpis-canvas-panel"], reopened["elpis-canvas-auto"]], ["closed", "off"]);
});

test("saved project memberships and Session Manager survive a full workspace round trip", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-state-union-")), "workspace.json");
  const saved = {
    "elpis-theme": "dark",
    "elpis-chat-tabs-v1": '["h2"]',
    "elpis-browser-sessions-v1": "{}",
    "elpis-sidebar-width": "282",
    "elpis-preferences-v1": '{"accent":"orange"}',
    "elpis-projects-v1": '[{"id":"p","path":"/tmp/elpis-project"}]',
    "elpis-project-chats-v1": '{"h2":"p"}',
    "elpis-pinned-chats-v1": '["h2"]',
    "elpis-terminal-height": "240",
    "elpis-last-chat": "h2",
    "elpis-session-manager-v1": "manager-thread",
    "elpis-session-manager-actions-v1":
      '{"h2":[{"action":"rename","status":"done","reason":"Name unset or irrelevant"}]}',
    "elpis-workflow-draft-v1": "{}",
    "elpis-editor-v1": "{}",
    "elpis-chat-attention-v1": "{}",
    "elpis-chat-groups-v1": '{"groups":[]}',
    "elpis-draft-v1:h2": "Unsent draft",
  };
  const original = JSON.stringify(saved);
  fs.writeFileSync(file, original);
  const store = createStateStore(file);
  assert.deepEqual(store.read(), saved);
  assert.equal(fs.readFileSync(file, "utf8"), original, "reading must preserve the original file");
  await store.set("elpis-project-chats-v1", '{"h2":"p","chat-2":"p"}');
  await store.set("elpis-session-manager-v1", "manager-thread-2");
  const actions = '{"h2":[{"action":"archive","status":"done","reason":"No activity for more than 7 days"}]}';
  await store.set("elpis-session-manager-actions-v1", actions);
  const expected = {
    ...saved,
    "elpis-project-chats-v1": '{"h2":"p","chat-2":"p"}',
    "elpis-session-manager-v1": "manager-thread-2",
    "elpis-session-manager-actions-v1": actions,
  };
  assert.deepEqual(createStateStore(file).read(), expected, "reopen must retain every saved key and draft");
  const persisted = fs.readFileSync(file, "utf8");
  await assert.rejects(store.set("elpis-project-chats-v2", "{}"), /Unsupported/);
  assert.equal(fs.readFileSync(file, "utf8"), persisted, "unknown keys must not change saved state");
});

test("reading options patch the preferences as the renderer saves them; wrong values are refused", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-reading-state-")), "workspace.json");
  const store = createStateStore(file),
    key = "elpis-preferences-v1";
  const reading = { transcriptSize: "l", transcriptWidth: "m", interfaceFont: "serif", codeFont: "DejaVu Sans Mono" };
  await store.patch({ key, baseRevision: 0, changes: reading });
  assert.deepEqual(JSON.parse(createStateStore(file).read()[key]), reading);
  for (const changes of [
    { transcriptSize: "xl" },
    { transcriptWidth: "full" },
    { interfaceFont: "comic" },
    { codeFont: 12 },
  ])
    await assert.rejects(store.patch({ key, baseRevision: 1, changes }), /Unsupported/, JSON.stringify(changes));
});

test("A70: Settings orders and cross-group membership survive reopening the real desktop store", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-settings-order-")), "workspace.json");
  const key = "elpis-preferences-v1",
    store = createStateStore(file);
  await store.set(key, JSON.stringify({ navOrder: "canvas,customize", sendShortcut: "modEnter" }));
  await store.patch({
    key,
    baseRevision: 1,
    changes: { settingsSectionOrder: "advanced,app,models,permissions,context,connections" },
  });
  const settingsPageGroups = JSON.stringify({ general: "context", appearance: "connections" });
  const shortcutBindings = JSON.stringify({ settings: "Ctrl+Alt+Y", search: "" });
  await store.patch({
    key,
    baseRevision: 2,
    changes: { settingsPageOrder: "appearance,general,notifications", settingsPageGroups, shortcutBindings },
  });
  assert.deepEqual(JSON.parse(createStateStore(file).read()[key]), {
    navOrder: "canvas,customize",
    sendShortcut: "modEnter",
    settingsSectionOrder: "advanced,app,models,permissions,context,connections",
    settingsPageOrder: "appearance,general,notifications",
    settingsPageGroups,
    shortcutBindings,
  });
  for (const changes of [
    { settingsSectionOrder: [] },
    { settingsPageOrder: false },
    { settingsPageGroups: {} },
    { shortcutBindings: {} },
  ]) {
    await assert.rejects(store.patch({ key, baseRevision: 3, changes }), /Unsupported/);
  }
  assert.equal(
    JSON.parse(createStateStore(file).read()[key]).settingsPageGroups,
    settingsPageGroups,
    "a rejected patch preserves the saved membership",
  );
});

test("retrying the same value after an actual write failure really persists it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-state-retry-"));
  const file = path.join(dir, "workspace.json");
  const store = createStateStore(file);
  fs.mkdirSync(file);
  await assert.rejects(() => store.set("elpis-projects-v1", "project input"), /Could not save/);
  assert.equal(
    store.read()["elpis-projects-v1"],
    undefined,
    "failed changes must not appear saved or persist after cancellation",
  );
  fs.renameSync(file, path.join(dir, "unavailable-fixture"));
  await store.set("elpis-projects-v1", "project input");
  assert.equal(createStateStore(file).read()["elpis-projects-v1"], "project input");
});

test("only the app main frame can read state or choose a folder; cancel has no side effects", async () => {
  const handlers = new Map<string, Handler>(),
    listeners = new Map<string, Handler>();
  const ipcMain = {
    handle: (key: string, value: Handler) => handlers.set(key, value),
    on: (key: string, value: Handler) => listeners.set(key, value),
    removeHandler: (key: string) => handlers.delete(key),
    removeListener: (key: string) => listeners.delete(key),
  };
  const mainFrame = { url: "http://127.0.0.1:45001/" },
    webContents = { mainFrame };
  const host = { webContents };
  let dialogs = 0;
  const dialog = {
    showOpenDialog: async () => {
      dialogs++;
      return { canceled: true, filePaths: [] };
    },
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-state-ipc-")), "workspace.json");
  const dispose = registerState({
    host,
    origin: "http://127.0.0.1:45001",
    ipcMain,
    dialog,
    store: createStateStore(file),
  });
  const foreign = { sender: {}, senderFrame: { url: "https://example.com" } };
  await assert.rejects(() => handlers.get("elpis:folder")!(foreign), /application/);
  await assert.rejects(
    () => handlers.get("elpis:state:write")!(foreign, { key: "elpis-theme", value: "dark", baseRevision: 0 }),
    /application/,
  );
  const own = { sender: webContents, senderFrame: mainFrame };
  for (const senderFrame of [{ url: mainFrame.url }, { url: "https://example.com" }])
    await assert.rejects(
      () =>
        handlers.get("elpis:state:write")!(
          { ...own, senderFrame },
          { key: "elpis-theme", value: "dark", baseRevision: 0 },
        ),
      /application/,
    );
  assert.equal(await handlers.get("elpis:folder")!(own), null);
  assert.equal(dialogs, 1);
  const dir = path.dirname(file);
  assert.equal(await handlers.get("elpis:folder:resolve")!(own, dir), fs.realpathSync(dir));
  await assert.rejects(() => handlers.get("elpis:folder:resolve")!(own, file), /folder/);
  await assert.rejects(() => handlers.get("elpis:folder:resolve")!(own, "relative"), /absolute/);
  dispose();
  assert.equal(handlers.size, 0);
});

test("attachment drafts persist through the real private store with separate file and total limits", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-attachment-state-")), "workspace.json");
  const store = createStateStore(file),
    key = "elpis-attachments-v1:chat-1";
  const value = JSON.stringify([
    {
      id: "image",
      name: "image.png",
      type: "image",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64," + "A".repeat(1500000),
    },
  ]);
  await store.set(key, value);
  assert.equal(createStateStore(file).read()[key], value);
  await assert.rejects(store.set("elpis-theme", value), /large/);
  await assert.rejects(store.set("elpis-attachments-v1:oversized", "x".repeat(6 * 1024 * 1024 + 1)), /large/);
  await assert.rejects(store.set("elpis-attachments-v1:bad:key", value), /Unsupported/);
  const large = "x".repeat(5 * 1024 * 1024);
  await store.set("elpis-attachments-v1:chat-2", large);
  await assert.rejects(store.set("elpis-attachments-v1:chat-3", large), /drafts are too large/);
  assert.equal(createStateStore(file).read()["elpis-attachments-v1:chat-2"], large);
  assert.equal(createStateStore(file).read()["elpis-attachments-v1:chat-3"], undefined);
  await store.set(key, null);
  assert.equal(createStateStore(file).read()[key], undefined);
});
