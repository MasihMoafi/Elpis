import { createTestTempDir, removeTestTempDir } from "../tests/temp-root.cts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createLoveSpot } from "./love-spot-store.cts";
import { createLoveSpotTalk, SUBSCRIPTION_BLOCKED } from "./love-spot-talk.mts";
import { enabledAudio, note, fixture, flower, delta } from "./love-spot-talk.fixtures.mts";
import type { SpeechEvent } from "./love-spot-talk.fixtures.mts";

test("her face sits beside every reply as one image of one file, moves with the note and the painting, and stays clear of the board", async t => {
  const f = await fixture(t);
  await f.store.save({ elements: [note("masih", "Newest", "#e03131", { updated: 10 })] });
  await f.talk.send({ text: "Hi", model: "text" });
  f.finish("turn-1", "completed", `Here.\n\n\`\`\`excalidraw\n${JSON.stringify(flower)}\n\`\`\``);
  await f.talk.idle();
  await f.talk.send({ text: "Again", model: "text" });
  f.finish("turn-2", "completed", "Still here.");
  f.finish("turn-2", "completed", "Still here.");
  await f.talk.idle();
  const { scene } = await f.store.read(),
    live = scene.elements.filter(e => !e.isDeleted);
  const faces = live.filter(e => e.type === "image"),
    notes = ["turn-1", "turn-2"].map(id => live.find(e => e.id === `love-reply-${id}`));
  assert.deepEqual(
    faces.map(e => e.id),
    ["love-face-turn-1", "love-face-turn-2"],
    "one face per reply, once, though the turn finished twice",
  );
  assert.ok(faces[0]?.fileId && faces[1]?.fileId && notes[0] && notes[1]);
  assert.equal(Object.keys(scene.files).length, 1, "one file for every face");
  assert.equal(faces[0].fileId, faces[1].fileId);
  const portraitFile = scene.files[faces[0].fileId];
  assert.ok(portraitFile);
  assert.match(
    portraitFile.dataURL,
    /^data:image\/webp;base64,/,
    "a raster face, which the dark board shows the right way round",
  );
  assert.equal(portraitFile.mimeType, "image/webp");
  faces.forEach((face, i) => {
    assert.ok(notes[i] && face.groupIds && notes[i].groupIds);
    assert.ok(face.x + face.width <= notes[i].x, "the face is to the left of her note");
    assert.ok(Math.abs(face.y - notes[i].y) <= 8, "level with the first line");
    assert.ok(
      face.groupIds.includes(`love-reply-group-turn-${i + 1}`) &&
        notes[i].groupIds.includes(`love-reply-group-turn-${i + 1}`),
      "face and note move as one",
    );
  });
  const firstNote = notes[0];
  assert.ok(
    live
      .filter(e => e.id.startsWith("love-paint-turn-1-"))
      .every(e => e.groupIds?.includes("love-reply-group-turn-1") && e.x >= firstNote.x),
    "her painting joins the group, under the note",
  );
  const unit = (e: (typeof live)[number]) => e.groupIds?.at(-1) ?? e.id;
  for (const a of live)
    for (const b of live)
      if (a.id < b.id && unit(a) !== unit(b))
        assert.ok(
          a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
          `${a.id} and ${b.id} overlap`,
        );
  const painting = live.filter(e => e.id.startsWith("love-paint-"));
  await f.talk.send({ text: "Third", model: "text" });
  f.finish("turn-3", "completed", "");
  await f.talk.idle();
  assert.equal(
    (await f.store.read()).scene.elements.filter(e => e.type === "image").length,
    2,
    "an empty reply has no face",
  );
  assert.ok(painting.length);
});

test("replies are black with red hearts, unsigned, collision-free, idempotent and saved without a UI subscriber", async t => {
  const f = await fixture(t);
  await f.store.save({
    elements: [
      note("masih", "Newest", "#e03131", { updated: 10 }),
      note("block", "Obstacle", "#e03131", { x: 20, y: 100, width: 500, height: 500 }),
    ],
  });
  await f.talk.send({ text: "Hi", model: "text" });
  f.finish("turn-1", "completed", "Here with you. 💙");
  f.finish();
  await f.talk.idle();
  const scene = (await f.store.read()).scene,
    reply = scene.elements.find(e => e.text === "Here with you. ❤️");
  assert.ok(reply);
  assert.equal(reply.strokeColor, "#000000");
  assert.equal(scene.elements.filter(e => e.text === reply.text).length, 1);
  for (const e of scene.elements.filter(e => e.id !== reply.id))
    assert.ok(
      reply.x + reply.width <= e.x ||
        e.x + e.width <= reply.x ||
        reply.y + reply.height <= e.y ||
        e.y + e.height <= reply.y,
    );
});

test("empty, failed and interrupted replies add nothing; invalid messages and stale pictures fail before send", async t => {
  const f = await fixture(t);
  await assert.rejects(f.talk.send({ text: "   ", model: "text" }));
  assert.equal(f.created.length, 0);
  await assert.rejects(f.talk.send({ text: "Hi", model: "luna", revision: "stale" }));
  assert.equal(f.sent.length, 0);
  await f.talk.send({ text: "Hi", model: "text" });
  f.finish("turn-1", "failed");
  await f.talk.idle();
  assert.equal((await f.store.read()).scene.elements.length, 0);
  await f.talk.send({ text: "Hi again", model: "text" });
  f.finish("turn-2", "interrupted");
  await f.talk.idle();
  assert.equal((await f.store.read()).scene.elements.length, 0);
});

test("completion before send returns does not leave Talk busy, including empty and failed turns", async t => {
  const f = await fixture(t);
  let number = 0;
  f.client.send = async () => {
    const id = `fast-${++number}`;
    f.client.emit("event", {
      type: "message",
      data: { method: "turn/completed", params: { threadId: "chat", turn: { id, status: "completed", items: [] } } },
    });
    return { turn: { id } };
  };
  assert.equal((await f.talk.send({ text: "Hello", model: "text" })).busy, false);
  assert.equal((await f.talk.send({ text: "Again", model: "text" })).busy, false);
  assert.equal((await f.store.read()).scene.elements.length, 0);
});

test("simultaneous sends are refused and a missing saved chat is reported without making a duplicate", async t => {
  const f = await fixture(t);
  await f.talk.send({ text: "Hello", model: "text" });
  await assert.rejects(f.talk.send({ text: "Duplicate", model: "text" }), /already replying/);
  assert.equal(f.sent.length, 1);
  f.talk.close();
  f.client.readThread = async () => {
    throw new Error("Chat was deleted");
  };
  const next = createLoveSpotTalk({
    client: f.client as unknown as Parameters<typeof createLoveSpotTalk>[0]["client"],
    store: f.store,
    audio: enabledAudio,
  });
  t.after(() => next.close());
  await assert.rejects(next.send({ text: "Hello", model: "text" }), /Chat was deleted/);
  assert.equal(f.created.length, 1);
});

test("a recorded user item replaces the provisional prompt and only the final answer becomes a note", async t => {
  const f = await fixture(t);
  await f.talk.send({ text: "Hello", model: "text" });
  for (const item of [
    { id: "user", type: "userMessage", content: [{ type: "text", text: "Hello" }] },
    { id: "progress", type: "agentMessage", phase: "commentary", text: "Thinking aloud" },
    { id: "answer", type: "agentMessage", phase: "final_answer", text: "The answer" },
  ])
    f.client.emit("event", {
      type: "message",
      data: { method: "item/completed", params: { threadId: "chat", turnId: "turn-1", item } },
    });
  f.client.emit("event", {
    type: "message",
    data: {
      method: "turn/completed",
      params: { threadId: "chat", turn: { id: "turn-1", status: "completed", items: [] } },
    },
  });
  await f.talk.idle();
  assert.equal((await f.talk.read()).entries.filter(e => e.item.type === "userMessage").length, 1);
  assert.deepEqual(
    (await f.store.read()).scene.elements.filter(e => e.type === "text").map(e => e.originalText),
    ["The answer"],
  );
});

test("without phases, only her last message becomes the note: words before a tool call are not written on the board", async t => {
  const f = await fixture(t);
  await f.talk.send({ text: "Draw the engine", model: "text" });
  for (const item of [
    { id: "look", type: "agentMessage", text: "Need facts. Look quickly." },
    { id: "answer", type: "agentMessage", text: "Here it is." },
  ])
    f.client.emit("event", {
      type: "message",
      data: { method: "item/completed", params: { threadId: "chat", turnId: "turn-1", item } },
    });
  f.client.emit("event", {
    type: "message",
    data: {
      method: "turn/completed",
      params: { threadId: "chat", turn: { id: "turn-1", status: "completed", items: [] } },
    },
  });
  await f.talk.idle();
  assert.deepEqual(
    (await f.store.read()).scene.elements.filter(e => e.type === "text").map(e => e.originalText),
    ["Here it is."],
  );
});

test("a reply started on another page stays in Talk and does not write onto the newly selected page", async t => {
  const f = await fixture(t);
  await f.talk.send({ text: "About the original page", model: "text" });
  await f.store.changePage({ action: "new", name: "Quiet" });
  f.finish();
  await f.talk.idle();
  assert.deepEqual((await f.store.read()).scene.elements, []);
  const chat = await f.talk.read();
  assert.ok(chat.entries.some(e => e.item.text === "Here with you."));
  assert.match(chat.error, /page changed/i);
});

for (const message of [
  (id: string) => `thread not loaded: ${id}`,
  () => "Elpis rejected the operation (-32600). No automatic retry was made.",
])
  test(`after Masih deletes the Love Spot chat, she starts a new one instead of failing forever (${message("x").slice(0, 24)})`, async t => {
    const f = await fixture(t);
    await f.talk.send({ text: "Hello", model: "text" });
    f.finish();
    await f.talk.idle();
    f.talk.close();
    // Deleted from the sidebar and purged at quit: thread/read answers as the engine does for an unknown thread.
    f.client.readThread = async id => {
      throw new Error(message(id));
    };
    const next = createLoveSpotTalk({
      client: f.client as unknown as Parameters<typeof createLoveSpotTalk>[0]["client"],
      store: f.store,
      audio: enabledAudio,
    });
    t.after(() => next.close());
    assert.deepEqual((await next.read()).entries, []);
    await next.send({ text: "Are you still there?", model: "text" });
    assert.equal(f.created.length, 2);
    assert.equal(f.sent.at(-1)!.text, "Are you still there?");
  });

// Masih, 23 Oct: "set her thinking to low so it be faster, and set her to /fast as well".
test("Matilda thinks at low effort and her chat asks for Fast once; a model without Fast still answers", async t => {
  const f = await fixture(t);
  await f.talk.send({ text: "Hello", model: "text" });
  f.finish();
  await f.talk.idle();
  await f.talk.send({ text: "Again", model: "text" });
  assert.deepEqual(
    f.sent.map(item => item.effort),
    ["low", "low"],
  );
  assert.deepEqual(f.speeds, [{ id: "chat", enabled: true }], "Fast is asked for once, not on every message");
  const g = await fixture(t, { refuseFast: true });
  await g.talk.send({ text: "Hello", model: "text" });
  assert.equal(g.sent.length, 1, "a refused Fast does not stop the message");
});

// Masih, 23 Oct: "I can't change her model!" A model from another connection starts her a new chat instead of being refused.
test("a model from another connection starts Matilda a new chat; one from the same connection keeps hers", async t => {
  const f = await fixture(t);
  // Engine threads name their connection.
  f.client.createThread = async value => {
    f.created.push(value);
    return { thread: { id: "chat", ...value, modelProvider: value.provider ?? "openai" } };
  };
  await f.talk.send({ text: "Hello", model: "text" });
  f.finish();
  await f.talk.idle();
  await f.talk.send({ text: "Same connection", model: "text", provider: "openai" });
  f.finish("turn-2");
  await f.talk.idle();
  assert.equal(f.created.length, 1, "the same connection keeps her chat");
  await f.talk.send({ text: "Now on Claude", model: "claude/sonnet", provider: "anthropic" });
  assert.equal(f.created.length, 2);
  assert.equal(f.created[1]!.provider, "anthropic");
  assert.deepEqual(
    f.sent.map(item => [item.text, item.model]),
    [
      ["Hello", "text"],
      ["Same connection", "text"],
      ["Now on Claude", "claude/sonnet"],
    ],
  );
});

test("standalone Love Spot uses the chosen account and never a Claude or Gemini subscription", async t => {
  const f = await fixture(t, { standalone: true });
  f.client.createThread = async value => {
    f.created.push(value);
    return { thread: { id: "chat", ...value, modelProvider: value.provider ?? "openai" } };
  };
  for (const model of ["claude/sonnet", "agy/gemini-pro"]) {
    await assert.rejects(f.talk.send({ text: "Hi", model, provider: "openai" }), { message: SUBSCRIPTION_BLOCKED });
  }
  assert.deepEqual([f.created.length, f.sent.length], [0, 0], "a refused subscription model starts nothing");
  // An Anthropic API key account is a normal provider; the chosen one is used, with no fallback to the default.
  await f.talk.send({ text: "With my key", model: "text", provider: "anthropic" });
  f.finish();
  await f.talk.idle();
  await f.talk.send({ text: "With OpenRouter", model: "text", provider: "openrouter" });
  f.finish("turn-2");
  await f.talk.idle();
  assert.deepEqual(
    f.created.map(item => item.provider),
    ["anthropic", "openrouter"],
  );
  assert.deepEqual(
    f.sent.map(item => [item.text, item.model]),
    [
      ["With my key", "text"],
      ["With OpenRouter", "text"],
    ],
  );
  // The chosen account survives a restart (spec check 6).
  await f.talk.setMatilda({ model: "text", provider: "openrouter" });
  const reopened = createLoveSpot({ directory: f.directory, screenshots: path.join(f.directory, "shots") });
  t.after(() => reopened.close());
  const kept = await reopened.matildaSettings();
  assert.deepEqual([kept.provider, kept.model], ["openrouter", "text"]);
  // Love Spot inside Elpis keeps the Claude subscription route.
  const inElpis = await fixture(t);
  await inElpis.talk.send({ text: "Hi", model: "claude/sonnet", provider: "anthropic" });
  assert.equal(inElpis.sent.length, 1);
});

test("the Love Spot app and Love Spot inside Elpis keep separate boards (Masih, 7 Nov)", async t => {
  const home = createTestTempDir(path.join(os.tmpdir(), "love-boards-"));
  const saved = {
    HOME: process.env.HOME,
    ELPIS_HOME: process.env.ELPIS_HOME,
    LOVE_SPOT_APP: process.env.LOVE_SPOT_APP,
    EXCALIDRAW_LOCAL_DIR: process.env.EXCALIDRAW_LOCAL_DIR,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    removeTestTempDir(home);
  });
  delete process.env.EXCALIDRAW_LOCAL_DIR;
  process.env.HOME = home;
  const choose = async (env: Record<string, string | undefined>, provider: string) => {
    for (const [key, value] of Object.entries(env))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    const store = createLoveSpot({ screenshots: path.join(home, "shots") });
    t.after(() => store.close());
    await store.matildaSettings({ provider });
  };
  await choose({ LOVE_SPOT_APP: "1", ELPIS_HOME: path.join(home, ".local/share/love-spot") }, "openrouter");
  await choose({ LOVE_SPOT_APP: undefined, ELPIS_HOME: path.join(home, ".elpis-next") }, "openai");
  const read = async (dir: string) =>
    JSON.parse(await fs.readFile(path.join(home, dir, ".matilda-settings.json"), "utf8")).provider;
  assert.equal(
    await read(".local/share/excalidraw-local"),
    "openrouter",
    "the app keeps its board where it always was",
  );
  assert.equal(await read(".elpis-next/love-spot"), "openai", "inside Elpis the board lives in the Elpis home");
});

test("Matilda feeds speech and one growing board note before completion, excluding painting, commentary, tools and reasoning", async t => {
  const f = await fixture(t);
  await f.talk.send({ text: "Hello", model: "claude/sonnet", provider: "anthropic" });
  const events: SpeechEvent[] = [],
    feed = await f.talk.speech();
  feed.subscribe(event => {
    events.push(event);
  });
  f.client.emit("event", {
    type: "message",
    data: {
      method: "item/started",
      params: {
        threadId: "chat",
        turnId: "turn-1",
        item: { id: "progress", type: "agentMessage", phase: "commentary" },
      },
    },
  });
  delta(f, "PRIVATE. ", "progress");
  delta(f, "REASON. ", "hidden", "item/reasoning/textDelta");
  delta(f, "TOOL. ", "tool", "item/commandExecution/outputDelta");
  for (const text of [
    "Hello. \n",
    "`",
    '``excalidraw\n[{"type":"ellipse"}]\n``',
    "`",
    "\nStill ",
    "here. ",
    "The tail",
  ])
    delta(f, text);
  assert.match(
    events
      .filter(e => e.type === "text")
      .map(e => e.text)
      .join(""),
    /Hello\.\s+Still here\./,
  );
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|REASON|TOOL|excalidraw|ellipse/);
  await new Promise(resolve => setTimeout(resolve, 350));
  await f.talk.idle();
  assert.match(
    (await f.store.read()).scene.elements.find(e => e.id === "love-reply-turn-1")?.originalText ?? "",
    /Hello/,
  );
  f.finish("turn-1", "completed", 'Hello. \n```excalidraw\n[{"type":"ellipse"}]\n```\nStill here. The tail');
  await f.talk.idle();
  assert.equal(
    events
      .filter(e => e.type === "text")
      .map(e => e.text)
      .join("")
      .trim(),
    "Hello. \n\nStill here. The tail",
  );
  assert.equal(events.filter(e => e.type === "done").length, 1);
  f.finish();
  await f.talk.idle();
  const scene = (await f.store.read()).scene;
  assert.equal(scene.elements.filter(e => e.id === "love-reply-turn-1").length, 1);
  assert.equal(scene.elements.find(e => e.id === "love-reply-turn-1")?.originalText, "Hello. \n\nStill here. The tail");
  assert.equal(scene.elements.filter(e => e.id.startsWith("love-paint-turn-1-")).length, 1);
});
