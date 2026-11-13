// 10 Nov, Masih: a router worker's chat showed its ticket as raw JSON with IDs and a router notice as his own message.
import test from "node:test";
import assert from "node:assert/strict";
import { routerMessageText } from "./router-message-text.ts";
import { noteRouterNotices } from "./router-worker-input.ts";

const wrap = (body: string) => `<elpis-router-message id="router%3Aassignment%3Aabc">\n${body}`;

// 13 Nov, Masih: a worker chat printed his request twice, as the router's title and in his own words.
test("a worker's ticket reads as his request and the router's note, once each, with no IDs", () => {
  const ticket = JSON.stringify({
    ticket_id: "0b11",
    title: "Fix Type Booster",
    assignment: "Routing note (not the source request): He wants it done on Opus 5.5.",
    trigger: { trigger_id: "6e84", from: "local-user", thread: "elpis-chat:01a1", text: "luna types ulna - fix it" },
  });
  const shown = routerMessageText(wrap(ticket));
  assert.equal(shown, "luna types ulna - fix it\n\nNote from Elpis: He wants it done on Opus 5.5.");
  assert.doesNotMatch(shown, /ticket_id|trigger_id|0b11|[{}]|Fix Type Booster/);
  const plain = JSON.stringify({ ticket_id: "0b12", title: "Count words in NOTICE", trigger: { trigger_id: "6e85", text: "Count the words of NOTICE" } });
  assert.equal(routerMessageText(wrap(plain)), "Count the words of NOTICE", "no note: only his words");
});

test("a ticket without his words still names its work by its title", () => {
  const ticket = JSON.stringify({ ticket_id: "0b13", title: "Answer the CI failure", assignment: "Check the failing job.", trigger: { trigger_id: "6e86" } });
  assert.equal(routerMessageText(wrap(ticket)), "Answer the CI failure\n\nCheck the failing job.");
  assert.equal(routerMessageText(wrap(JSON.stringify({ ticket_id: "0b14", assignment: 2 }))), "Assignment 2 started again.");
});

test("router notices become quiet notes; a person's message stays his", () => {
  const entry = (id: string, text: string) => ({ turnId: "t", item: { id, type: "userMessage", content: [{ type: "text", text }] } });
  const out = noteRouterNotices([
    entry("a", wrap("This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate.")),
    entry("b", "status?"),
  ]);
  assert.deepEqual(out.map(e => e.item.type), ["routerNote", "userMessage"]);
  assert.equal(out[0]!.item.text, "Elpis resumed this ticket for the message below.");
  const plain = [entry("c", "hello")];
  assert.equal(noteRouterNotices(plain), plain, "chats without notices pass through unchanged");
});
