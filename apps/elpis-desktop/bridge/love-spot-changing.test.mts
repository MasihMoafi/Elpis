import { createTestTempDir, removeTestTempDir } from "../tests/temp-root.cts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLoveSpot } from "./love-spot-store.cts";
import { FAKE_ACP_AGENT, PNG, element, eventReader, fixture } from "./love-spot.fixtures.mts";
import type { StoreEvent, SceneResult, SentBody } from "./love-spot.fixtures.mts";

test("only a brand-new Love Spot board gets the handwritten welcome and heart", async t => {
  const base = path.join(os.homedir(), ".cache/elpis-tests");
  await fs.mkdir(base, { recursive: true });
  const root = createTestTempDir(path.join(base, "love-spot-welcome-"));
  const screenshots = path.join(root, "Screenshots");
  const fresh = createLoveSpot({ directory: path.join(root, "fresh"), screenshots });
  const emptyDirectory = path.join(root, "saved-empty"),
    empty = createLoveSpot({ directory: emptyDirectory, screenshots });
  const savedDirectory = path.join(root, "saved"),
    saved = createLoveSpot({ directory: savedDirectory, screenshots });
  const archivedDirectory = path.join(root, "archived"),
    archived = createLoveSpot({ directory: archivedDirectory, screenshots });
  const handDrawn = {
    id: "hand-drawn",
    type: "line",
    x: 1,
    y: 2,
    width: 8,
    height: 9,
    points: [
      [0, 0],
      [8, 9],
    ],
    version: 1,
    versionNonce: 1,
  };
  await fs.mkdir(emptyDirectory, { recursive: true });
  await fs.writeFile(
    path.join(emptyDirectory, "scene.excalidraw"),
    JSON.stringify({ elements: [], files: {}, appState: {} }),
  );
  await fs.mkdir(savedDirectory, { recursive: true });
  await fs.writeFile(
    path.join(savedDirectory, "scene.excalidraw"),
    JSON.stringify({ elements: [handDrawn], files: {}, appState: {} }),
  );
  await fs.mkdir(path.join(archivedDirectory, "pages"), { recursive: true });
  await fs.writeFile(
    path.join(archivedDirectory, "pages", "Original.excalidraw"),
    JSON.stringify({ elements: [], files: {}, appState: {} }),
  );
  t.after(async () => {
    await Promise.all([fresh.close(), empty.close(), saved.close(), archived.close()]);
    removeTestTempDir(root);
  });

  const first = (await fresh.read()).scene;
  const welcome = first.elements.find(e => e.type === "text");
  const heart = first.elements.find(e => e.type === "line");
  assert.equal(welcome?.text, "Welcome to Love Spot");
  assert.equal(welcome.fontFamily, 5, "the welcome uses the board handwriting");
  assert.equal(welcome.strokeColor, "#000000");
  assert.equal(heart?.strokeColor, "#e03131");
  assert.ok(heart.points);
  assert.ok(heart.points.length >= 8, "the heart is drawn as a hand-shaped path");
  assert.deepEqual(heart.points[0], heart.points.at(-1), "the hand-drawn heart closes");
  assert.deepEqual((await empty.read()).scene.elements, [], "a saved empty board stays empty");
  assert.deepEqual((await saved.read()).scene.elements, [handDrawn], "saved board content is left alone");
  assert.deepEqual(
    (await archived.read()).scene.elements,
    [],
    "a missing current file with saved pages is not a new store",
  );
});

test("normal Love Spot chat turns receive portrait choices without changing other chats", async t => {
  const f = await fixture(t);
  await f.load();
  await fs.mkdir(f.directory, { recursive: true });
  await fs.writeFile(path.join(f.directory, ".love-spot-chat.json"), JSON.stringify({ threadId: "love-chat" }));
  const sent: { id: string; body: SentBody }[] = [];
  f.client.send = async (id, body) => {
    sent.push({ id, body });
    return { turn: { id: "turn-portrait" } };
  };
  for (const id of ["love-chat", "other-chat"]) {
    const response = await f.request(`/../threads/${id}/turns`, { text: "Hello", attachments: [] });
    assert.equal(response.status, 200);
  }
  const portrait = sent[0]?.body.attachments.find(item => item.id === "matilda-portrait");
  assert.ok(portrait);
  assert.match(portrait.text, /kissPuckered/);
  assert.deepEqual(sent[1]?.body.attachments, []);
});

test("Love Spot agent routes authenticate and run saved drawing agents over ACP without waiting for tool approval", async t => {
  // The card runs as an ACP agent process: the scripted SDK agent, which logs what reaches it.
  const logRoot = createTestTempDir(path.join(os.tmpdir(), "love-route-"));
  t.after(() => removeTestTempDir(logRoot));
  const log = path.join(logRoot, "agent.jsonl");
  const nodeSpec = (node: { name: string; prompt: string }) => ({
    name: node.name,
    command: process.execPath,
    args: [FAKE_ACP_AGENT],
    env: { FAKE_ACP_LOG: log, FAKE_ACP_NAME: "route" },
    instructions: node.prompt,
  });
  const f = await fixture(t, { loveAgents: { nodeSpec, timeoutMs: 10000 } });
  for (const route of ["run", "permission"])
    assert.equal(
      (
        await fetch(`${f.origin}/api/love-spot/agents/${route}`, {
          method: "POST",
          headers: { origin: f.origin, "content-type": "application/json" },
          body: JSON.stringify({ id: "agent" }),
        })
      ).status,
      401,
    );
  await f.save({
    elements: [
      element("agent", 1, {
        customData: {
          loveAgent: {
            name: "Writer",
            preset: "writer",
            model: "gpt-6-luna",
            provider: "openai",
            prompt: "Be precise",
            task: "[permission] Route seed",
          },
        },
      }),
    ],
    files: {},
  });
  assert.equal((await f.request("/agents/run", { id: "agent", unknown: true })).status, 400);
  assert.equal((await f.request("/agents/run", { id: "agent", cwd: "relative" })).status, 400);
  assert.equal(
    (await f.request("/agents/permission", { id: "agent", optionId: "allow_once" })).status,
    409,
    "nothing is waiting yet",
  );
  await assert.rejects(fs.access(log), "no agent started for a refused request");
  const reply = await f.request("/agents/run", { id: "agent" });
  const card = async () => {
    const agent = (await f.load()).scene.elements[0]?.customData?.loveAgent;
    assert.ok(agent && typeof agent === "object" && "status" in agent && "sessionId" in agent && "permission" in agent);
    return agent;
  };
  assert.equal(reply.status, 200, await reply.clone().text());
  assert.equal(
    (await reply.json()).results[0].output,
    "route(default) answered: permission: allow_once. [permission] Route seed",
  );
  const saved = await card();
  assert.deepEqual([saved.status, saved.sessionId, saved.permission], ["completed", "route-session-1", null]);
  const messages = (await fs.readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.deepEqual(
    messages.filter(message => message.permission).map(message => message.permission),
    [{ outcome: "selected", optionId: "allow_once" }],
    "the automatic permission is delivered to the ACP process exactly once",
  );
  assert.deepEqual(messages.find(message => message.method === "session/new").params._meta, {
    systemPrompt: { append: "Be precise" },
  });
  for (const optionId of ["made-up", "allow_once"])
    assert.equal(
      (await f.request("/agents/permission", { id: "agent", optionId })).status,
      409,
      "an old client cannot answer a permission an automatic agent already settled",
    );
});

test("Love Spot load/save unions stale windows, keeps newest versions and deletion tombstones", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.load()).scene.elements, []);
  await Promise.all([f.save({ elements: [element("a")], files: {} }), f.save({ elements: [element("b")], files: {} })]);
  await f.save({ elements: [element("a", 3, { isDeleted: true })], files: {} });
  await f.save({ elements: [element("a", 2)], files: {} });
  const { scene } = await f.load();
  assert.deepEqual(scene.elements.map(e => e.id).sort(), ["a", "b"]);
  assert.equal(scene.elements.find(e => e.id === "a")?.isDeleted, true);
  await f.save({ elements: [element("b", 1, { versionNonce: 1, x: 123 })], files: {} });
  assert.equal((await f.load()).scene.elements.find(e => e.id === "b")?.x, 123);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, "scene.excalidraw"), "utf8")).elements.length, 2);
});

test("text flush reaches its archived page without changing the page another window selected", async t => {
  const f = await fixture(t),
    original = (await f.load()).scene.page;
  await f.save({ elements: [element("kept-shape")], files: {}, appState: {}, page: original }); // an empty page is not kept once left
  const next = await (await f.request("/pages", { action: "new", page: original })).json();
  const text = element("verdict", 3, { type: "text", text: "My final verdict", originalText: "My final verdict" });
  const saved = await f.request("/text", { page: original, elements: [text] });
  assert.equal(saved.status, 200);
  const textScene: SceneResult = await saved.json();
  assert.equal(textScene.scene.elements.find(e => e.id === "verdict")?.text, text.text);
  assert.equal((await f.load()).scene.page.session, next.scene.page.session);
  assert.equal((await f.load()).scene.elements.length, 0, "old text must not enter the new page");
  assert.equal((await f.request("/text", { page: original, elements: [element("shape")] })).status, 400);
  assert.equal(
    (await f.request("/text", { page: { ...original, session: "unrelated" }, elements: [text] })).status,
    409,
  );
});

test("a page left empty is not kept; a page with something on it, or marked Keep, is", async t => {
  const f = await fixture(t),
    pages = path.join(f.directory, "pages");
  const listed = async () => (await (await f.request("/pages")).json()).pages.map((p: { name: string }) => p.name);
  const empty = (await f.load()).scene.page;
  const drawn = (await (await f.request("/pages", { action: "new", page: empty })).json()).scene.page;
  assert.ok(!(await listed()).includes(empty.name), "the empty page left behind must not stay in the list");
  await assert.rejects(fs.access(path.join(pages, `${empty.name}.excalidraw`)));
  assert.equal(
    (await f.request("", { elements: [element("kept-shape")], files: {}, appState: {}, page: drawn })).status,
    200,
  );
  const blank = (await (await f.request("/pages", { action: "new", page: drawn })).json()).scene.page;
  assert.ok((await listed()).includes(drawn.name), "a page with a shape stays");
  await f.request("/pages", { action: "keep", name: blank.name, page: blank });
  await f.request("/pages", { action: "switch", name: drawn.name, page: blank });
  assert.ok((await listed()).includes(blank.name), "an empty page marked Keep stays");
  // Words still being typed on the dropped page in another window bring it back; words for a deleted page do not.
  const words = element("late-words", 1, { type: "text", text: "still mine", originalText: "still mine" });
  assert.equal((await f.request("/text", { page: empty, elements: [words] })).status, 200);
  assert.ok((await listed()).includes(empty.name), "the words recreate their page");
  await f.request("/pages", { action: "delete", name: empty.name, page: (await f.load()).scene.page });
  assert.equal((await f.request("/text", { page: empty, elements: [words] })).status, 409);
  assert.ok(!(await listed()).includes(empty.name), "a deleted page stays deleted");
});

test("two Love Spot stores converge on equal-version deletes in either order, but allow newer undo and redo", async t => {
  const f = await fixture(t);
  const other = createLoveSpot({ directory: f.directory, screenshots: f.screenshots });
  t.after(() => other.close());
  for (const [index, [deleteFirst, liveNonce, deletedNonce]] of [
    [true, 1, 900],
    [false, 1, 900],
    [true, 900, 1],
    [false, 900, 1],
    [true, 100, 100],
    [false, 100, 100],
  ].entries()) {
    const id = `conflict-${index}`;
    const live = element(id, 2, { isDeleted: false, versionNonce: liveNonce });
    const deleted = { ...live, isDeleted: true, versionNonce: deletedNonce };
    const page = (await f.load()).scene.page;
    const fromElpis = (e: object) => f.save({ elements: [e], files: {}, page });
    const fromStandalone = (e: object) => other.save({ elements: [e], files: {}, page });
    await fromElpis(deleteFirst ? deleted : live);
    await fromStandalone(deleteFirst ? live : deleted);
    assert.equal(
      (await other.read()).scene.elements.find(e => e.id === id)?.isDeleted,
      true,
      `delete must win: deleteFirst=${deleteFirst}, liveNonce=${liveNonce}, deletedNonce=${deletedNonce}`,
    );
    await fromStandalone({ ...live, version: 1, versionNonce: 0 });
    assert.equal((await f.load()).scene.elements.find(e => e.id === id)?.isDeleted, true);
    await fromElpis({ ...live, version: 3 });
    assert.equal(
      (await other.read()).scene.elements.find(e => e.id === id)?.isDeleted,
      false,
      "newer undo must restore",
    );
    await fromStandalone({ ...deleted, version: 4 });
    assert.equal((await f.load()).scene.elements.find(e => e.id === id)?.isDeleted, true, "newer redo must delete");
  }
});

test("Love Spot rejects malformed saves and leaves an unreadable existing scene intact", async t => {
  const f = await fixture(t);
  await f.save({ elements: [element("safe")], files: {} });
  for (const value of [
    null,
    {},
    { elements: [{}] },
    { elements: [], files: [] },
    { elements: [element("a", NaN)], files: {} },
  ])
    assert.equal((await f.request("", value)).status, 400);
  assert.equal((await f.load()).scene.elements[0]?.id, "safe");
  await fs.writeFile(path.join(f.directory, "scene.excalidraw"), "{unfinished");
  assert.equal((await f.request("", { elements: [], files: {} })).status, 409);
  assert.equal(await fs.readFile(path.join(f.directory, "scene.excalidraw"), "utf8"), "{unfinished");
  assert.equal((await fetch(`${f.origin}/api/love-spot`)).status, 401);
});

test("Love Spot picture requires the current revision and PNG bytes", async t => {
  const f = await fixture(t),
    a = await f.save({ elements: [element("a")], files: {} });
  assert.equal((await f.request("/picture", { revision: a.revision, png: PNG.toString("base64") })).status, 200);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "view.png")), PNG);
  await f.save({ elements: [element("b")], files: {} });
  assert.equal((await f.request("/picture", { revision: a.revision, png: PNG.toString("base64") })).status, 409);
  assert.equal((await f.request("/picture", { revision: (await f.load()).revision, png: "not a PNG" })).status, 400);
});

test(
  "Love Spot cached bootstrap skips loaded bytes and still sends changed scenes and stale-cache recovery",
  { timeout: 10000 },
  async t => {
    const f = await fixture(t),
      initial = await f.save({ elements: [element("cached")], files: {} });
    const reader = eventReader(await f.request(`/events?revision=${initial.revision}`));
    t.after(() => reader.cancel());
    const decoder = new TextDecoder(),
      first = decoder.decode((await reader.read()).value);
    assert.ok(first.includes('"type":"screenshots"'));
    assert.ok(first.includes("id: love-spot"), "metadata must identify a future reconnect");
    assert.equal(first.includes('"type":"scene"'), false);
    const changed = await f.save({ elements: [element("only-the-update-can-know-this")], files: {} });
    let update = "";
    while (!update.includes("only-the-update-can-know-this"))
      update += decoder.decode((await reader.read()).value, { stream: true });
    assert.ok(update.includes(changed.revision));
    const stale = eventReader(await f.request(`/events?revision=${initial.revision}`));
    t.after(() => stale.cancel());
    assert.ok(decoder.decode((await stale.read()).value).includes("only-the-update-can-know-this"));
  },
);

test("Love Spot cached bootstrap rejects invalid hints and always refreshes a reconnect", async t => {
  const f = await fixture(t),
    initial = await f.save({ elements: [element("reconnect")], files: {} });
  for (const suffix of [
    "/events?revision=bad",
    "/events?revision=",
    `/events?revision=${initial.revision}&revision=${initial.revision}`,
  ]) {
    assert.equal((await f.request(suffix)).status, 400);
  }
  const reader = eventReader(
    await f.request(`/events?revision=${initial.revision}`, undefined, { "last-event-id": "love-spot" }),
  );
  t.after(() => reader.cancel());
  const message = new TextDecoder().decode((await reader.read()).value);
  assert.ok(
    message.includes('"type":"scene"'),
    "reconnect must refresh even if the API cache and original hint have the same hash",
  );
  assert.ok(message.includes(initial.revision));
});

// 1 Nov resource audit: Love Spot checked the disk every 150 ms from app start, about 35 file operations a second,
// even when nobody drew. Masih: "see if our Elpis is using resources efficiently". Changes now wake it instead.
test("an idle Love Spot leaves the disk alone, yet sees a new screenshot and an inbox drawing at once", async t => {
  const base = path.join(os.homedir(), ".cache/elpis-tests");
  await fs.mkdir(base, { recursive: true });
  const root = createTestTempDir(path.join(base, "love-spot-idle-"));
  const directory = path.join(root, "drawing"),
    screenshots = path.join(root, "Screenshots");
  await fs.mkdir(directory);
  await fs.mkdir(screenshots);
  const store = createLoveSpot({ directory, screenshots });
  t.after(async () => {
    await store.close();
    removeTestTempDir(root);
  });
  await store.start();
  const events: StoreEvent[] = [];
  t.after(await store.watch(event => events.push(event)));
  await new Promise(resolve => setTimeout(resolve, 300));
  const counted = ["stat", "readdir", "mkdir", "readFile"] as const;
  const original = Object.fromEntries(counted.map(name => [name, fs[name]]));
  let calls = 0;
  Object.assign(
    fs,
    Object.fromEntries(
      counted.map(name => [
        name,
        new Proxy(fs[name], {
          apply(target, receiver, args) {
            calls++;
            return Reflect.apply(target, receiver, args);
          },
        }),
      ]),
    ),
  );
  try {
    await new Promise(resolve => setTimeout(resolve, 1500));
  } finally {
    Object.assign(fs, original);
  }
  assert.ok(calls <= 8, `an idle Love Spot made ${calls} file operations in 1.5 s`);
  const soon = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 20; i++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(label);
  };
  await fs.writeFile(path.join(screenshots, "new.png"), PNG);
  await soon(
    () => events.some(e => e.type === "screenshots" && e.screenshots.some(s => s.name === "new.png")),
    "a new screenshot reaches the tray within 1 s",
  );
  await fs.mkdir(path.join(directory, "inbox"), { recursive: true });
  await fs.writeFile(path.join(directory, "inbox", "add.json"), JSON.stringify({ elements: [element("from-inbox")] }));
  await soon(
    () => events.some(e => e.type === "scene" && e.scene.elements.some(x => x.id === "from-inbox")),
    "an inbox drawing reaches the board within 1 s",
  );
});
