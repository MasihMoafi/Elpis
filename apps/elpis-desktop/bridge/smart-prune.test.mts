import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestTempDir, removeTestTempDir } from "../tests/temp-root.cts";
import { startDesktopServer } from "./server.mts";
import { DesktopClient } from "./client.mts";
import { smartPruneDetail } from "./smart-prune.mts";
import type { SmartPruneLogRecord } from "../../../codex-rs/app-server-protocol/schema/typescript/v2/SmartPruneLogRecord.ts";

const record: SmartPruneLogRecord = {
  attemptId: "p1", threadId: "chat-1", timestamp: "saved time", chatTitle: "Test chat", turnId: "turn-1", turnNumber: 2,
  model: "local", reasoningEffort: "low", estimatedSourceTokens: 100, estimatedAdmittedTokens: 20,
  estimatedSavedTokens: 80, note: null,
  items: [{ callId: "call-1", description: "command output", estimatedSourceTokens: 100, estimatedAdmittedTokens: 20,
    decision: "replaced", kept: "failures", original: "ORIGINAL", compact: "COMPACT", diff: "-ORIGINAL\n+COMPACT" }],
};
function fixture(unsupported = false, home?: string) {
  const socket = Object.assign(new EventEmitter(), { send(_raw: string) {}, close() {} });
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  let current = structuredClone(record);
  let failure: { code: number; message: string } | undefined;
  socket.send = raw => {
    const request = JSON.parse(raw);
    sent.push(request);
    const { items: _items, ...summary } = current;
    const result = request.method === "smartPrune/log/list"
      ? { data: [summary], nextCursor: "next", unreadable: 1 } : { record: current };
    queueMicrotask(() => socket.emit("message", JSON.stringify(unsupported
      ? { id: request.id, error: { code: -32601, message: "unknown method" } }
      : failure ? { id: request.id, error: failure } : { id: request.id, result })));
  };
  return { client: new DesktopClient(socket, { home, appHome: home }), sent,
    setRecord: (value: SmartPruneLogRecord) => { current = value; },
    fail: (message: string) => { failure = { code: -32603, message }; } };
}
test("global and inline history use the native projection and never admit an uncommitted replacement", async t => {
  const f = fixture();
  t.after(() => f.client.close());
  const page = await f.client.smartPruneLog("earlier");
  assert.equal(f.sent.at(-1)?.method, "smartPrune/log/list");
  assert.deepEqual(f.sent.at(-1)?.params, { cursor: "earlier", limit: 50 });
  assert.equal(page.unreadable, 1);
  assert.equal("items" in page.data[0]!, false);
  assert.deepEqual(await smartPruneDetail(f.client, "chat-1", "p1", "call-1"), { original: "ORIGINAL", compact: "COMPACT" });
  f.setRecord({ ...record, estimatedAdmittedTokens: 100, estimatedSavedTokens: 0,
    items: [{ ...record.items[0]!, decision: "kept", compact: null, estimatedAdmittedTokens: 100 }] });
  assert.deepEqual(await smartPruneDetail(f.client, "chat-1", "p1", "call-1"), { original: "ORIGINAL", compact: null });
  f.setRecord({ ...record, estimatedSavedTokens: null });
  await assert.rejects(smartPruneDetail(f.client, "chat-1", "p1", "call-1"), /evidence is unavailable/);
});
test("a detail request cannot display another chat or another attempt, and malformed evidence is rejected", async t => {
  const f = fixture();
  t.after(() => f.client.close());
  await assert.rejects(f.client.smartPruneRecord("chat-2", "p1"), /another Smart Prune record/);
  await assert.rejects(f.client.smartPruneRecord("chat-1", "p2"), /another Smart Prune record/);
  await assert.rejects(smartPruneDetail(f.client, "chat-1", "p1", "missing"), /not found/);
  await assert.rejects(f.client.smartPruneRecord("", "p1"), /Smart Prune chat/);
  await assert.rejects(f.client.smartPruneLog("x".repeat(4097)), /Smart Prune cursor/);
  f.setRecord({ ...record, estimatedSavedTokens: -1 });
  await assert.rejects(f.client.smartPruneRecord("chat-1", "p1"), /malformed/);
  f.fail("Smart Prune log exceeds the listing scan limit");
  await assert.rejects(f.client.smartPruneLog(), /listing scan limit/);
});
test("an older engine explicitly reports that history needs an update", async t => {
  const f = fixture(true);
  t.after(() => f.client.close());
  await assert.rejects(f.client.smartPruneLog(), /Update Elpis to view Smart Prune history/);
  await assert.rejects(f.client.smartPruneRecord("chat-1", "p1"), /Update Elpis to view Smart Prune history/);
});

test("global and inline HTTP history require authentication and use the same scoped native record", async t => {
  const home = createTestTempDir(path.join(os.tmpdir(), "prune-http-"));
  const f = fixture(false, home);
  const app = await startDesktopServer({ client: f.client, elpisHome: home,
    staticDir: fileURLToPath(new URL("../out", import.meta.url)), loveSpot: { directory: path.join(home, "love") } });
  t.after(async () => { await app.close(); removeTestTempDir(home); });
  const url = new URL(app.url), origin = url.origin;
  const endpoints = ["/api/smart-prune", "/api/smart-prune/chat-1/p1", "/api/threads/chat-1/smart-prune/p1/call-1"];
  for (const endpoint of endpoints) assert.equal((await fetch(origin + endpoint)).status, 401);
  const auth = await fetch(origin + "/api/session", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const cookie = auth.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const headers = { Cookie: cookie, Origin: origin };
  const listed = await (await fetch(origin + endpoints[0], { headers })).json();
  assert.equal(listed.data[0].attemptId, "p1");
  assert.equal("items" in listed.data[0], false);
  assert.deepEqual(await (await fetch(origin + endpoints[1], { headers })).json(), { record });
  assert.deepEqual(await (await fetch(origin + endpoints[2], { headers })).json(), { original: "ORIGINAL", compact: "COMPACT" });
  assert.equal((await fetch(origin + "/api/smart-prune/chat-2/p1", { headers })).status, 502);
});
