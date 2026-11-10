// 10 Nov, Masih: a router worker's chat showed its ticket as raw JSON with IDs and a router notice as his own message.
import test from "node:test";
import assert from "node:assert/strict";
import { routerMessageText } from "./router-message-text.ts";
import { noteRouterNotices } from "./router-worker-input.ts";

const wrap = (body: string) => `<elpis-router-message id="router%3Aassignment%3Aabc">\n${body}`;

test("a worker's ticket reads as its title, assignment and request, with no IDs", () => {
  const ticket = JSON.stringify({
    ticket_id: "0b11",
    title: "Fix Type Booster",
    assignment: "Routing note (not the source request): Fix the luna to ulna swap.",
    trigger: { trigger_id: "6e84", from: "local-user", thread: "elpis-chat:01a1", text: "luna types ulna - fix it" },
  });
  const shown = routerMessageText(wrap(ticket));
  assert.equal(shown, "Fix Type Booster\n\nFix the luna to ulna swap.\n\nRequest: luna types ulna - fix it");
  assert.doesNotMatch(shown, /ticket_id|trigger_id|0b11|[{}]/);
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
