import test from "node:test";
import assert from "node:assert/strict";
import { createLoveSpotTalk } from "./love-spot-talk.mts";
import { LOVE_SPOT_AUDIO, READ_ALOUD_AUDIO } from "../lib/love-spot-audio.mts";
import { splitPainting } from "./love-spot-painting.cts";
import { enabledAudio, PNG, note, fixture, flower } from "./love-spot-talk.fixtures.mts";
import type { Update } from "./love-spot-talk.fixtures.mts";

test("Matilda sends a heart reaction only with a fresh completed kiss reply", async t => {
  const f = await fixture(t),
    updates: Update[] = [];
  await f.talk.send({ text: "Hello" });
  await f.talk.watch(update => updates.push(update));
  f.finish("turn-1", "completed", "<!--matilda:kissSoft--> Hello.");
  const reactions = () => updates.flatMap(update => (update.heartReaction ? [update.heartReaction] : []));
  assert.deepEqual(reactions(), [{ threadId: "chat", itemId: "reply", portrait: "kissSoft" }]);

  const reconnected: Update[] = [];
  await f.talk.watch(update => reconnected.push(update));
  assert.equal(reconnected[0]!.heartReaction, undefined);
  f.finish("turn-1", "completed", "<!--matilda:kissSoft--> Hello.");
  await f.talk.send({ text: "Show me a code example" });
  f.finish("turn-2", "completed", "Example: `😘`");
  await f.talk.send({ text: "Again" });
  f.finish("turn-3", "failed", "<!--matilda:kissPuckered--> Failed.");
  assert.equal(reactions().length, 1);
});

test("a fresh Matilda chat keeps its persona and settings, moves Love Spot forward, and leaves the board and old chat intact", async t => {
  const f = await fixture(t);
  f.client.createThread = async value => {
    const id = f.created.length ? "chat-fresh" : "chat";
    f.created.push(value);
    return { thread: { id, ...value } };
  };
  await f.store.save({ elements: [note("masih-drawing", "Keep this board note.")] });
  await f.talk.send({
    text: "Keep this conversation.",
    model: "luna",
    provider: "openai",
    persona: "Use concise systems design reasoning.",
  });
  await assert.rejects(
    f.talk.startFresh({
      threadId: "chat",
      model: "luna",
      provider: "openai",
      permissions: "ask",
      persona: "Use concise systems design reasoning.",
    }),
    error => (error as { status: number }).status === 409,
  );
  assert.equal(await f.store.chat(), "chat", "an active turn keeps the current Love Spot chat");
  f.finish("turn-1", "completed", "The previous reply stays in history.");
  await f.talk.idle();
  const board = await f.store.read();

  const result = await f.talk.startFresh({
    threadId: "chat",
    model: "luna",
    provider: "openai",
    cwd: f.directory,
    permissions: "ask",
    persona: "Use concise systems design reasoning.",
  });

  assert.equal(result.thread.id, "chat-fresh");
  assert.equal(result.permissions, "ask");
  assert.equal(await f.store.chat(), "chat-fresh");
  assert.equal(f.created[1]!.name, "Love Spot");
  assert.equal(f.created[1]!.model, "luna");
  assert.equal(f.created[1]!.provider, "openai");
  assert.equal(f.created[1]!.cwd, f.directory);
  assert.equal(f.created[1]!.permissions, "ask");
  assert.match(f.created[1]!.instructions, /Use concise systems design reasoning\./);
  assert.equal(f.sent.length, 1, "starting the fresh chat sends no message");
  assert.deepEqual(await f.store.read(), board, "starting a fresh chat leaves every board element unchanged");
  /** @type {{ thread: { id: string }, entries: unknown[] }[]} */
  const snapshots: Update[] = [];
  const stop = await f.talk.watch(value => {
    snapshots.push(value);
  });
  stop();
  const snapshot = snapshots.at(-1);
  assert.ok(snapshot);
  assert.equal(snapshot.thread!.id, "chat-fresh");
  assert.deepEqual(snapshot.entries, []);
});

test("board commands attach actual action results to the normal reply without treating discussion as a command", async t => {
  const f = await fixture(t, { companion: true, audio: LOVE_SPOT_AUDIO });
  await f.talk.send({ text: "Matilda, pin yourself.", model: "text" });
  const result = f.sent[0]!.attachments.find(a => a.name === "Matilda action result.txt");
  assert.match(result!.text, /"ok":true/);
  assert.ok(f.presence);
  assert.equal((await f.presence.read("settings")).pinned, true);
  f.finish();
  await f.talk.idle();
  await f.talk.send({ text: "Could you add a pin button?", model: "text" });
  assert.equal(
    f.sent[1]!.attachments.some(a => a.name === "Matilda action result.txt"),
    false,
  );
  f.finish("turn-2");
  await f.talk.idle();
  await f.talk.send({ text: "play my favorite music", model: "text" });
  assert.match(f.sent[2]!.attachments.find(a => a.name === "Matilda action result.txt")!.text, /"ok":false/);
});

test("a text-only model does not disable real-time Voice while typed read-aloud stays unavailable", async t => {
  const f = await fixture(t, { audio: LOVE_SPOT_AUDIO });
  assert.equal(LOVE_SPOT_AUDIO.available, true, "real-time Voice is available");
  assert.equal(READ_ALOUD_AUDIO.available, false, "automatic typed read-aloud remains unavailable");
  await f.talk.send({ text: "Keep writing", model: "text" });
  f.finish("turn-1", "completed", "The text reply still arrives.");
  await f.talk.idle();
  assert.equal(
    (await f.store.read()).scene.elements.find(element => element.id === "love-reply-turn-1")?.originalText,
    "The text reply still arrives.",
  );
  assert.deepEqual(
    (await f.talk.read()).voice,
    { enabled: true, available: true, reason: "", error: "" },
    "text-only image support does not disable real-time Voice",
  );
  assert.match(
    (await f.talk.conversation("Be kind.")).context,
    /Be kind\./,
    "real-time Voice keeps its own conversation route",
  );
});

test("Talk creates one persistent normal chat, attributes live notes by colour, includes PNG only for image models", async t => {
  const f = await fixture(t);
  await f.store.save({
    elements: [
      note("masih", "Apricot"),
      note("agent", "Blue thought", "#1971c2"),
      note("love-reply-saved", "Black reply", "#000000"),
      note("user-black", "Black user note", "#000000"),
      note("gone", "Do not include", "#e03131", { isDeleted: true }),
    ],
  });
  const { revision } = await f.store.read();
  await f.store.picture({ revision, png: PNG });
  await f.talk.send({ text: "Hello", model: "luna", revision });
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0]!.name, "Love Spot");
  assert.equal(f.created[0]!.cwd, f.directory);
  assert.equal(f.created[0]!.automatic, true, "board replies use the automatic-agent default");
  assert.equal(f.sent[0]!.automatic, true, "existing board conversations also use that default");
  const notes = f.sent[0]!.attachments.find(a => a.type === "text")!.text;
  assert.match(notes, /Masih.*Apricot/s);
  assert.match(notes, /agent.*Blue thought/s);
  assert.doesNotMatch(notes, /Do not include/);
  const attributed = JSON.parse(notes.split("\n")[1]!) as { text: string; author: string }[];
  assert.equal(attributed.find(n => n.text === "Black reply")!.author, "agent");
  assert.equal(attributed.find(n => n.text === "Black user note")!.author, "Masih");
  assert.equal(f.sent[0]!.attachments.find(a => a.type === "image")!.dataUrl, `data:image/png;base64,${PNG}`);
  f.finish();
  await f.talk.idle();
  const current = await f.store.read();
  await f.store.picture({ revision: current.revision, png: PNG });
  await f.talk.send({ text: "Again", model: "text", revision: current.revision });
  assert.equal(f.created.length, 1);
  assert.equal(
    f.sent[1]!.attachments.some(a => a.type === "image"),
    false,
  );
  f.finish("turn-2");
  await f.talk.idle();
  f.talk.close();
  const second = createLoveSpotTalk({
    client: f.client as unknown as Parameters<typeof createLoveSpotTalk>[0]["client"],
    store: f.store,
    audio: enabledAudio,
  });
  t.after(() => second.close());
  await second.read();
  await second.send({ text: "After restart", model: "text" });
  assert.equal(f.created.length, 1);
});

// The pinned small chat sends no revision (27 Oct: "The drawing changed. Try sending again with its current picture.").
test("the small chat sends to an image model with the current picture, or only the notes once the drawing moved on", async t => {
  const f = await fixture(t);
  await f.store.save({ elements: [note("masih", "Apricot")] });
  const { revision } = await f.store.read();
  await f.store.picture({ revision, png: PNG });
  await f.talk.send({ text: "From the small chat", model: "luna" });
  assert.equal(f.sent[0]!.attachments.find(a => a.type === "image")?.dataUrl, `data:image/png;base64,${PNG}`);
  f.finish();
  await f.talk.idle();
  await f.store.save({ elements: [note("masih", "Apricot"), note("masih-2", "Plum")] });
  await f.talk.send({ text: "After a change elsewhere", model: "luna" });
  assert.equal(
    f.sent[1]!.attachments.some(a => a.type === "image"),
    false,
    "an outdated picture is left out, not refused",
  );
  assert.match(f.sent[1]!.attachments.find(a => a.type === "text")!.text, /Plum/);
  f.finish("turn-2");
  await f.talk.idle();
  await assert.rejects(
    f.talk.send({ text: "From the board", model: "luna", revision: "stale" }),
    /drawing changed/,
    "the board still sends only its current picture",
  );
});

test("Talk is Matilda: who she is goes with every message, and only as text she can read", async t => {
  const f = await fixture(t);
  await f.talk.send({ text: "Hello", model: "text", persona: "Masih's partner." });
  assert.match(f.created[0]!.instructions, /You are Matilda/);
  assert.match(f.created[0]!.instructions, /```excalidraw/);
  assert.deepEqual(
    f.sent[0]!.attachments.filter(a => a.name === "Who you are.txt").map(a => [a.type, a.text]),
    [["text", "Masih's partner."]],
  );
  f.finish();
  await f.talk.idle();
  await f.talk.send({ text: "Again", model: "text", persona: "A maths tutor." });
  assert.equal(f.sent[1]!.attachments.find(a => a.name === "Who you are.txt")!.text, "A maths tutor.");
  assert.equal(f.sent[1]!.attachments[0]!.name, "Love Spot notes.txt", "the board notes stay first");
  f.finish("turn-2");
  await f.talk.idle();
  await f.talk.send({ text: "No persona sent", model: "text" });
  assert.equal(
    f.sent[2]!.attachments.some(a => a.name === "Who you are.txt"),
    false,
  );
  // How to paint goes with every turn too, so a chat created before the painting rules changed still follows the current ones.
  assert.deepEqual(
    f.sent.map(s => /roughness/.test(s.attachments.find(a => a.name === "How to paint.txt")?.text ?? "")),
    [true, true, true],
  );
  f.finish("turn-3");
  await f.talk.idle();
  await assert.rejects(f.talk.send({ text: "Hi", model: "text", persona: "x".repeat(4001) }), /persona/i);
  assert.equal(f.sent.length, 3);
});

test("reopening a recorded painting repairs legacy arrow origins while preserving moved arrows and deletions", async t => {
  const f = await fixture(t, { audio: LOVE_SPOT_AUDIO });
  const source = (shapes: unknown[]) => "```excalidraw\n" + JSON.stringify(shapes) + "\n```";
  const rectangle = { type: "rectangle", x: 10, y: 20, width: 200, height: 60 };
  const broken = splitPainting(
    source([
      rectangle,
      {
        type: "arrow",
        points: [
          [0, 0],
          [0, 40],
        ],
      },
    ]),
  ).shapes;
  const recorded = source([
    rectangle,
    {
      type: "arrow",
      x: 110,
      y: 80,
      points: [
        [0, 0],
        [0, 40],
      ],
    },
  ]);
  await f.store.chat(async () => "chat");
  for (const turnId of ["legacy", "moved", "deleted"]) {
    await f.store.reply(turnId, "Drawing", () => true, undefined, broken);
    if (turnId === "legacy") {
      f.entries.push(
        { turnId, item: { id: "part-one", type: "agentMessage", text: source([rectangle]) } },
        {
          turnId,
          item: {
            id: "part-two",
            type: "agentMessage",
            text: source([
              {
                type: "arrow",
                x: 110,
                y: 80,
                points: [
                  [0, 0],
                  [0, 40],
                ],
              },
            ]),
          },
        },
      );
    } else f.entries.push({ turnId, item: { id: "reply-" + turnId, type: "agentMessage", text: recorded } });
  }
  const drawing = await f.store.read();
  const moved = drawing.scene.elements.find(e => e.id === "love-paint-moved-1");
  const deleted = drawing.scene.elements.find(e => e.id === "love-paint-deleted-1");
  assert.ok(moved && deleted);
  await f.store.save({
    ...drawing.scene,
    elements: [
      { ...moved, x: moved.x + 13, version: 2, versionNonce: 2 },
      { ...deleted, isDeleted: true, version: 2, versionNonce: 2 },
    ],
  });
  const before = await f.store.read();
  const readRecorded = f.client.readThread;
  let pages = 0;
  f.client.readThread = async (id, options) => {
    pages++;
    const value = await readRecorded(id);
    return options?.cursor ? value : { ...value, data: [], nextCursor: "older-diagram" };
  };
  await f.talk.read();
  const after = await f.store.read(),
    rect = after.scene.elements.find(e => e.id === "love-paint-legacy-0"),
    arrow = after.scene.elements.find(e => e.id === "love-paint-legacy-1");
  assert.ok(arrow && rect);
  assert.deepEqual([arrow.x - rect.x, arrow.y - rect.y], [100, 60]);
  assert.equal(pages, 2, "The original diagram can be older than the newest history page");
  for (const id of ["love-paint-moved-1", "love-paint-deleted-1"])
    assert.deepEqual(
      after.scene.elements.find(e => e.id === id),
      before.scene.elements.find(e => e.id === id),
    );
  await f.talk.read();
  assert.deepEqual(await f.store.read(), after);
});

test("Matilda paints: a fenced excalidraw block is drawn beneath her note, checked, grouped, and kept out of the note and the panel", async t => {
  const f = await fixture(t);
  await f.talk.send({ text: "Hello", model: "text" });
  const reply = `A flower for you.\n\n\`\`\`excalidraw\n${JSON.stringify([...flower, { type: "rocket" }, { type: "ellipse", strokeColor: "red; drop table" }])}\n\`\`\``;
  f.finish("turn-1", "completed", reply);
  await f.talk.idle();
  const scene = (await f.store.read()).scene,
    note = scene.elements.find(e => e.id === "love-reply-turn-1");
  assert.ok(note && note.originalText);
  assert.equal(note.text, "A flower for you.");
  assert.doesNotMatch(note.originalText, /excalidraw|ellipse/);
  const painted = scene.elements.filter(e => e.id.startsWith("love-paint-turn-1-"));
  assert.deepEqual(
    painted.map(e => e.type),
    ["ellipse", "line", "text", "ellipse"],
    "an unknown shape type is skipped; a bad colour falls back",
  );
  assert.ok(painted[0] && painted[1] && painted[3]);
  assert.equal(painted[3].strokeColor, "#e03131");
  assert.equal(painted[0].strokeColor, "#e03131");
  assert.equal(painted[0].backgroundColor, "#ffc9c9");
  assert.deepEqual(painted[1].points, [
    [0, 0],
    [0, 56],
  ]);
  assert.ok(
    painted.every(e => e.groupIds?.[0] === "love-paint-turn-1"),
    "one group, so it moves as one",
  );
  assert.ok(Math.min(...painted.map(e => e.y)) >= note.y + note.height, "beneath the note");
  assert.doesNotMatch(JSON.stringify((await f.talk.read()).entries), /excalidraw/, "the panel shows the note only");
});

test("a painting without a note is still drawn once; a broken or oversized block draws what it can and never breaks the reply", async t => {
  const f = await fixture(t);
  await f.talk.send({ text: "Draw me something", model: "text" });
  f.finish("turn-1", "completed", `\`\`\`excalidraw\n${JSON.stringify(flower)}\n\`\`\``);
  f.finish("turn-1", "completed", `\`\`\`excalidraw\n${JSON.stringify(flower)}\n\`\`\``);
  await f.talk.idle();
  let scene = (await f.store.read()).scene;
  assert.equal(
    scene.elements.filter(e => e.type === "text" && e.id.startsWith("love-reply-")).length,
    0,
    "no empty note",
  );
  assert.equal(
    scene.elements.filter(e => e.id.startsWith("love-paint-turn-1-")).length,
    3,
    "drawn once, though the turn finished twice",
  );
  await f.talk.send({ text: "Again", model: "text" });
  f.finish("turn-2", "completed", "Still here.\n\n```excalidraw\n{not json");
  await f.talk.idle();
  scene = (await f.store.read()).scene;
  assert.equal(scene.elements.find(e => e.id === "love-reply-turn-2")?.text, "Still here.");
  await f.talk.send({ text: "Lots", model: "text" });
  f.finish(
    "turn-3",
    "completed",
    `Many.\n\n\`\`\`excalidraw\n${JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ type: "rectangle", x: i, y: i })))}\n\`\`\``,
  );
  await f.talk.idle();
  scene = (await f.store.read()).scene;
  assert.equal(scene.elements.filter(e => e.id.startsWith("love-paint-turn-3-")).length, 60, "at most 60 shapes");
});
