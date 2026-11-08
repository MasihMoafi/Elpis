import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopClient } from "./client.mts";
import { rpcResult, type RpcResponses } from "./client-wire.mts";
import type { ThreadResumeResponse } from "../../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeResponse.ts";
import type { ExperimentalFeature } from "../../../codex-rs/app-server-protocol/schema/typescript/v2/ExperimentalFeature.ts";
import type { ExternalAgentConfigMigrationItem } from "../../../codex-rs/app-server-protocol/schema/typescript/v2/ExternalAgentConfigMigrationItem.ts";
import type { ConfigReadResponse } from "../../../codex-rs/app-server-protocol/schema/typescript/v2/ConfigReadResponse.ts";
import type { ConfigRequirements } from "../../../codex-rs/app-server-protocol/schema/typescript/v2/ConfigRequirements.ts";
import type { ThreadItem } from "../../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts";
import type { SessionSource } from "../../../codex-rs/app-server-protocol/schema/typescript/v2/SessionSource.ts";
import type { WorkGraphListResponse } from "../../../codex-rs/app-server-protocol/schema/typescript/v2/WorkGraphListResponse.ts";
import type { ThreadContextFilesListResponse } from "../../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadContextFilesListResponse.ts";

const CHAT = "00000000-0000-0000-0000-000000000001";
test("native config defaults and raw JSON layers remain readable", () => {
  // Projection of config/read from a private native app-server, including its unset realtime default.
  const config = {
    model_provider: "fixture",
    realtime: null,
    features: { multi_agent: false },
    mcp_servers: {},
  } satisfies Partial<ConfigReadResponse["config"]>;
  const result = { config, layers: [{ name: { type: "user", file: "/fixture/config.toml" }, version: "v1", config }] };
  assert.equal(rpcResult("config/read", result), result);
  // ConfigLayer.config is raw JSON, rather than the effective config's typed projection.
  for (const raw of [null, [], "raw", 1, true, { features: { multi_agent: null } }]) {
    assert.doesNotThrow(() => rpcResult("config/read", { config, layers: [{ config: raw }] }));
  }
  const requirements = {
    modelProvider: null,
    modelProviders: null,
    featureRequirements: null,
  } satisfies Partial<ConfigRequirements>;
  assert.equal(rpcResult("configRequirements/read", { requirements }).requirements, requirements);
  assert.doesNotThrow(() =>
    rpcResult("config/read", {
      config: { features: { multi_agent: null }, realtime: { voice: null }, mcp_servers: { disabled: { env: null } } },
    }),
  );
  for (const malformed of [
    { realtime: 42 },
    { realtime: { voice: 42 } },
    { features: { multi_agent: "yes" } },
    { mcp_servers: { broken: { env: [] } } },
  ]) {
    assert.throws(() => rpcResult("config/read", { config: malformed }), /malformed.*config\/read/i);
  }
  assert.throws(() => rpcResult("configRequirements/read", { requirements: { featureRequirements: [] } }), /malformed/);
});
test("native nullable response fields preserve compatibility without accepting malformed fields", () => {
  const collaborationMode: ThreadResumeResponse["collaborationMode"] = null;
  assert.equal(rpcResult("thread/resume", { thread: { id: CHAT }, collaborationMode }).collaborationMode, null);
  const feature: Pick<ExperimentalFeature, "name" | "stage" | "enabled" | "displayName" | "description"> = {
    name: "multi_agent",
    stage: "stable",
    enabled: true,
    displayName: null,
    description: null,
  };
  assert.equal(rpcResult("experimentalFeature/list", { data: [feature] }).data[0]?.displayName, null);
  assert.throws(() => rpcResult("experimentalFeature/list", { data: [{ ...feature, enabled: "yes" }] }), /malformed/);
  const details: ExternalAgentConfigMigrationItem["details"] = null;
  assert.equal(
    rpcResult("externalAgentConfig/detect", { items: [{ itemType: "config", details }] }).items[0]?.details,
    null,
  );
});
test("every native subagent source survives thread reads", () => {
  const sources: SessionSource[] = [
    { subAgent: "review" },
    { subAgent: "compact" },
    { subAgent: "memory_consolidation" },
    {
      subAgent: {
        thread_spawn: { parent_thread_id: CHAT, depth: 1, agent_path: null, agent_nickname: null, agent_role: null },
      },
    },
    { subAgent: { other: "guardian" } },
    { custom: "external-client" },
  ];
  for (const source of sources) {
    const result = { thread: { id: CHAT, source, turns: [] } };
    assert.equal(rpcResult("thread/read", result), result);
    assert.equal(rpcResult("thread/list", { data: [result.thread] }).data[0], result.thread);
  }
});
test("native reasoning content survives paginated history reads", () => {
  const reasoning = {
    type: "reasoning",
    id: "reasoning",
    summary: ["Summary"],
    content: ["Thinking"],
  } satisfies ThreadItem;
  const page = { data: [{ turnId: "turn", item: reasoning }], nextCursor: null, backwardsCursor: null };
  assert.equal(rpcResult("thread/items/list", page), page);
  assert.doesNotThrow(() => rpcResult("thread/turns/list", { data: [{ id: "turn", items: [reasoning] }] }));
  for (const content of [42, [42], [{ type: "text", text: "wrong reasoning representation" }]]) {
    assert.throws(
      () => rpcResult("thread/items/list", { data: [{ turnId: "turn", item: { ...reasoning, content } }] }),
      /malformed/,
    );
  }
  assert.throws(
    () =>
      rpcResult("thread/items/list", {
        data: [{ turnId: "turn", item: { type: "userMessage", id: "user", content: ["not UserInput"] } }],
      }),
    /malformed/,
  );
});

// Small responses are intentional: fake-app-server returns partial resume/read/page results.
// Complete native records below are checked against their generated protocol owners.
const threadReply = { valid: { thread: { id: CHAT } }, invalid: { thread: { id: 42 } } };
const contextFiles: ThreadContextFilesListResponse = {
  files: [
    {
      name: "AGENTS.md",
      path: "/project/AGENTS.md",
      group: "instructions",
      estimatedTokens: 10,
      included: true,
      reason: "Workspace instructions",
      selectable: true,
    },
  ],
};
const graph: WorkGraphListResponse = {
  data: [
    {
      id: "graph",
      name: "Build",
      status: "completed",
      maxConcurrency: 1,
      eventCount: 1,
      error: null,
      worktreeReport: null,
      tasks: [
        {
          id: "task",
          kind: "agent",
          title: "Build",
          status: "completed",
          dependencies: [],
          assignedThreadId: null,
          provider: null,
          model: null,
          result: null,
          evidence: [],
          failureReason: null,
        },
      ],
    },
  ],
};
const cases = {
  "config/read": { valid: { config: { features: { multi_agent: false } } }, invalid: { config: [] } },
  "configRequirements/read": { valid: { requirements: null }, invalid: { requirements: "invalid" } },
  "thread/read": threadReply,
  "thread/start": threadReply,
  "thread/resume": threadReply,
  "thread/subscribe": threadReply,
  "thread/fork": threadReply,
  "thread/unarchive": threadReply,
  "thread/register": threadReply,
  "thread/list": { valid: { data: [{ id: CHAT }], nextCursor: null }, invalid: { data: [{ id: 42 }] } },
  "thread/turns/list": { valid: { data: [{ id: "turn" }], nextCursor: null }, invalid: { data: [{ id: 42 }] } },
  "thread/items/list": {
    valid: {
      data: [{ turnId: "turn", item: { type: "agentMessage", id: "answer", text: "Answer" } }],
      nextCursor: null,
    },
    invalid: { data: [{ turnId: "turn", item: null }] },
  },
  "turn/start": { valid: { turn: { id: "turn", status: "inProgress", items: [] } }, invalid: { turn: { id: 42 } } },
  "review/start": {
    valid: { turn: { id: "turn" }, reviewThreadId: CHAT },
    invalid: { turn: { id: "turn" }, reviewThreadId: null },
  },
  "turn/settings/update": { valid: { status: "applied" }, invalid: { status: 42 } },
  "thread/goal/get": { valid: { goal: null }, invalid: null },
  "thread/contextFiles/list": {
    valid: contextFiles,
    invalid: { files: [{ ...contextFiles.files[0], included: "yes" }] },
  },
  "thread/contextFiles/set": { valid: contextFiles, invalid: { files: null } },
  "externalAgentConfig/detect": {
    valid: {
      items: [
        { itemType: "sessions", details: { sessions: [{ path: "/project/session.json", cwd: null, title: null }] } },
      ],
    },
    invalid: { items: [{ details: { sessions: [42] } }] },
  },
  "externalAgentConfig/import": { valid: { importId: "import" }, invalid: { importId: 42 } },
  "externalAgentConfig/import/readHistories": {
    valid: { data: [{ importId: "import", successes: [], failures: [{ message: "Unreadable session" }] }] },
    invalid: { data: [{ importId: "import", successes: [], failures: [null] }] },
  },
  "experimentalFeature/list": {
    valid: {
      data: [{ stage: "stable", name: "multi_agent", enabled: false, displayName: null, description: null }],
      nextCursor: null,
    },
    invalid: { data: [{ stage: "stable", name: "multi_agent", enabled: "yes" }] },
  },
  "account/login/start": { valid: { type: "apiKey" }, invalid: { authUrl: 42 } },
  "workGraph/list": { valid: graph, invalid: { data: [{ ...graph.data[0], tasks: [null] }] } },
  "account/read": { valid: { account: null }, invalid: { account: { type: 42 } } },
  "thread/realtime/listVoices": {
    valid: { voices: { v1: ["alloy"], defaultV1: "alloy", v2: ["alloy"], defaultV2: "alloy" } },
    invalid: { voices: { v1: [42], defaultV1: "alloy" } },
  },
  "claudeAccounts/read": {
    valid: { activeId: "primary", accounts: [{ id: "primary", authenticated: true, duplicate: false }] },
    invalid: { activeId: "primary", accounts: null },
  },
  "claudeAccounts/write": { valid: { activeId: "primary", accounts: [] }, invalid: { activeId: 42, accounts: [] } },
  "claudeSubscription/write": { valid: { signedOut: false }, invalid: { signedOut: "yes" } },
} satisfies Record<keyof RpcResponses, { valid: unknown; invalid: unknown }>;
for (const [method, { valid, invalid }] of Object.entries(cases))
  test(`${method} accepts its protocol/fixture response and rejects malformed data`, () => {
    assert.equal(rpcResult(method, valid), valid);
    assert.throws(() => rpcResult(method, invalid), /malformed/);
  });

test("desktop socket rejects malformed envelopes and typed results while valid traffic continues", async () => {
  const home = mkdtempSync(join(tmpdir(), "desktop-wire-"));
  let result: unknown = {};
  const socket = Object.assign(new EventEmitter(), {
    close() {},
    send(raw: string) {
      const request = JSON.parse(raw) as { id?: string };
      if (request.id) queueMicrotask(() => socket.emit("message", JSON.stringify({ id: request.id, result })));
    },
  });
  const client = new DesktopClient(socket, { home, appHome: home });
  try {
    for (const value of [
      null,
      [],
      1,
      "text",
      { method: 4 },
      { method: "thread/name/updated", params: null },
      { id: {} },
    ]) {
      assert.doesNotThrow(() => socket.emit("message", JSON.stringify(value)));
    }
    for (result of [
      null,
      [],
      { thread: null },
      { thread: { id: CHAT, cwd: 42 } },
      { thread: { id: CHAT, source: { subAgent: 42 } } },
      { thread: { id: CHAT, turns: [{ id: "turn", items: [{ id: "item", type: "agentMessage", text: 42 }] }] } },
    ]) {
      await assert.rejects(client.readThreadMetadata(CHAT), /malformed.*thread\/read/i);
    }
    result = { config: "invalid" };
    await assert.rejects(client.sideRpc("config/read", {}), /malformed.*config\/read/i);
    result = {
      config: { realtime: null, features: { multi_agent: null }, mcp_servers: { disabled: { env: null } } },
      layers: null,
    };
    assert.deepEqual(await client.sideRpc("config/read", {}), result);
    result = { thread: { id: CHAT, cwd: "/project", path: null, source: "cli", status: { type: "idle" } } };
    assert.equal((await client.readThreadMetadata(CHAT)).id, CHAT);
    result = { thread: { id: CHAT, source: { subAgent: { thread_spawn: {} } } } };
    assert.equal((await client.readThreadMetadata(CHAT)).id, CHAT);
    result = {};
    await client.initialize();
    assert.equal(client.connected, true);
    const events: unknown[] = [];
    client.on("event", event => events.push(event));
    socket.emit(
      "message",
      JSON.stringify({ method: "thread/name/updated", params: { threadId: CHAT, threadName: "Renamed" } }),
    );
    assert.equal(events.length, 1);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});
