import test from "node:test";
import assert from "node:assert/strict";
import { required, CHAT, SPEECH, OTHER, offer, until, fixture } from "./read-aloud.fixtures.mts";

test("a speech thread warmed when a chat's reply actions show is used by its next Read aloud; another chat's is closed", async t => {
  const f = await fixture(t);
  Object.assign(f.state, { provider: "openai", model: "claude/opus" });
  assert.equal((await f.post("voice/read-aloud/warm", { threadId: CHAT })).status, 200);
  await f.post("voice/read-aloud/warm", { threadId: CHAT });
  assert.equal(f.methods("thread/start").length, 1, "one warm thread per chat, however often the actions show");
  const { controller, reader, next } = await f.open("Warm words.");
  assert.equal((await next()).type, "session");
  assert.equal((await next()).type, "sdp");
  assert.equal(f.methods("thread/start").length, 1, "Read aloud uses the warm thread");
  assert.equal(required(f.methods("thread/realtime/start")[0]).params.threadId, SPEECH);
  controller.abort();
  await reader.cancel().catch(() => {});
  await until(() => f.methods("thread/unsubscribe").length === 1);
  // A thread warmed for another chat is not used here and is closed when this chat warms its own.
  await f.post("voice/read-aloud/warm", { threadId: OTHER });
  await f.post("voice/read-aloud/warm", { threadId: CHAT });
  assert.equal(f.methods("thread/start").length, 3);
  await until(() => f.methods("thread/unsubscribe").length === 2, "the other chat's warm thread is closed");
  assert.equal((await f.post("voice/read-aloud/warm", { threadId: "not a thread" })).status, 400);
});

test("an open Read aloud call reads a further reply without a new call; a finished call refuses it", async t => {
  const f = await fixture(t);
  const { controller, reader, next } = await f.open("First reply.");
  const session = await next();
  await next();
  await f.post("voice/read-aloud/ready", { id: session.id });
  await until(() => f.methods("thread/realtime/appendSpeech").length === 1);
  f.notify("thread/realtime/transcript/done", { threadId: SPEECH, role: "assistant", text: "First reply." });
  assert.equal((await next()).type, "complete");
  assert.equal((await f.post("voice/read-aloud/more", { id: session.id, text: "Second reply." })).status, 200);
  await until(() => f.methods("thread/realtime/appendSpeech").length === 2);
  assert.deepEqual(required(f.methods("thread/realtime/appendSpeech")[1]).params, {
    threadId: SPEECH,
    text: "Second reply.",
  });
  await until(() => f.controls.filter(e => e.type === "cue").length === 2, "the second reply is cued");
  f.notify("thread/realtime/transcript/done", { threadId: SPEECH, role: "assistant", text: "Second reply." });
  assert.equal((await next()).type, "complete", "the second reply completes on the same call");
  assert.equal(f.methods("thread/realtime/start").length, 1);
  assert.equal((await f.post("voice/read-aloud/more", { id: "stale", text: "x" })).status, 409);
  controller.abort();
  await reader.cancel().catch(() => {});
  await until(() => f.methods("thread/unsubscribe").length === 1);
  assert.equal(
    (await f.post("voice/read-aloud/more", { id: session.id, text: "Too late." })).status,
    409,
    "a closed call reads nothing more",
  );
});

test("a finished Read aloud call kept open yields to a new voice call instead of refusing it", async t => {
  const f = await fixture(t);
  const { reader, next } = await f.open("Done reading.");
  const session = await next();
  await next();
  await f.post("voice/read-aloud/ready", { id: session.id });
  await until(() => f.methods("thread/realtime/appendSpeech").length === 1);
  f.notify("thread/realtime/transcript/done", { threadId: SPEECH, role: "assistant", text: "Done reading." });
  assert.equal((await next()).type, "complete");
  assert.equal(
    (await f.post("voice", { threadId: CHAT, sdp: offer })).status,
    409,
    "its last words may still be playing",
  );
  await new Promise(resolve => setTimeout(resolve, 2100));
  const live = await f.post("voice", { threadId: CHAT, sdp: offer });
  assert.equal(live.status, 200, "an idle Read aloud call gives the speaker to the new call");
  let rest = "";
  for (;;) {
    const row = await reader.read();
    if (row.done) break;
    rest += new TextDecoder().decode(row.value);
  }
  assert.doesNotMatch(rest, /"error"/, "the idle call ends quietly");
  await until(() => f.methods("thread/unsubscribe").length >= 1);
});
