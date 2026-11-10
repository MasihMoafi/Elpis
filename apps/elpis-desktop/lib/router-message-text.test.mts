// 10 Nov, Masih: the router's wrapped messages showed long encoded IDs and JSON; people see only what was said.
import test from "node:test";
import assert from "node:assert/strict";
import { routerMessageText } from "./router-message-text.ts";

test("a router-wrapped message shows only what was said, and who said it when it was not him", () => {
  const wrap = (payload: object) =>
    `<elpis-router-message id="router%3Acandidate%3A22278d15c0294f3f1f78657cd3668eef">\n${JSON.stringify(payload)}`;
  assert.equal(routerMessageText(wrap({ kind: "candidate", from: "local-user", text: "hi", trigger_id: "f0497e9f" })), "hi");
  assert.equal(routerMessageText(wrap({ kind: "candidate", from: "arash", text: "status?" })), "arash: status?");
  assert.equal(routerMessageText(wrap({ kind: "worker_report", ticket_id: "33610d28" })), "(worker report)");
  assert.equal(routerMessageText('<elpis-router-message id="x" includes="a,b">\nplain words'), "plain words");
  assert.equal(routerMessageText("an ordinary message"), "an ordinary message");
});
