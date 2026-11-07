import assert from "node:assert/strict";
import { test } from "node:test";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Acp } from "../tools/elpis-claude/bridge-acp.mts";
import { createProviderCatalog } from "../tools/elpis-claude/bridge-catalog.mts";
import { createTestTempDir,removeTestTempDir } from "../apps/elpis-desktop/tests/temp-root.cts";

if (process.env.ACP_BOUNDARY_FIXTURE === "1") {
  const send = (msg: object) => process.stdout.write(JSON.stringify(msg) + "\n");
  readline.createInterface({ input: process.stdin }).on("line", line => {
    const msg = JSON.parse(line);
    if (msg.method === "session/prompt") {
      const updates = msg.params?.nullable ? [
        { sessionUpdate: "agent_message_chunk", messageId: null, content: { type: "text", text: "nullable" } },
        { sessionUpdate: "tool_call_update", toolCallId: "tool", kind: null, title: null, status: "completed", content: null, rawInput: null, _meta: null },
        { sessionUpdate: "usage_update", used: 10, size: 100, _meta: null },
        { sessionUpdate: "subagent_update", sessionId: "child", title: null, description: null, state: null, capabilities: null },
        { sessionUpdate: "session_message", content: null },
      ] : [
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: 42 } },
        { sessionUpdate: "plan", entries: [{ content: 42, status: "pending" }] },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "valid" } },
      ];
      for (const update of updates) send({ method: "session/update", params: { sessionId: "chat", update } });
    }
    const options = msg.params?.empty ? null : process.env.ACP_BOUNDARY_GROUPS ? [
      { id: "toggle", type: "boolean", currentValue: true },
      { id: "model", type: "select", currentValue: "fixture", options: [{ group: "local", name: "Local", options: [{ value: "fixture", name: "Fixture", description: "A fixture model" }] }] },
      { id: "effort", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
    ] : undefined;
    send({ id: msg.id, result: msg.method === "session/prompt" ? { stopReason: "end_turn", ...(msg.params?.nullable ? { _meta: null } : {}) } : msg.method === "session/new" ? { sessionId: msg.params.bad ? 42 : "child", ...(options === undefined ? {} : { configOptions: options, modes: null }) } : {} });
  });
} else {
  test("ACP session updates reject malformed payloads but deliver valid updates", async t => {
    const acp = new Acp({ key: "test", label: "test", adapter: fileURLToPath(import.meta.url), env: { ACP_BOUNDARY_FIXTURE: "1" }, speaker: "test", prefix: "test/", description: "", catalogFile: "", limits: async () => [] }, () => {});
    t.after(() => acp.kill());
    await acp.ready;
    const updates: unknown[] = [];
    acp.bySession.set("chat", { onUpdate: ({ update }) => updates.push(update) });
    await acp.call("session/prompt", { sessionId: "chat" });
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "valid" } });
  });
  test("ACP calls reject malformed replies and return valid session IDs", async t => {
    const acp = new Acp({ key: "test", label: "test", adapter: fileURLToPath(import.meta.url), env: { ACP_BOUNDARY_FIXTURE: "1" }, speaker: "test", prefix: "test/", description: "", catalogFile: "", limits: async () => [] }, () => {});
    t.after(() => acp.kill());
    await acp.ready;
    assert.equal((await acp.call("session/new", {})).sessionId, "child");
    assert.equal((await acp.call("session/new", { empty: true })).configOptions, null);
    await assert.rejects(acp.call("session/new", { bad: true }), /Invalid ACP response/);
  });
  test("ACP updates retain valid nullable fields and tool completion", async t => {
    const acp = new Acp({ key: "test", label: "test", adapter: fileURLToPath(import.meta.url), env: { ACP_BOUNDARY_FIXTURE: "1" }, speaker: "test", prefix: "test/", description: "", catalogFile: "", limits: async () => [] }, () => {});
    t.after(() => acp.kill());
    await acp.ready;
    const updates: string[] = [];
    acp.bySession.set("chat", { onUpdate: ({ update }) => updates.push(update.sessionUpdate) });
    await acp.call("session/prompt", { sessionId: "chat", nullable: true });
    assert.deepEqual(updates, ["agent_message_chunk", "tool_call_update", "usage_update", "subagent_update", "session_message"]);
  });
  test("ACP catalog accepts boolean settings and grouped model choices", async t => {
    const root = createTestTempDir(path.join(os.tmpdir(), "elpis-acp-catalog-"));
    const agent = { key: "test", label: "test", adapter: fileURLToPath(import.meta.url), env: { ACP_BOUNDARY_FIXTURE: "1", ACP_BOUNDARY_GROUPS: "1" }, speaker: "test", prefix: "test/", description: "", catalogFile: path.join(root, "catalog.json"), limits: async () => [] };
    const acp = new Acp(agent, () => {});
    t.after(() => { acp.kill(); removeTestTempDir(root); });
    await acp.ready;
    const catalog = createProviderCatalog({ readJson: async () => null, ensureAcp: async () => acp, now: () => 42, log: () => {} });
    const result = await catalog(agent);
    assert.deepEqual(result.models, [{ value: "fixture", name: "Fixture", description: "A fixture model" }]);
    assert.deepEqual(result.efforts.fixture, { levels: [{ reasoningEffort: "high", description: "High" }], current: "high" });
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(agent.catalogFile) || JSON.parse(fs.readFileSync(agent.catalogFile, "utf8")).at !== 42 || acp.pending.size) {
      assert.ok(Date.now() < deadline, "catalog refresh completed"); await pause(10);
    }
  });
}
