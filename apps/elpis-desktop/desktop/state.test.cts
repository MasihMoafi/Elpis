const test: typeof import("node:test").test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStateStore } = require("./state.cts");
const { spawn } = require("node:child_process");
const { windows }: import("./state.fixtures.cts").Fixtures = require("./state.fixtures.cts");

test("a saved workspace holding a setting this version no longer knows still opens and keeps it", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-old-key-")), "workspace.json");
  fs.writeFileSync(file, JSON.stringify({ "elpis-theme": "dark", "elpis-love-bars": '{"tools":{"x":1,"y":2}}' }));
  const store = createStateStore(file);
  assert.equal(store.snapshot().error, undefined, "it opens");
  await store.set("elpis-theme", "light");
  assert.equal(
    JSON.parse(fs.readFileSync(file, "utf8"))["elpis-love-bars"],
    '{"tools":{"x":1,"y":2}}',
    "and the old setting stays in the file",
  );
  fs.writeFileSync(file, JSON.stringify({ "elpis-theme": 3 }));
  assert.match(
    createStateStore(file).snapshot().error,
    /Could not read saved Elpis workspace/,
    "a value that is not text is still corruption",
  );
});

test("prompt bookmarks survive reopening the desktop store", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-prompt-bookmarks-")), "workspace.json");
  const key = "elpis:prompt-rail-bookmarks:chat-1";
  await createStateStore(file).set(key, '["turn-1","turn-2"]');
  assert.equal(createStateStore(file).read()[key], '["turn-1","turn-2"]');
  await assert.rejects(() => createStateStore(file).set("elpis:prompt-rail-bookmarks:../config", "[]"), /Unsupported/);
});

test("saved project chat assignments preserve the workspace and remain writable after restart", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-project-chat-state-")), "workspace.json");
  const assignments = JSON.stringify({ "chat-1": "project-1" });
  const values = {
    "elpis-project-chats-v1": assignments,
    "elpis-theme": "dark",
    "elpis-draft-v1:chat-1": "Unsent draft",
  };
  fs.writeFileSync(file, JSON.stringify(values));
  const store = createStateStore(file);
  assert.equal(store.read().error, undefined);
  assert.deepEqual(store.read(), values);
  await store.set("elpis-project-chats-v1", JSON.stringify({ "chat-1": "project-2" }));
  const reopened = createStateStore(file);
  assert.equal(reopened.read()["elpis-draft-v1:chat-1"], "Unsent draft");
  assert.deepEqual(JSON.parse(reopened.read()["elpis-project-chats-v1"]), { "chat-1": "project-2" });
  await assert.rejects(() => reopened.set("elpis-unknown-setting", "untrusted"), /Unsupported/);
});

test("sidebar bookmarks save through native IPC and preserve existing workspace state", async t => {
  const original = {
    "elpis-bookmarked-chats-v1": '["chat-existing"]',
    "elpis-pinned-chats-v1": '["chat-pinned"]',
    "elpis-chat-attention-v1": '{"unread":["chat-unread"],"plans":{}}',
    "elpis-draft-v1:chat-existing": "Unsent draft",
  };
  const f = windows(t, original),
    a = f.open(1);
  a.storage.setItem("elpis-bookmarked-chats-v1", '["chat-new","chat-existing"]');
  await f.settle();
  assert.deepEqual(a.errors, []);
  assert.deepEqual(createStateStore(f.file).read(), {
    ...original,
    "elpis-bookmarked-chats-v1": '["chat-new","chat-existing"]',
  });
  a.storage.setItem("elpis-bookmarked-chats-v1", '["chat-existing"]');
  await f.settle();
  assert.deepEqual(createStateStore(f.file).read(), original);
});

test("SETTINGS2 sizing, corners and sleep preference persist through native IPC and reopening", async t => {
  const f = windows(t),
    a = f.open(1),
    b = f.open(2);
  a.preferences.savePreferences({ interfaceSize: "l", codeSize: "s", cornerStyle: "rounded", preventSleep: true });
  await f.settle();
  b.preferences.savePreferences({ codeSize: "l" });
  await f.settle();
  const saved = JSON.parse(createStateStore(f.file).read()["elpis-preferences-v1"]);
  assert.equal(saved.interfaceSize, "l");
  assert.equal(saved.codeSize, "l");
  assert.equal(saved.cornerStyle, "rounded");
  assert.equal(saved.preventSleep, true);
  const fresh = f.open(3).preferences.readPreferences();
  assert.equal(fresh.interfaceSize, "l");
  assert.equal(fresh.codeSize, "l");
  assert.equal(fresh.cornerStyle, "rounded");
  assert.equal(fresh.preventSleep, true);
});

test("appearance choices persist through real desktop IPC, rebase across windows, and reject unknown values", async t => {
  const f = windows(t),
    a = f.open(1),
    b = f.open(2);
  a.preferences.savePreferences({ accent: "teal" });
  await f.settle();
  b.preferences.savePreferences({ chatFont: "serif" });
  await f.settle();
  const customThemes = '[{"id":"palette-1","name":"My palette"}]';
  a.preferences.savePreferences({ customThemes, selectedPalette: "palette-1" });
  await f.settle();
  const saved = JSON.parse(createStateStore(f.file).read()["elpis-preferences-v1"]);
  assert.equal(saved.accent, "teal");
  assert.equal(saved.chatFont, "serif");
  assert.equal(saved.customThemes, customThemes);
  assert.equal(saved.selectedPalette, "palette-1");
  for (const window of [a, b]) {
    assert.equal(window.preferences.readPreferences().accent, "teal");
    assert.equal(window.preferences.readPreferences().chatFont, "serif");
    assert.equal(window.preferences.readPreferences().customThemes, customThemes);
    assert.equal(window.preferences.readPreferences().selectedPalette, "palette-1");
    assert.deepEqual(window.errors, []);
  }
  for (const changes of [{ accent: "bad" }, { chatFont: "bad" }])
    await assert.rejects(
      f.store.patch({ key: "elpis-preferences-v1", baseRevision: f.store.snapshot().revision, changes }),
      /Unsupported/,
    );
});

// 28 Oct, Masih: "Unsupported workspace patch". The sidebar's Workflows switch saved sidebarWorkflows, which the store did not
// accept; every setting the app can save must be one the store takes, including the next one added.
test("every setting the app can save is accepted by the desktop store", async t => {
  const f = windows(t),
    a = f.open(1);
  a.preferences.savePreferences({ ...a.preferences.DEFAULT_PREFERENCES });
  await f.settle();
  assert.deepEqual(a.errors, []);
  // S18, Masih 29 Oct: the sidebar's Workflows section is off by default.
  assert.equal(JSON.parse(createStateStore(f.file).read()["elpis-preferences-v1"]).sidebarWorkflows, false);
  a.preferences.savePreferences({ sidebarWorkflows: true });
  await f.settle();
  assert.deepEqual(a.errors, []);
  assert.equal(a.preferences.readPreferences().sidebarWorkflows, true);
});

test("Agent runs visibility persists through actual desktop IPC and synchronizes between windows", async t => {
  const f = windows(t),
    a = f.open(1),
    b = f.open(2);
  a.preferences.savePreferences({ showAgentRuns: false });
  await f.settle();
  assert.deepEqual(a.errors, []);
  assert.equal(JSON.parse(createStateStore(f.file).read()["elpis-preferences-v1"]).showAgentRuns, false);
  assert.equal(b.preferences.readPreferences().showAgentRuns, false);
  assert.equal(a.preferences.readPreferences().speakMatildaReplies, true);
  a.preferences.savePreferences({ speakMatildaReplies: false });
  await f.settle();
  assert.equal(b.preferences.readPreferences().speakMatildaReplies, false);
  b.preferences.savePreferences({ showAgentRuns: true });
  await f.settle();
  assert.equal(a.preferences.readPreferences().showAgentRuns, true);
  assert.deepEqual(b.errors, []);
  await assert.rejects(
    f.store.patch({
      key: "elpis-preferences-v1",
      baseRevision: f.store.snapshot().revision,
      changes: { showAgentRuns: "yes" },
    }),
    /Unsupported/,
  );
});

test("two actual preloads preserve wrap when another window changes notifications and refresh both preference caches", async t => {
  const f = windows(t),
    a = f.open(1),
    b = f.open(2);
  a.preferences.savePreferences({ softWrap: true });
  await f.settle();
  b.preferences.savePreferences({ turnNotifications: "always" });
  await f.settle();
  const saved = JSON.parse(createStateStore(f.file).read()["elpis-preferences-v1"]);
  assert.equal(saved.softWrap, true);
  assert.equal(saved.turnNotifications, "always");
  for (const window of [a, b]) {
    assert.equal(window.preferences.readPreferences().softWrap, true);
    assert.equal(window.preferences.readPreferences().turnNotifications, "always");
    assert.ok(window.changes.includes("elpis-preferences-v1"));
    assert.deepEqual(window.errors, []);
  }
});

test("rejected writes clear optimistic cache values and report failures without disturbing another key", async t => {
  const f = windows(t),
    a = f.open(1),
    b = f.open(2);
  await a.storage.saveItem("elpis-theme", "dark");
  await f.settle();
  fs.renameSync(f.file, f.file + ".fixture");
  fs.mkdirSync(f.file);
  a.storage.setItem("elpis-sidebar-width", "240");
  await f.settle();
  assert.match(a.errors.at(-1), /Could not save/);
  for (const window of [a, b]) {
    assert.equal(window.storage.getItem("elpis-sidebar-width"), null);
    assert.equal(window.storage.getItem("elpis-theme"), "dark");
  }
  a.storage.setItem("../config.toml", "unsupported");
  await f.settle();
  assert.equal(a.storage.getItem("../config.toml"), null);
  assert.match(a.errors.at(-1), /Unsupported/);
});

test("stale preference fields rebase; overlapping fields conflict and restore the committed cache", async t => {
  const f = windows(t),
    a = f.open(1),
    b = f.open(2);
  f.delay(true);
  a.preferences.savePreferences({ softWrap: true });
  await f.settle();
  b.preferences.savePreferences({ turnNotifications: "always" });
  await f.settle();
  assert.equal(JSON.parse(f.store.read()["elpis-preferences-v1"]).softWrap, true);
  a.preferences.savePreferences({ softWrap: false });
  await f.settle();
  b.preferences.savePreferences({ softWrap: true, turnNotifications: "never" });
  await f.settle();
  assert.match(b.errors.at(-1), /another window/i);
  assert.equal(b.preferences.readPreferences().softWrap, false);
  assert.equal(b.preferences.readPreferences().turnNotifications, "always", "a conflict rejects the entire patch");
  f.deliver();
  assert.equal(a.preferences.readPreferences().turnNotifications, "always");
});

test("Love Spot journals merge independent element drafts across delayed native windows", async t => {
  const f = windows(t),
    a = f.open(1),
    b = f.open(2),
    key = "elpis-draft-v1:love-spot-text-journal";
  f.delay(true);
  a.storage.patchItem(key, { "page:note:a": "Masih verdict" });
  await f.settle();
  b.storage.patchItem(key, { "page:note:b": "Other edit" });
  await f.settle();
  assert.deepEqual(JSON.parse(f.store.read()[key]), { "page:note:a": "Masih verdict", "page:note:b": "Other edit" });
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  b.storage.patchItem("elpis-draft-v1:chat-1", { text: "not a journal" });
  await f.settle();
  assert.match(b.errors.at(-1), /Unsupported workspace patch/);
});

test("rapid own edits remain ordered; stale shared drafts conflict rather than silently replacing another window", async t => {
  const f = windows(t),
    a = f.open(1),
    b = f.open(2),
    key = "elpis-draft-v1:chat-1";
  a.storage.setItem(key, "first");
  a.storage.setItem(key, "second");
  await f.settle();
  assert.equal(f.store.read()[key], "second");
  assert.deepEqual(a.errors, []);
  f.delay(true);
  a.storage.setItem(key, "third");
  await f.settle();
  await assert.rejects(b.storage.saveItem(key, "competing draft"), /another window/i);
  assert.equal(b.storage.getItem(key), "third");
  f.deliver();
  b.storage.removeItem(key);
  await f.settle();
  f.deliver();
  assert.equal(a.storage.getItem(key), null);
});

test("delayed duplicate saves from another window succeed without a conflict, but different stale values still fail", async t => {
  const f = windows(t),
    a = f.open(1),
    b = f.open(2);
  f.delay(true);
  for (const [key, value] of [
    ["elpis-theme", "dark"],
    ["elpis-draft-v1:chat-1", "shared draft"],
    ["elpis-last-chat", "chat-1"],
  ]) {
    a.storage.setItem(key, value);
    await f.settle();
    await b.storage.saveItem(key, value);
    a.storage.setItem(key, value + "-new");
    await f.settle();
    await assert.rejects(b.storage.saveItem(key, value + "-different"), /another window/i);
  }
  a.preferences.savePreferences({ accent: "teal", chatFont: "serif" });
  await f.settle();
  b.preferences.savePreferences({ accent: "teal", transcriptSize: "l" });
  await f.settle();
  assert.deepEqual(b.errors, [], "an already committed choice is not a competing edit");
  assert.equal(b.preferences.readPreferences().transcriptSize, "l");
  a.preferences.savePreferences({ accent: "blue" });
  await f.settle();
  b.preferences.savePreferences({ accent: "rose", chatFont: "mono" });
  await f.settle();
  assert.match(b.errors.at(-1), /another window/i);
  assert.equal(b.preferences.readPreferences().chatFont, "serif");
  a.storage.removeItem("elpis-last-chat");
  await f.settle();
  b.storage.removeItem("elpis-last-chat");
  await f.settle();
  assert.equal(b.errors.length, 1, "duplicate removal also succeeds");
  f.deliver();
});

test("main revisions rebase other keys, reject overlapping and invalid patches, and do not publish failed saves", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-state-revisions-")), "workspace.json");
  const store = createStateStore(file),
    changes: unknown[] = [];
  store.subscribe((change: unknown) => changes.push(change));
  await store.patch({ key: "elpis-theme", baseRevision: 0, value: "dark" });
  const result = await store.patch({ key: "elpis-sidebar-width", baseRevision: 0, value: "240" });
  assert.equal(result.rebased, true);
  assert.equal(result.revision, 2);
  await assert.rejects(store.patch({ key: "elpis-theme", baseRevision: 0, value: "light" }), /another window/i);
  for (const patch of [
    { key: "elpis-theme", value: "light" },
    { key: "elpis-theme", baseRevision: 99, value: "light" },
    { key: "../config", baseRevision: 2, value: "x" },
    { key: "elpis-preferences-v1", baseRevision: 2, changes: { softWrap: "yes" } },
  ])
    await assert.rejects(store.patch(patch), /Unsupported/);
  assert.equal(changes.length, 2);
  fs.renameSync(file, file + ".fixture");
  fs.mkdirSync(file);
  await assert.rejects(store.patch({ key: "elpis-theme", baseRevision: 2, value: "light" }), /Could not save/);
  assert.equal(store.read()["elpis-theme"], "dark");
  assert.equal(changes.length, 2);
  fs.renameSync(file, file + ".unavailable");
  await store.patch({ key: "elpis-theme", baseRevision: 2, value: "light" });
  assert.equal(store.snapshot().revision, 3);
});

test("persistence does not use synchronous filesystem writes", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-state-async-")), "workspace.json");
  const store = createStateStore(file),
    originals: Record<string, unknown> = {};
  for (const name of ["mkdirSync", "writeFileSync", "renameSync", "fsyncSync"]) {
    originals[name] = fs[name];
    fs[name] = () => {
      throw Error("synchronous persistence");
    };
  }
  try {
    await store.set("elpis-theme", "dark");
  } finally {
    Object.assign(fs, originals);
  }
  assert.equal(createStateStore(file).read()["elpis-theme"], "dark");
});

test("SIGKILL immediately after acknowledgement preserves the last acknowledged write", { timeout: 10000 }, async t => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-state-crash-")), "workspace.json");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const {createStateStore}=require(${JSON.stringify(path.join(__dirname, "state.cts"))});const store=createStateStore(process.argv[1]);store.set('elpis-draft-v1:chat-1','Durable متن فارسی').then(()=>{process.send('ack');setInterval(()=>{},1000);});`,
      file,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code: number | null) => reject(Error(`child exited ${code} before acknowledgement`)));
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  assert.equal(createStateStore(file).read()["elpis-draft-v1:chat-1"], "Durable متن فارسی");
});

test("desktop state survives a new process store, preserves exact drafts and uses private files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-state-"));
  const file = path.join(dir, "profile", "workspace.json");
  const store = createStateStore(file);
  const draft = "Review this\n\nمتن فارسی";
  await Promise.all([
    store.set("elpis-draft-v1:chat-1", draft),
    store.set("elpis-draft-v1:recovery-chat-1", "Unsent edited message"),
    store.set("elpis-theme", "light"),
    store.set("elpis-theme", "dark"),
    store.set("elpis-workflow-draft-v1", '{"workflow":"exact draft"}'),
  ]);
  const reopened = createStateStore(file);
  assert.equal(reopened.read()["elpis-draft-v1:chat-1"], draft);
  assert.equal(
    reopened.read()["elpis-draft-v1:recovery-chat-1"],
    "Unsent edited message",
    "a failed replacement is saved separately from the current composer draft",
  );
  assert.equal(reopened.read()["elpis-theme"], "dark");
  assert.equal(reopened.read()["elpis-workflow-draft-v1"], '{"workflow":"exact draft"}');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  await reopened.set("elpis-draft-v1:chat-1", null);
  assert.equal(createStateStore(file).read()["elpis-draft-v1:chat-1"], undefined);
  assert.equal(createStateStore(file).read()["elpis-draft-v1:recovery-chat-1"], "Unsent edited message");
  await assert.rejects(
    () => reopened.set("elpis-draft-v1:recovery:chat-1", "unsupported old namespace"),
    /Unsupported/,
  );
  await assert.rejects(() => reopened.set("../config.toml", "x"), /Unsupported/);
  await assert.rejects(() => reopened.set("elpis-theme", "x".repeat(1_000_001)), /large/);
});

test("corrupt state is reported and preserved, rather than silently overwritten", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-state-invalid-"));
  const file = path.join(dir, "workspace.json");
  fs.writeFileSync(file, "{broken");
  const store = createStateStore(file);
  assert.match(store.read().error, /read/);
  await assert.rejects(() => store.set("elpis-theme", "light"), /read/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("pinned chats, Matilda position and terminal height persist across a desktop restart, with unknown keys still rejected", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "elpis-ux-state-")), "workspace.json");
  const store = createStateStore(file),
    pins = JSON.stringify(["chat-1", "chat-2"]);
  await store.set("elpis-pinned-chats-v1", pins);
  await store.set("elpis-terminal-height", "360");
  await store.set("elpis-matilda-float-v1", '{"right":120,"bottom":180,"size":96}');
  const reopened = createStateStore(file);
  assert.equal(reopened.read()["elpis-pinned-chats-v1"], pins);
  assert.equal(reopened.read()["elpis-terminal-height"], "360");
  assert.equal(reopened.read()["elpis-matilda-float-v1"], '{"right":120,"bottom":180,"size":96}');
  await assert.rejects(store.set("elpis-matilda-position-v1", "{}"), /Unsupported/);
  await assert.rejects(store.set("elpis-pinned-chats-v2", pins), /Unsupported/);
  await assert.rejects(store.set("elpis-terminal-height:other", "360"), /Unsupported/);
});
