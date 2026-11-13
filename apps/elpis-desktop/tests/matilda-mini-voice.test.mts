// 13 Nov, Masih, on the pinned Matilda's small chat: "the read-aloud differs from what I see on the screen". Her reply
// streams from the bridge as it is written, then is replaced by its cleaned-up final text; what she says must be the
// words shown, started at her first finished sentence, with nothing skipped or said twice.
import "./alias.mts";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, delta } from "../bridge/love-spot-talk.fixtures.mts";
import type { Entry } from "../lib/api.ts";

const { herReplies, miniVoice, speakReplies, shownReply } = await import("../components/matilda-mini-voice.ts");
const { spokenPieces } = await import("../components/read-aloud-text.ts");

const words = (text: string) => spokenPieces(text).join(" ").split(/\s+/).filter(Boolean);

/** Drives the bridge's Love Spot chat as the small chat sees it, speaking each update as the small chat does. */
async function conversation(t: test.TestContext, reply: string[], final: string) {
  const f = await fixture(t);
  const voice = miniVoice(),
    fed: { text: string; update: number }[] = [];
  let update = 0,
    shown = "";
  const stop = await f.talk.watch(value => {
    update++;
    const replies = herReplies(value.entries as Entry[], new Set());
    shown = replies.map(item => shownReply(item.text)).join(" ");
    speakReplies(voice, replies, {
      busy: value.busy,
      enabled: true,
      open: () => ({ feed: text => fed.push({ text, update }), end: () => {}, done: Promise.resolve() }),
    });
  });
  t.after(() => stop());
  await f.talk.send({ text: "Hi Matilda", pinned: true });
  const streaming: number[] = [];
  for (const part of reply) {
    delta(f, part);
    streaming.push(update);
  }
  f.finish("turn-1", "completed", final);
  return { fed, shown, streaming };
}

test("her voice says the words shown, starting while she still writes", async t => {
  const reply = ["<!--matilda:smile-->", "Hello **there**. ", "How are you today? ", "I drew a box for you."];
  const { fed, shown, streaming } = await conversation(t, reply, reply.join(""));
  assert.equal(shown, "Hello there. How are you today? I drew a box for you.");
  assert.deepEqual(words(fed.map(item => item.text).join(" ")), words(shown), JSON.stringify(fed));
  assert.ok(fed[0] && fed[0].update <= streaming[1]!, `her first sentence is spoken before the reply ends: ${JSON.stringify({ fed, streaming })}`);
});

test("a reply with a painting and a list is spoken as shown, without the painting", async t => {
  const reply = [
    "<!--matilda:listening-->",
    "Here is the plan. ",
    "- **First** the header.\n",
    "- Then `the footer`.\n",
    '```excalidraw\n[{"type":"rectangle","x":0,"y":0,"width":10,"height":10}]\n```\n',
    "Tell me what you think.",
  ];
  const { fed, shown } = await conversation(t, reply, reply.join(""));
  assert.doesNotMatch(shown, /excalidraw|rectangle|matilda:/);
  assert.deepEqual(words(fed.map(item => item.text).join(" ")), words(shown), JSON.stringify({ fed, shown }));
});

test("with her voice off, or after he stops her, nothing more of the reply is spoken", () => {
  const fed: string[] = [],
    open = () => ({ feed: (text: string) => fed.push(text), end: () => {}, done: Promise.resolve() });
  const reply = (text: string) => [{ id: "turn:reply", text }];
  speakReplies(miniVoice(), reply("<!--matilda:smile-->Hello there. More"), { busy: true, enabled: false, open });
  assert.deepEqual(fed, [], "voice off");
  const voice = miniVoice();
  speakReplies(voice, reply("<!--matilda:smile-->Hello there. More"), { busy: true, enabled: true, open });
  assert.deepEqual(fed, ["Hello there. "]);
  voice.suppress = true;
  speakReplies(voice, reply("<!--matilda:smile-->Hello there. More words. And"), { busy: true, enabled: true, open });
  speakReplies(voice, reply("Hello there. More words. And the end."), { busy: false, enabled: true, open });
  assert.deepEqual(fed, ["Hello there. "], "stopped mid-reply stays stopped");
});
