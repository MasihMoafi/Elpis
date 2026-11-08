import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createLoveSpotTalk } from "./love-spot-talk.mts";
import { toModel } from "./subscription-models.mts";
import { enabledAudio, PNG, note, fixture, delta } from "./love-spot-talk.fixtures.mts";
import type { SpeechEvent } from "./love-spot-talk.fixtures.mts";

test("Mute stops the feed while writing continues, persists on restart, and unmute never replays old text", async t => {
  const f = await fixture(t);
  await f.talk.send({ text: "Hello", model: "text" });
  const events: SpeechEvent[] = [],
    feed = await f.talk.speech();
  feed.subscribe(event => {
    events.push(event);
  });
  delta(f, "First. ");
  delta(f, "Old half");
  await f.talk.setVoice({ enabled: false });
  const count = events.filter(e => e.type === "text").length;
  delta(f, " MUTED. ");
  assert.ok(events.some(e => e.type === "stop"));
  assert.equal(events.filter(e => e.type === "text").length, count);
  assert.match(JSON.stringify((await f.talk.read()).entries), /MUTED/);
  f.finish();
  await f.talk.idle();
  f.talk.close();
  const next = createLoveSpotTalk({
    client: f.client as unknown as Parameters<typeof createLoveSpotTalk>[0]["client"],
    store: f.store,
    audio: enabledAudio,
  });
  t.after(() => next.close());
  assert.equal((await next.read()).voice.enabled, false);
  await next.send({ text: "Again", model: "text" });
  delta(f, "Before unmute. ");
  await next.setVoice({ enabled: true });
  const fresh: SpeechEvent[] = [];
  (await next.speech()).subscribe(event => {
    fresh.push(event);
  });
  delta(f, "New words. ");
  assert.equal(
    fresh
      .filter(e => e.type === "text")
      .map(e => e.text)
      .join(""),
    "New words. ",
  );
});

test("speech failure and interrupted turns stop voice without losing the text; unavailable ChatGPT defaults off", async t => {
  const f = await fixture(t);
  f.client.voiceStatus = async () => ({ available: false });
  const state = await f.talk.read();
  assert.equal(state.voice.enabled, false);
  assert.match(state.voice.reason!, /ChatGPT/);
  await f.talk.send({ text: "Hello", model: "text" });
  delta(f, "Still writing. ");
  await assert.rejects(f.talk.speech(), /ChatGPT/);
  f.client.voiceStatus = async () => ({ available: true });
  await f.talk.setVoice({ enabled: true });
  const events: SpeechEvent[] = [],
    feed = await f.talk.speech();
  feed.subscribe(event => {
    events.push(event);
  });
  delta(f, "Heard. ");
  feed.fail("Speech disconnected; retry explicitly.");
  delta(f, "Not retried. ");
  assert.match((await f.talk.read()).voice.error, /disconnected/);
  assert.doesNotMatch(
    events
      .filter(e => e.type === "text")
      .map(e => e.text)
      .join(""),
    /retried/,
  );
  f.finish("turn-1", "completed", "Still writing. Heard. Not retried.");
  await f.talk.idle();
  assert.equal(
    (await f.store.read()).scene.elements.find(e => e.id === "love-reply-turn-1")?.originalText,
    "Still writing. Heard. Not retried.",
  );
  await f.talk.send({ text: "Again", model: "text" });
  const cancelled: SpeechEvent[] = [];
  (await f.talk.speech()).subscribe(event => {
    cancelled.push(event);
  });
  delta(f, "DROP TAIL");
  f.finish("turn-2", "interrupted", "DROP TAIL. A cancelled sentence. ");
  await f.talk.idle();
  assert.equal(cancelled.filter(e => e.type === "text").length, 0);
  assert.ok(cancelled.some(e => e.type === "stop"));
});

test("unreadable Voice preferences disable speech and report the reason without blocking Matilda writing", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, ".voice.json"), "{");
  await f.talk.send({ text: "Hello", model: "text" });
  const state = await f.talk.read();
  assert.equal(state.voice.enabled, false);
  assert.match(state.voice.reason!, /Voice settings/);
  f.finish();
  await f.talk.idle();
  assert.equal(
    (await f.store.read()).scene.elements.find(e => e.id === "love-reply-turn-1")?.originalText,
    "Here with you.",
  );
});

test("one speech queue preserves message order and bounds a backlog while the complete note still saves", async t => {
  const f = await fixture(t);
  await f.talk.send({ text: "Hello", model: "text" });
  const spoken: string[] = [];
  (await f.talk.speech()).subscribe(event => {
    if (event.type === "text") spoken.push(event.text);
  });
  delta(f, "First tail", "first");
  f.client.emit("event", {
    type: "message",
    data: {
      method: "item/completed",
      params: { threadId: "chat", turnId: "turn-1", item: { id: "first", type: "agentMessage", text: "First tail" } },
    },
  });
  delta(f, "Second. ", "second");
  assert.equal(spoken.join(""), "First tail\n\nSecond. ");
  f.finish();
  await f.talk.idle();
  await f.talk.send({ text: "A long reply", model: "text" });
  const long = "A sentence. ".repeat(300);
  delta(f, long);
  assert.match((await f.talk.read()).voice.error, /fell behind/);
  f.finish("turn-2", "completed", long);
  await f.talk.idle();
  assert.equal(
    (await f.store.read()).scene.elements.find(e => e.id === "love-reply-turn-2")?.originalText,
    long.trim(),
  );
});

// 29 Oct, "love-spot, in the chat, is too slow": a chat resends its whole history, so a picture on every turn made each
// request carry every earlier picture. The picture goes when the drawing changed since she last saw it.
test("the board picture goes with a message only when the drawing changed since she last saw it", async t => {
  const f = await fixture(t);
  const shape = (id: string, version = 1) => ({ ...note(id, ""), type: "rectangle", text: undefined, version });
  const send = async (
    text: string,
    elements: Awaited<ReturnType<typeof f.store.read>>["scene"]["elements"] | undefined,
    small = false,
  ) => {
    if (elements) await f.store.save({ elements });
    const { revision } = await f.store.read();
    await f.store.picture({ revision, png: PNG });
    await f.talk.send({ text, model: "luna", ...(small ? {} : { revision }) });
    const turn = f.sent.at(-1)!;
    f.finish(`turn-${f.sent.length}`);
    await f.talk.idle();
    return {
      image: turn.attachments.some(a => a.type === "image"),
      notes: turn.attachments.find(a => a.type === "text")!.text,
    };
  };
  assert.equal((await send("First", [shape("box"), note("masih", "Apricot")])).image, true, "she sees the board once");
  // Her reply (note and face) and his new words change the board, not the drawing.
  const again = await send("Second", [shape("box"), note("masih", "Apricot"), note("masih-2", "Plum")]);
  assert.equal(again.image, false);
  assert.match(again.notes, /Plum/);
  assert.match(again.notes, /as it was in the last picture/);
  assert.equal((await send("From the small chat", undefined, true)).image, false, "the small chat too");
  assert.equal(
    (await send("Moved", [shape("box", 2), note("masih", "Apricot")])).image,
    true,
    "a changed shape goes again",
  );
  const drew = await send("I drew something on the board.", [
    shape("box", 2),
    shape("circle"),
    note("masih", "Apricot"),
  ]);
  assert.equal(drew.image, true, "a new drawing goes again");
  assert.doesNotMatch(drew.notes, /as it was/);
  await assert.rejects(
    f.talk.send({ text: "Stale", model: "luna", revision: "stale" }),
    /drawing changed/,
    "a stale board picture is still refused",
  );
});

test("a drawing notification waits silently until a picture is available, while written messages still work", async t => {
  const f = await fixture(t);
  const shape = (id: string) => ({ ...note(id, ""), type: "rectangle", text: undefined });
  await f.store.save({ elements: [shape("box")] });
  const waiting = await f.talk.send({ text: "I drew something on the board.", model: "text", drawingOnly: true });
  assert.ok(
    "waitingForPicture" in waiting && waiting.waitingForPicture,
    "the board does not start speech for a silent wait",
  );
  assert.equal(f.sent.length, 0, "a drawing alone without a picture does not prompt a reply");
  await f.talk.send({ text: "How are you?", model: "text" });
  assert.equal(f.sent.length, 1, "normal written messages still reach Matilda");
  f.finish();
  await f.talk.idle();
  const { revision } = await f.store.read();
  await f.store.picture({ revision, png: PNG });
  await f.talk.send({ text: "I drew something on the board.", model: "luna", revision, drawingOnly: true });
  assert.equal(f.sent.length, 2, "a drawing goes through once its picture is available");
  assert.ok(f.sent[1]!.attachments.some(a => a.type === "image"));
  f.finish("turn-2");
  await f.talk.idle();
  const current = await f.store.read();
  await f.store.picture({ revision: current.revision, png: PNG });
  await f.talk.send({
    text: "I drew something on the board.",
    model: "luna",
    revision: current.revision,
    drawingOnly: true,
  });
  assert.equal(f.sent.length, 2, "a repeated drawing signal without a new picture is quiet");
  await f.talk.send({ text: "I drew something on the board.", model: "text", pinned: true });
  assert.equal(f.sent.length, 3, "the same words typed by Masih are still delivered");
});

test("an image-capable subscription model receives the new board picture", async t => {
  const f = await fixture(t);
  f.client.models = async () => ({
    data: [toModel({ slug: "luna", visibility: "list", input_modalities: ["text", "image"] })],
    nextCursor: null,
  });
  await f.store.save({ elements: [{ ...note("drawing", ""), type: "rectangle", text: undefined }] });
  const { revision } = await f.store.read();
  await f.store.picture({ revision, png: PNG });
  await f.talk.send({ text: "I drew something on the board.", model: "luna", provider: "openai", revision });
  assert.equal(f.sent.length, 1);
  assert.ok(
    f.sent[0]!.attachments.some(a => a.type === "image"),
    "the model sees the drawing",
  );
});

test("a note left on one page cannot be sent as if it came from another", async t => {
  const f = await fixture(t);
  const current = await f.store.read();
  await assert.rejects(
    f.talk.send({ text: "A thought from the old page", model: "text", pageSession: "another-page" }),
    /page changed/,
  );
  assert.equal(f.sent.length, 0);
  await f.talk.send({ text: "A thought from this page", model: "text", pageSession: current.scene.page.session });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.text, "A thought from this page");
});

test("replies off stops the reply she is writing, and does nothing when she is quiet", async t => {
  const f = await fixture(t),
    interrupts: { id: string; turnId: string }[] = [];
  f.client.interrupt = async (id, body) => {
    interrupts.push({ id, ...body });
    return {};
  };
  await f.talk.stop();
  assert.deepEqual(interrupts, [], "nothing to stop while she is quiet");
  await f.talk.send({ text: "Look at this" });
  assert.equal((await f.talk.read()).busy, true);
  await f.talk.stop();
  assert.deepEqual(interrupts, [{ id: "chat", turnId: "turn-1" }], "her running reply is interrupted");
});

test("one Matilda setting: off refuses every message and stops her; her model is the same wherever she is asked", async t => {
  const f = await fixture(t),
    interrupts: { id: string; turnId: string }[] = [];
  f.client.interrupt = async (id, body) => {
    interrupts.push({ id, ...body });
    return {};
  };
  await f.talk.setMatilda({ model: "text" });
  await f.talk.send({ text: "From the small chat" });
  assert.equal(f.sent.at(-1)!.model, "text", "a message without a model uses her one model");
  f.finish("turn-1");
  await f.talk.send({ text: "From the board" });
  const off = await f.talk.setMatilda({ replies: false });
  assert.equal(off.matilda.replies, false);
  assert.deepEqual(interrupts, [{ id: "chat", turnId: "turn-2" }], "turning her off stops the reply she is writing");
  await assert.rejects(f.talk.send({ text: "Still there?" }), /Matilda is off/);
  assert.equal(f.sent.length, 2, "nothing reaches her while she is off");
  // 1 Nov: her pinned chat still works while she is off.
  f.finish("turn-2");
  await f.talk.send({ text: "Pinned hello", pinned: true });
  assert.equal(f.sent.length, 3, "the pinned chat reaches her while she is off");
  assert.equal(f.sent.at(-1)!.pinned, undefined, "the pinned flag stays in the bridge");
  f.finish("turn-3");
  assert.equal((await f.talk.read()).matilda.replies, false, "every surface reads the same setting");
  await f.talk.setMatilda({ replies: true });
  await f.talk.send({ text: "Back again" });
  assert.equal(f.sent.length, 4);
});
