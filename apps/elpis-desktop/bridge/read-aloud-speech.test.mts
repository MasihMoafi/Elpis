import test from "node:test";
import assert from "node:assert/strict";
import * as native from "./client.mts";
import { required, CHAT, SPEECH, offer, until, fixture } from "./read-aloud.fixtures.mts";

test("speech chunks preserve long ASCII, Persian and astral text below 900 engine-estimated tokens", () => {
  assert.equal(typeof native.speechChunks, "function", "the subscription transport needs a lossless chunker");
  for (const original of ["", "a".repeat(3596), "b".repeat(3597), "123. Hello! سلام 🌍 e\u0301\n".repeat(2300)]) {
    const chunks = native.speechChunks(original);
    assert.equal(chunks.join(""), original);
    for (const chunk of chunks) {
      assert.ok(chunk.length > 0);
      assert.ok(Math.ceil(Buffer.byteLength(chunk, "utf8") / 4) < 900);
      assert.equal(Buffer.from(chunk).toString("utf8"), chunk, "a chunk cannot split a Unicode scalar");
    }
  }
});

test("Matilda streams through the shared HTTP transport for native and Claude text; mute retires the speaker while text continues", async t => {
  for (const provider of ["openai", "anthropic"]) {
    const f = await fixture(t, { loveSpotAudio: { available: true } });
    f.state.provider = provider;
    Object.assign(f.client, {
      settings: async () => ({ main: { model: "text", provider } }),
      models: async () => ({ data: [{ model: "text", inputModalities: ["text"] }] }),
      createThread: async () => ({ thread: { id: CHAT, modelProvider: provider } }),
      setServiceTier: async () => ({}),
      send: async () => ({ turn: { id: "matilda-turn" } }),
    });
    assert.equal((await f.post("love-spot/talk", { text: "Hello", model: "text", provider })).status, 200);
    const event = (method: string, params: Record<string, unknown>) =>
      f.client.emit("event", {
        type: "message",
        data: { method, params: { threadId: CHAT, turnId: "matilda-turn", ...params } },
      });
    event("item/agentMessage/delta", { itemId: "note", delta: "First sentence. " });
    const { controller, reader, next } = await f.open(null);
    const session = await next();
    assert.equal(session.type, "session");
    assert.equal((await next()).type, "sdp");
    assert.equal(f.methods("thread/realtime/appendSpeech").length, 0);
    await f.post("voice/read-aloud/ready", { id: session.id });
    await until(() => f.methods("thread/realtime/appendSpeech").length === 1);
    assert.equal(required(f.methods("thread/realtime/start")[0]).params.voice, "juniper");
    assert.equal(required(f.methods("thread/start")[0]).params.modelProvider, "openai");
    event("item/agentMessage/delta", { itemId: "note", delta: "Second sentence. " });
    assert.equal(f.methods("thread/realtime/appendSpeech").length, 1, "RPC acknowledgement does not advance speech");
    f.notify("thread/realtime/transcript/done", { threadId: SPEECH, role: "user" });
    assert.equal(f.methods("thread/realtime/appendSpeech").length, 1);
    f.notify("thread/realtime/transcript/done", { threadId: SPEECH, role: "assistant" });
    await until(() => f.methods("thread/realtime/appendSpeech").length === 2);
    assert.equal(required(f.methods("thread/realtime/appendSpeech")[1]).params.text, "Second sentence. ");
    const muted = await f.post("love-spot/voice/settings", { enabled: false });
    assert.equal(muted.status, 200);
    assert.equal((await next()).type, "stopped");
    event("item/agentMessage/delta", { itemId: "note", delta: "Still writing. " });
    f.notify("thread/realtime/transcript/done", { threadId: SPEECH, role: "assistant" });
    assert.equal(f.methods("thread/realtime/appendSpeech").length, 2);
    assert.equal((await f.post("love-spot/voice", { sdp: offer })).status, 409);
    assert.equal(f.methods("thread/start").length, 1);
    assert.equal(f.methods("thread/realtime/stop").length, 1);
    assert.equal(f.methods("turn/interrupt").length, 0);
    controller.abort();
    await reader.cancel().catch(() => {});
    await f.app.close();
  }
});

test("read aloud uses the saved subscription voice in a private native thread and orders speech by completed output", async t => {
  const f = await fixture(t),
    original = "Hello سلام 🌍. ".repeat(900);
  const { controller, reader, next } = await f.open(original);
  const session = await next();
  assert.equal(session.type, "session");
  const sdp = await next();
  assert.equal(sdp.sdp, "v=0\r\nanswer");
  assert.equal(f.methods("thread/realtime/appendSpeech").length, 0, "wait for the connected peer");
  assert.equal(f.controls.filter(e => e.type === "cue").length, 0);
  const created = required(f.methods("thread/start")[0]).params;
  assert.equal(created.ephemeral, true);
  assert.equal(created.modelProvider, "openai");
  assert.equal(created.model, "gpt-5");
  const started = required(f.methods("thread/realtime/start")[0]).params;
  assert.equal(started.threadId, SPEECH);
  assert.equal(started.voice, "juniper");
  assert.equal(started.version, "v3");
  assert.equal(started.clientManagedHandoffs, true);
  assert.equal(started.includeStartupContext, false);
  assert.equal(started.transport.type, "webrtc");
  assert.equal((await f.post("voice/read-aloud/ready", { id: session.id })).status, 200);
  assert.equal(
    (await f.post("voice/read-aloud/ready", { id: session.id })).status,
    200,
    "a duplicate readiness message cannot advance the queue",
  );
  const expected = native.speechChunks(original);
  for (let index = 0; index < expected.length; index++) {
    await until(() => f.methods("thread/realtime/appendSpeech").length === index + 1);
    assert.deepEqual(required(f.methods("thread/realtime/appendSpeech")[index]).params, {
      threadId: SPEECH,
      text: expected[index],
    });
    await until(() => f.controls.filter(e => e.type === "cue").length === index + 1);
    f.notify("thread/realtime/transcript/done", { threadId: CHAT, role: "assistant", text: "unrelated" });
    assert.equal(f.methods("thread/realtime/appendSpeech").length, index + 1);
    f.notify("thread/realtime/transcript/done", { threadId: SPEECH, role: "assistant", text: expected[index] });
  }
  assert.equal((await next()).type, "complete", "completion is output generation, not proof of heard audio");
  assert.equal(
    (await f.post("voice", { threadId: CHAT, sdp: offer })).status,
    409,
    "live calls share the speaker owner",
  );
  controller.abort();
  await reader.cancel().catch(() => {});
  await until(() => f.methods("thread/realtime/stop").length === 1 && f.methods("thread/unsubscribe").length === 1);
  assert.equal(required(f.methods("thread/realtime/stop")[0]).params.threadId, SPEECH);
  assert.equal(f.methods("turn/start").length, 0);
  assert.equal(f.methods("turn/interrupt").length, 0);
});

test("read aloud refuses signed-out, API-key, invalid voice and malformed requests before any speech starts", async t => {
  const f = await fixture(t);
  for (const [change, reason] of [
    [{ account: null }, /Read aloud needs a ChatGPT connection/],
    [{ account: "apiKey" }, /Read aloud needs a ChatGPT connection/],
    [{ voice: "unknown" }, /Choose one of the listed ChatGPT voices/],
  ] as const) {
    Object.assign(f.state, { account: "chatgpt", provider: "openai", voice: "juniper" }, change);
    const response = await f.post("voice/read-aloud", { threadId: CHAT, text: "Words", sdp: offer });
    assert.match(await response.text(), reason);
    assert.equal(f.methods("thread/start").length, 0);
  }
  for (const change of [
    { text: "" },
    { text: "  " },
    { sdp: "bad" },
    { sdp: offer.replace("sendrecv", "recvonly") },
    { threadId: "bad" },
    { extra: true },
  ]) {
    const response = await f.post("voice/read-aloud", { threadId: CHAT, text: "Words", sdp: offer, ...change });
    assert.equal(response.status, 400);
  }
  assert.equal(f.methods("thread/realtime/start").length, 0);
  assert.equal(f.methods("thread/realtime/appendSpeech").length, 0);
});

test("Stop during startup retires the late native session and never appends or restarts speech", async t => {
  const f = await fixture(t);
  f.state.holdStart = true;
  const { controller, reader, next } = await f.open();
  const session = await next();
  await until(() => typeof f.state.finishStart === "function");
  controller.abort();
  await reader.cancel().catch(() => {});
  required(f.state.finishStart)();
  await until(() => f.methods("thread/realtime/stop").length === 1 && f.methods("thread/unsubscribe").length === 1);
  assert.equal((await f.post("voice/read-aloud/ready", { id: session.id })).status, 409);
  f.notify("thread/realtime/transcript/done", { threadId: SPEECH, role: "assistant", text: "late" });
  assert.equal(f.methods("thread/realtime/appendSpeech").length, 0);
});

test("speech failure and engine disconnect retire queued chunks without replaying uncertain speech", async t => {
  for (const failAppend of [true, false])
    await t.test(failAppend ? "append refused" : "engine disconnected", async t => {
      const f = await fixture(t);
      f.state.failAppend = failAppend;
      const { next } = await f.open("Many words. ".repeat(1000));
      const session = await next();
      await next();
      await f.post("voice/read-aloud/ready", { id: session.id });
      await until(() => f.methods("thread/realtime/appendSpeech").length === 1);
      if (!failAppend) f.socket.emit("close");
      assert.equal((await next()).type, "error");
      await until(() => f.socket.listenerCount("side") === 0);
      f.notify("thread/realtime/transcript/done", { threadId: SPEECH, role: "assistant", text: "late output" });
      assert.equal(f.methods("thread/realtime/appendSpeech").length, 1);
      assert.equal((await f.post("voice/read-aloud/ready", { id: session.id })).status, 409);
      assert.equal(f.methods("turn/start").length, 0);
    });
});

test("speaker ownership lasts through cleanup and ordinary live calls retain their original route", async t => {
  const f = await fixture(t);
  f.state.holdCleanup = true;
  const { controller, reader, next } = await f.open();
  await next();
  await next();
  controller.abort();
  await reader.cancel().catch(() => {});
  await until(() => typeof f.state.finishCleanup === "function");
  assert.equal((await f.post("voice", { threadId: CHAT, sdp: offer })).status, 409);
  required(f.state.finishCleanup)();
  await new Promise(resolve => setImmediate(resolve));
  const end = new AbortController();
  const live = await f.post("voice", { threadId: CHAT, sdp: offer }, end.signal);
  assert.equal(live.status, 200);
  await until(() => f.methods("thread/realtime/start").length === 2);
  assert.equal(required(f.methods("thread/realtime/start")[1]).params.threadId, CHAT);
  assert.equal(required(f.methods("thread/realtime/start")[1]).params.voice, "juniper");
  assert.equal(required(f.methods("thread/realtime/start")[1]).params.clientManagedHandoffs, undefined);
  assert.equal(f.methods("thread/start").length, 1, "the native live call creates no additional speech thread");
  end.abort();
  await until(() => f.methods("thread/realtime/stop").length === 2);
});

test("Claude and Antigravity read aloud use a private native speech thread and still require ChatGPT", async t => {
  for (const [provider, model] of [
    ["anthropic", "claude/opus"],
    ["openai", "claude/opus"],
    ["openai", "agy/gemini-pro"],
  ] as const)
    await t.test(`${provider}:${model}`, async t => {
      const f = await fixture(t);
      Object.assign(f.state, { provider, model });
      const { controller, reader, next } = await f.open("سلام from this chat.");
      const session = await next();
      assert.equal(session.type, "session");
      assert.equal((await next()).type, "sdp");
      const created = required(f.methods("thread/start")[0]).params;
      assert.equal(created.model, "gpt-6.1-sol", "the configured default, a model the engine lists");
      assert.equal(created.modelProvider, "openai");
      assert.equal(created.ephemeral, true);
      await f.post("voice/read-aloud/ready", { id: session.id });
      await until(() => f.methods("thread/realtime/appendSpeech").length === 1);
      assert.equal(required(f.methods("thread/realtime/appendSpeech")[0]).params.threadId, SPEECH);
      assert.match(required(f.methods("thread/realtime/appendSpeech")[0]).params.text, /سلام from this chat\.$/);
      assert.equal(f.methods("turn/start").length, 0);
      controller.abort();
      await reader.cancel().catch(() => {});
      await until(() => f.methods("thread/unsubscribe").length === 1);
      f.state.account = null;
      await assert.rejects(f.client.createSpeechThread(CHAT), /Read aloud needs a ChatGPT connection/);
      await assert.rejects(f.client.startVoice(CHAT, offer), /Voice needs a ChatGPT connection/);
      assert.equal(f.methods("thread/start").length, 1);
    });
});

test("Claude and Antigravity voice handoffs queue ordinary turns and speak only their completed replies", async t => {
  for (const [provider, model] of [
    ["anthropic", "claude/opus"],
    ["openai", "claude/opus"],
    ["openai", "agy/gemini-pro"],
  ] as const)
    await t.test(`${provider}:${model}`, async t => {
      const f = await fixture(t);
      Object.assign(f.state, { provider, model, busy: true });
      const { controller, reader, next } = await f.open(null, { live: true });
      assert.equal((await next()).type, "sdp");
      const started = required(f.methods("thread/realtime/start")[0]).params;
      assert.equal(started.threadId, SPEECH);
      assert.equal(started.clientManagedHandoffs, true);
      assert.equal(required(f.methods("thread/start")[0]).params.model, "gpt-6.1-sol");
      const handoff = (id: string, input: string, threadId = SPEECH) =>
        f.notify("thread/realtime/itemAdded", {
          threadId,
          item: {
            type: "handoff_request",
            handoff_id: id,
            item_id: `item-${id}`,
            input_transcript: input,
            active_transcript: "Private transcript context",
          },
        });
      handoff("wrong-thread", "Ignore this", CHAT);
      handoff("empty", "  ");
      f.notify("thread/realtime/itemAdded", { threadId: SPEECH, item: { type: "message", text: "Not a handoff" } });
      handoff("first", "First spoken request");
      handoff("first", "First spoken request");
      handoff("second", "Second spoken request");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.methods("turn/start").length, 0, "a typed turn is never steered or interrupted");
      f.notify("turn/completed", { threadId: CHAT, turn: { id: "typed-turn", status: "completed", items: [] } });
      await until(() => f.methods("turn/start").length === 1);
      const sent = required(f.methods("turn/start")[0]).params;
      assert.equal(sent.threadId, CHAT);
      assert.equal(required(sent.input[0]).text, "First spoken request");
      assert.equal(sent.model, undefined, "the normal send inherits this chat model");
      f.notify("item/completed", {
        threadId: SPEECH,
        turnId: "voice-turn-1",
        item: { id: "private", type: "agentMessage", text: "Do not speak the backing native agent" },
      });
      f.notify("turn/completed", {
        threadId: CHAT,
        turn: { id: "another-turn", status: "completed", items: [{ type: "agentMessage", text: "Not this reply" }] },
      });
      f.notify("item/completed", {
        threadId: CHAT,
        turnId: "voice-turn-1",
        item: { id: "progress", type: "agentMessage", phase: null, text: "I will check the files." },
      });
      f.notify("item/completed", {
        threadId: CHAT,
        turnId: "voice-turn-1",
        item: { id: "working", type: "agentMessage", phase: "commentary", text: "Working" },
      });
      f.notify("item/completed", {
        threadId: CHAT,
        turnId: "voice-turn-1",
        item: { id: "reply", type: "agentMessage", phase: "final_answer", text: "The selected agent replies." },
      });
      assert.equal(f.methods("thread/realtime/appendSpeech").length, 0, "item completion is not turn completion");
      f.notify("turn/completed", { threadId: CHAT, turn: { id: "voice-turn-1", status: "completed", items: [] } });
      await until(() => f.methods("thread/realtime/appendSpeech").length === 1);
      assert.deepEqual(required(f.methods("thread/realtime/appendSpeech")[0]).params, {
        threadId: SPEECH,
        text: "The selected agent replies.",
      });
      assert.equal(f.methods("turn/start").length, 1, "the next handoff waits for speech completion");
      f.notify("thread/realtime/transcript/done", { threadId: CHAT, role: "assistant" });
      f.notify("thread/realtime/transcript/done", { threadId: SPEECH, role: "user" });
      assert.equal(f.methods("turn/start").length, 1);
      const secondReply = "A fast second reply. سلام 🌍\n".repeat(350);
      f.state.beforeTurnAnswer = turn => {
        f.notify("turn/completed", {
          threadId: CHAT,
          turn: {
            id: turn.id,
            status: "completed",
            items: [
              { id: "progress", type: "agentMessage", phase: null, text: "Checking the files." },
              { id: "fast", type: "agentMessage", phase: null, text: secondReply },
            ],
          },
        });
      };
      f.notify("thread/realtime/transcript/done", { threadId: SPEECH, role: "assistant" });
      await until(() => f.methods("thread/realtime/appendSpeech").length === 2);
      assert.equal(required(required(f.methods("turn/start")[1]).params.input[0]).text, "Second spoken request");
      let spoken = "",
        count = 1;
      while (spoken.length < secondReply.length) {
        await until(() => f.methods("thread/realtime/appendSpeech").length === count + 1);
        const chunk = required(f.methods("thread/realtime/appendSpeech")[count]).params.text;
        assert.ok(Buffer.byteLength(chunk) <= 3596);
        spoken += chunk;
        count++;
        assert.equal(f.methods("turn/start").length, 2);
        f.notify("thread/realtime/transcript/done", { threadId: SPEECH, role: "assistant" });
      }
      assert.equal(spoken, secondReply);
      handoff("first", "First spoken request");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.methods("turn/start").length, 2);
      assert.equal(f.methods("turn/interrupt").length, 0);
      assert.equal(f.methods("turn/steer").length, 0);
      controller.abort();
      await reader.cancel().catch(() => {});
      await until(() => f.methods("thread/unsubscribe").filter(call => call.params.threadId === SPEECH).length === 1);
      assert.equal(required(f.methods("thread/realtime/stop")[0]).params.threadId, SPEECH);
    });
});

test("bridged voice retires pending handoffs and late speech on stop, disconnect or delivery failure", async t => {
  await t.test("stop during startup", async t => {
    const f = await fixture(t);
    Object.assign(f.state, { provider: "anthropic", holdStart: true });
    const { controller, reader } = await f.open(null, { live: true });
    await until(() => typeof f.state.finishStart === "function");
    assert.equal(required(f.methods("thread/realtime/start")[0]).params.threadId, SPEECH);
    controller.abort();
    await reader.cancel().catch(() => {});
    required(f.state.finishStart)();
    await until(() => f.methods("thread/unsubscribe").length === 1);
    assert.equal(required(f.methods("thread/realtime/stop")[0]).params.threadId, SPEECH);
    assert.equal(f.methods("turn/start").length, 0);
  });
  for (const outcome of ["stop", "disconnect", "append failure", "failed turn"])
    await t.test(outcome, async t => {
      const f = await fixture(t);
      Object.assign(f.state, { provider: "anthropic", model: "claude/opus" });
      const { controller, reader, next } = await f.open(null, { live: true });
      assert.equal((await next()).type, "sdp");
      const handoff = (id: string) =>
        f.notify("thread/realtime/itemAdded", {
          threadId: SPEECH,
          item: { type: "handoff_request", handoff_id: id, input_transcript: id },
        });
      handoff("request");
      handoff("queued");
      await until(() => f.methods("turn/start").length === 1);
      if (outcome === "stop") {
        controller.abort();
        await reader.cancel().catch(() => {});
      }
      if (outcome === "disconnect") f.socket.emit("close");
      if (outcome === "append failure") f.state.failAppend = true;
      f.notify("turn/completed", {
        threadId: CHAT,
        turn: {
          id: "voice-turn-1",
          status: outcome === "failed turn" ? "failed" : "completed",
          items: [{ id: "reply", type: "agentMessage", text: "The final reply." }],
        },
      });
      if (outcome !== "stop") assert.equal((await next()).type, "error");
      await until(() => f.client.listenerCount("side") === 0);
      handoff("late");
      f.notify("thread/realtime/transcript/done", { threadId: SPEECH, role: "assistant" });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.methods("turn/start").length, 1);
      assert.equal(f.methods("thread/realtime/appendSpeech").length, outcome === "append failure" ? 1 : 0);
      assert.equal(f.methods("turn/interrupt").length, 0, "ending voice does not interrupt the selected chat");
    });
});

test("a Claude chat's speech thread names a model the engine lists, never a missing one", async t => {
  const f = await fixture(t);
  Object.assign(f.state, { provider: "openai", model: "claude/opus" });
  // A Claude default in the config: the first native model listed instead.
  f.state.configModel = "claude/sonnet";
  await f.client.createSpeechThread(CHAT);
  assert.equal(required(f.methods("thread/start").at(-1)).params.model, "gpt-6.1-luna");
  // No native model anywhere: say so, and create nothing.
  const none = await fixture(t);
  Object.assign(none.state, {
    provider: "openai",
    model: "claude/opus",
    configModel: "claude/sonnet",
    listed: ["claude/opus"],
  });
  await assert.rejects(none.client.createSpeechThread(CHAT), /ChatGPT model/);
  assert.equal(none.methods("thread/start").length, 0);
});
