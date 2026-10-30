// Real provider bridge -> selected engine -> DesktopClient. Inference is scripted.
// Default: deterministic engine contract; A124_ENGINE=/absolute/native/binary: real runtime gate.
// A124: follow-ups, late steering replies and reconnects must retain answers and completion.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import mockProvider from "../../../scripts/lib/mock-provider.js";
const { DesktopClient } = await import(process.env.A124_CLIENT ? pathToFileURL(process.env.A124_CLIENT) : new URL("../../../apps/elpis-desktop/bridge/client.mjs", import.meta.url));

const source = fileURLToPath(new URL("../", import.meta.url));
const engine = process.env.A124_ENGINE ?? path.join(source, "test/fake-app-server.mjs");
const lines = file => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
async function until(check, label, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(10)) { const value = await check(); if (value) return value; }
  assert.fail(label);
}

async function fixture(t, extra = {}, { model = "claude/sonnet", prepare, connectOptions, nativeCalls = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a124-"));
  const carrier = new mockProvider.Provider();
  await carrier.start();
  t.after(() => {
    carrier.close();
    if (!nativeCalls) assert.equal(carrier.requests.length + carrier.titleRequests.length, 0, "the native carrier must not perform inference for a provider turn");
  });
  const home = path.join(root, "elpis");
  fs.mkdirSync(home);
  // The real carrier can prewarm its model at thread/start. Keep every native
  // request local and fail on inference; Claude is the only inference owner.
  fs.writeFileSync(path.join(home, "config.toml"), `model="gpt-5.5"\nmodel_provider="carrier"\nmodel_catalog_json=${JSON.stringify(path.resolve(source, "../../codex-rs/models-manager/models.json"))}\n[features]\ncode_mode=false\n[model_providers.carrier]\nname="offline carrier"\nbase_url=${JSON.stringify(carrier.url)}\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  const socketPath = path.join(root, "bridge.sock");
  const storeFile = path.join(root, "sessions.json"), agentLog = path.join(root, "agent.jsonl");
  const release = path.join(root, "release"), toolRelease = path.join(root, "tools");
  const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: path.join(root, "elpis"), CODEX_HOME: path.join(root, "elpis"), CODEX_AUTH_HOME: root,
    XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root, TMPDIR: root, ELPIS_SHARED_BRIDGE: "1", ELPIS_BRIDGE_SOCKET: socketPath,
    ELPIS_ENGINE_BIN: engine, ACP_ADAPTER: path.join(source, "test/fake-acp-agent.mjs"),
    ACP_BRIDGE_STORE: storeFile, ACP_BRIDGE_LOG: path.join(root, "bridge.log"), ELPIS_NO_AGY: "1", ACP_BRIDGE_NO_AGENTS: "1",
    FAKE_ENGINE_STATE: path.join(root, "native.json"), FAKE_ENGINE_LAZY_PERSIST: "1", FAKE_ENGINE_LOG: path.join(root, "engine.jsonl"),
    FAKE_ACP_LOG: agentLog, FAKE_ACP_MODELS: "sonnet", FAKE_ACP_NAME: "Claude", FAKE_ACP_RELEASE: release, FAKE_ACP_TOOL_RELEASE: toolRelease,
    FAKE_ACP_NEXT_TOOL_RELEASE: path.join(root, "next-tool"), FAKE_ACP_BETWEEN_TOOL_RELEASE: path.join(root, "between-tools"), ...extra };
  await prepare?.(root, env);
  const bridges = [];
  let errors = "";
  const launch = () => {
    const child = spawn(process.execPath, [process.env.A124_BRIDGE ?? path.join(source, "acp-bridge.mjs")], { env, cwd: root, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", data => { errors += data; });
    bridges.push(child); return child;
  };
  const bridge = launch();
  const clients = [];
  t.after(async () => {
    clients.forEach(client => client.close());
    for (const child of bridges) {
      if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); child.kill("SIGCONT"); await ended; }
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    fs.writeFileSync(path.join(root, "stderr.log"), errors);
    // Evidence is retained in this owned throwaway home; never inspect or alter a real home.
    t.diagnostic(`A124 evidence: ${root}`);
    t.diagnostic(`engine: ${fs.realpathSync(engine)}; bridge: ${env.ELPIS_BRIDGE_SOCKET}`);
    if (errors.trim()) t.diagnostic(`bridge stderr: ${errors.slice(-2000)}`);
  });
  await until(() => (fs.statSync(socketPath, { throwIfNoEntry: false })?.mode & 0o777) === 0o600, `bridge starts: ${errors}`);
  const connect = async () => {
    const client = await DesktopClient.connect({ socketPath, timeoutMs: 5000, rewindHome: path.join(root, "rewind"), archiveDirectory: path.join(root, "archive"), ...connectOptions });
    clients.push(client);
    const events = [];
    client.on("event", event => { if (event.type === "message") events.push(event.data); });
    return { client, events };
  };
  const desktop = await connect();
  await desktop.client.models();
  const created = await desktop.client.createThread({ model, cwd: root });
  const id = created.thread.id;
  const restart = async ({ crash = false, reconnect = false } = {}) => {
    const previous = fs.statSync(socketPath);
    if (!reconnect) clients.forEach(client => client.close());
    const ended = once(bridge, "exit");
    if (crash) process.kill(-bridge.pid, "SIGKILL"); else bridge.kill("SIGTERM");
    await ended;
    launch();
    await until(() => {
      // The restarting bridge unlinks the stale socket before it binds, so the path can vanish between two checks.
      const next = fs.statSync(socketPath, { throwIfNoEntry: false });
      if (!next) return false;
      return (next.ino !== previous.ino || next.ctimeMs !== previous.ctimeMs) && (next.mode & 0o777) === 0o600;
    }, "the new bridge replaces the dead listener");
    if (reconnect) { await until(() => desktop.client.connected, "the existing desktop reconnects"); return desktop; }
    return connect();
  };
  return { ...desktop, id, root, connect, restart, bridge, env, carrier,
    freeze: async () => { bridge.kill("SIGSTOP"); await until(() => /^State:\s+T/m.test(fs.readFileSync(`/proc/${bridge.pid}/status`, "utf8")), "the old bridge is stopped before Claude writes"); },
    agent: () => lines(agentLog), store: () => fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, "utf8")) : {},
    release: () => fs.writeFileSync(release, ""), releaseTools: () => fs.writeFileSync(toolRelease, ""),
    releaseNextTool: () => fs.writeFileSync(env.FAKE_ACP_NEXT_TOOL_RELEASE, ""),
    releaseBetweenTools: () => fs.writeFileSync(env.FAKE_ACP_BETWEEN_TOOL_RELEASE, ""),
    ended: turnId => desktop.events.find(e => e.method === "turn/completed" && e.params.turn.id === turnId) };
}

test("Subagents Off denies shell agents in Claude session options and survives reconnect/restart; On restores access", { timeout: 20000 }, async t => {
  const f = await fixture(t, {}, { prepare: (root, env) => {
    env.FAKE_ENGINE_CONFIG = path.join(root, "config.json");
    fs.writeFileSync(env.FAKE_ENGINE_CONFIG, JSON.stringify({ config: { features: { multi_agent: true } }, layers: [{ name: { type: "user" }, version: "v1" }] }));
  } });
  const turn = async client => {
    const result = await client.send(f.id, { text: "Please do this work." });
    await until(() => f.ended(result.turn.id), "the turn completes");
    return f.agent().findLast(e => ["session/new", "session/load"].includes(e.method) && e.params._meta)?.params;
  };
  const on = await turn(f.client);
  assert.equal(on._meta.claudeCode.options.disallowedTools, undefined, "On leaves shell launches and agent tools unchanged");
  const current = await f.client.contextSwitches();
  assert.equal(current.subagents, true);
  assert.equal((await f.client.saveContextSwitches({ version: current.version, subagents: false })).subagents, false);
  const off = await turn(f.client);
  assert.equal(off.sessionId, f.store()[f.id].session, "the existing Claude session reloads with the changed restrictions");
  const denied = off._meta.claudeCode.options.disallowedTools ?? [];
  for (const cli of ["claude", "codex", "agy", "elpis", "gemini"]) {
    assert.ok(denied.includes(`Bash(${cli}:*)`), `Off must deny ${cli} -p ... through Bash`);
  }
  for (const tool of ["list_models", "delegate", "delegate_status", "delegate_steer", "delegate_stop"]) assert.ok(denied.includes(`mcp__elpis-agents__${tool}`), `configured delegate MCP tool ${tool} cannot bypass Off`);
  assert.ok(!denied.some((d) => /workflow$|elpis-agents__\*/.test(d)), "the workflow tool stays: the runtime starts it only when the person asks (WR6)");
  assert.match(off._meta.systemPrompt.append, /Subagents are disabled/);
  assert.match(off._meta.systemPrompt.append, /shell/i);
  assert.match(off._meta.systemPrompt.append, /claude.*codex.*agy.*elpis.*gemini/);
  const reopened = await f.connect();
  assert.equal((await reopened.client.contextSwitches()).subagents, false, "reopening a client reads the saved state");
  const restarted = await f.restart();
  assert.equal((await restarted.client.contextSwitches()).subagents, false, "the saved state survives a bridge/engine restart");
  // f.ended follows the initial desktop; observe the restarted client for subsequent turns.
  const afterRestart = await restarted.client.send(f.id, { text: "Continue after restart." });
  await until(() => restarted.events.some(e => e.method === "turn/completed" && e.params.turn.id === afterRestart.turn.id), "the reopened turn completes");
  const reloaded = f.agent().findLast(e => ["session/new", "session/load"].includes(e.method) && e.params._meta).params;
  assert.deepEqual(reloaded._meta.claudeCode.options.disallowedTools, denied);
  const saved = await restarted.client.contextSwitches();
  assert.equal((await restarted.client.saveContextSwitches({ version: saved.version, subagents: true })).subagents, true);
  const back = await restarted.client.send(f.id, { text: "Continue with Subagents On." });
  await until(() => restarted.events.some(e => e.method === "turn/completed" && e.params.turn.id === back.turn.id), "the enabled turn completes");
  const enabled = f.agent().findLast(e => ["session/new", "session/load"].includes(e.method) && e.params._meta).params;
  assert.equal(enabled._meta.claudeCode.options.disallowedTools, undefined);
  assert.doesNotMatch(enabled._meta.systemPrompt.append, /Subagents are disabled/);
});

for (const recover of [false, true]) test(`${recover ? 'recovering' : 'saving'} a new provider turn keeps history beyond 200 turns reachable`, { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const store = f.store();
  const turns = Array.from({ length: 205 }, (_, index) => ({ id: `earlier-${index}`, startedAt: index + 1, status: 'completed', items: [{ id: `prompt-${index}`, type: 'userMessage', content: [{ type: 'text', text: `Earlier prompt ${index}` }] }] }));
  store[f.id] = { ...store[f.id], turns };
  // The live bridge may still read startup events while this independent writer seeds history.
  const replacement = `${f.env.ACP_BRIDGE_STORE}.replacement`;
  fs.writeFileSync(replacement, JSON.stringify(store));
  fs.renameSync(replacement, f.env.ACP_BRIDGE_STORE);
  const { turn } = await f.client.send(f.id, { text: `${recover ? '[wait] [record-only] ' : ''}Continue the long chat` });
  let reader = f.client;
  if (recover) {
    await until(() => f.agent().some(event => event.method === 'session/prompt'), 'the provider turn starts');
    await f.freeze(); f.release();
    await until(() => f.agent().some(event => event.ended), 'the provider records its answer');
    assert.equal(f.ended(turn.id), undefined, 'the bridge has not received a live completion');
    reader = (await f.restart({ crash: true })).client;
    await reader.readThread(f.id);
  } else await until(() => f.ended(turn.id), 'the new answer completes');
  assert.equal(f.store()[f.id].turns.length, 206, 'saving must not discard the oldest turns');
  const all = [], cursors = new Set();
  let cursor;
  do {
    const page = await reader.readThread(f.id, { limit: 100, ...(cursor ? { cursor } : {}) });
    all.push(...page.data);
    cursor = page.nextCursor;
    assert.ok(!cursor || !cursors.has(cursor), 'history continuation must advance');
    cursors.add(cursor);
  } while (cursor);
  assert.equal(all.filter(entry => entry.item.id === 'prompt-0').length, 1, 'the first prompt remains reachable exactly once');
  assert.equal(new Set(all.filter(entry => entry.item.type === 'userMessage').map(entry => entry.item.id)).size, 206);
});

for (const count of [1, 4]) test(`A128: ${count} messages during a tool survive the next tool starting before delivery`, { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const initial = "[wait] [tool-flight] [tool-race] original";
  const { turn } = await f.client.send(f.id, { text: initial });
  await until(() => f.agent().some(e => e.toolStarted === "t1"), "first slow tool starts");
  const followups = Array.from({ length: count }, (_, n) => `follow-up ${n + 1} — پیام`);
  for (const text of followups) await f.client.steer(f.id, { text, expectedTurnId: turn.id });
  assert.equal(f.agent().filter(e => e.method === "_session/steering").length, 0);
  f.releaseTools();
  await until(() => f.events.some(e => e.method === "item/started" && e.params.item.id === "t2"), "desktop sees the second slow tool");
  await f.client.readThread(f.id);
  assert.equal(f.agent().filter(e => e.interruptedTool).length, 0, "Enter must not reject a running tool: The user doesn't want to proceed with this tool use");
  f.releaseNextTool();
  await until(() => f.agent().filter(e => e.method === "_session/steering").length === count || f.ended(turn.id), "waiting messages reach the next safe point");
  f.release();
  await until(() => f.ended(turn.id), "the original turn ends");
  assert.equal(f.ended(turn.id).params.turn.status, "completed", "Enter must not interrupt the task");
  const trace = f.agent();
  assert.equal(trace.filter(e => e.method === "session/cancel").length, 0);
  const finished = trace.findIndex(e => e.toolCompleted === "t2");
  assert.ok(finished >= 0 && finished < trace.findIndex(e => e.method === "_session/steering"), "tool completion precedes delivery");
  const saved = f.store()[f.id].turns[0];
  assert.deepEqual(saved.items.filter(i => i.type === "userMessage").map(i => i.content[0].text), [initial, ...followups]);
  const answer = saved.items.filter(i => i.type === "agentMessage").at(-1).text;
  for (const text of followups) assert.ok(answer.includes(text));
  assert.equal((await f.client.readThread(f.id)).thread.status.type, "idle");
});

test("A128: a message between tools is delivered before the next tool", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const { turn } = await f.client.send(f.id, { text: "[wait] [tool-flight] [tool-gap] original" });
  await until(() => f.agent().some(e => e.toolStarted === "t1"), "first tool starts");
  f.releaseTools();
  await until(() => f.agent().some(e => e.betweenTools), "first tool ends");
  await f.client.steer(f.id, { text: "between the tools", expectedTurnId: turn.id });
  await until(() => f.agent().some(e => e.method === "_session/steering"), "message reaches Claude at the tool boundary");
  f.releaseBetweenTools(); f.releaseNextTool(); f.release();
  await until(() => f.ended(turn.id), "the task completes");
  assert.equal(f.ended(turn.id).params.turn.status, "completed");
  const trace = f.agent();
  assert.equal(trace.filter(e => e.interruptedTool).length, 0);
  assert.ok(trace.findIndex(e => e.method === "_session/steering") < trace.findIndex(e => e.toolStarted === "t2"));
  assert.ok(f.events.some(e => e.method === "item/completed" && e.params.item.text?.includes("answered:") && e.params.item.text.includes("between the tools")));
});

test("A128: Stop interrupts the slow tool and cancels waiting messages", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const { turn } = await f.client.send(f.id, { text: "[wait] [tool-flight] [tool-race] stop this" });
  await until(() => f.agent().some(e => e.toolStarted === "t1"), "slow tool starts");
  await f.client.steer(f.id, { text: "waiting until it is safe", expectedTurnId: turn.id });
  await f.client.interrupt(f.id, { turnId: turn.id });
  await until(() => f.ended(turn.id), "Stop ends the task without releasing the tool gate");
  assert.equal(f.ended(turn.id).params.turn.status, "interrupted");
  assert.equal(f.agent().filter(e => e.method === "session/cancel").length, 1);
  assert.equal(f.agent().filter(e => e.method === "_session/steering").length, 0);
  const next = await f.client.send(f.id, { text: "after Stop" });
  await until(() => f.ended(next.turn.id), "a new message after Stop works");
  assert.equal(f.ended(next.turn.id).params.turn.status, "completed");
  assert.deepEqual(f.agent().filter(e => e.method === "session/prompt").map(e => e.params.prompt[0].text), ["[wait] [tool-flight] [tool-race] stop this", "after Stop"], "Stop must not silently restart with a waiting message");
});

test("A224/A255: /compact forced during a Claude reply stops the reply, then compacts the Claude session", { timeout: 20000 }, async t => {
  // What the terminal does on an empty Enter with /compact queued: turn/interrupt, then thread/compact/start as
  // soon as the interrupted turn has ended.
  const f = await fixture(t);
  const { turn } = await f.client.send(f.id, { text: "[hang] a long reply" });
  await until(() => f.agent().some(e => e.method === "session/prompt"), "the reply is running");
  await f.client.interrupt(f.id, { turnId: turn.id });
  await until(() => f.ended(turn.id), "the reply stops");
  assert.equal(f.ended(turn.id).params.turn.status, "interrupted");
  await f.client.compact(f.id, { instructions: "keep the open questions" });
  await until(() => f.agent().filter(e => e.method === "session/prompt").length === 2, "Claude is asked to compact");
  const prompts = f.agent().filter(e => e.method === "session/prompt").map(e => e.params.prompt[0].text);
  assert.deepEqual(prompts, ["[hang] a long reply", "/compact keep the open questions"], "Claude compacts its own session, not as a chat message");
  const cancel = f.agent().findIndex(e => e.method === "session/cancel"), compact = f.agent().findLastIndex(e => e.method === "session/prompt");
  assert.ok(cancel >= 0 && cancel < compact, "the reply is cancelled before the compaction starts");
  await until(() => f.events.filter(e => e.method === "turn/completed").length === 2, "the compaction ends");
  // The contract carrier logs RPCs; the real carrier is independently guarded by
  // fixture teardown, which rejects any native inference for a provider turn.
  if (!process.env.A124_ENGINE) {
    const engine = fs.readFileSync(f.env.FAKE_ENGINE_LOG, "utf8");
    assert.ok(!engine.includes("thread/compact/start"), "a Claude chat's compaction never falls through to the engine");
  }
});

test("A128: desktop reload while a tool has waiting messages keeps their order and answer", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const initial = "[wait] [tool-flight] [tool-race] reload this";
  const { turn } = await f.client.send(f.id, { text: initial });
  await until(() => f.agent().some(e => e.toolStarted === "t1"), "slow tool starts");
  await f.client.steer(f.id, { text: "before reload", expectedTurnId: turn.id });
  f.client.close();
  const reloaded = await f.connect();
  await reloaded.client.resume(f.id, {});
  await reloaded.client.steer(f.id, { text: "after reload", expectedTurnId: turn.id });
  f.releaseTools();
  await until(() => reloaded.events.some(e => e.method === "item/started" && e.params.item.id === "t2"), "reloaded desktop sees the next tool");
  await reloaded.client.readThread(f.id);
  assert.equal(f.agent().filter(e => e.interruptedTool).length, 0);
  f.releaseNextTool();
  await until(() => f.agent().filter(e => e.method === "_session/steering").length === 2, "both waiting messages are delivered");
  f.release();
  await until(() => reloaded.events.some(e => e.method === "turn/completed" && e.params.turn.id === turn.id), "reloaded desktop gets the answer and end");
  const read = await reloaded.client.readThread(f.id);
  assert.equal(read.thread.status.type, "idle");
  assert.deepEqual([...read.data].reverse().filter(e => e.item.type === "userMessage").map(e => e.item.content[0].text), [initial, "before reload", "after reload"]);
  assert.ok(read.data.some(e => e.item.text?.includes("answered:") && e.item.text.includes("after reload")));
});

for (const count of [1, 4]) test(`A128: GPT keeps its native tool running through ${count} messages`, { timeout: 25000 }, async t => {
  const native = !engine.endsWith("/test/fake-app-server.mjs");
  const followups = Array.from({ length: count }, (_, n) => `GPT follow-up ${n + 1} — پیام`);
  let provider;
  if (native) {
    const { Provider } = (await import("../../../scripts/lib/mock-provider.js")).default;
    provider = new Provider(); await provider.start();
    t.after(() => provider.close());
  }
  const f = await fixture(t, {}, { model: native ? "gpt-5.5" : "luna-test", prepare: async (root, env) => {
    env.FAKE_ENGINE_TOOL_RELEASE = path.join(root, "native-release");
    if (!native) return;
    const { call, message } = (await import("../../../scripts/lib/mock-provider.js")).default;
    const catalog = JSON.parse(fs.readFileSync(path.join(source, "../../codex-rs/models-manager/models.json"), "utf8")).models.find(m => m.slug === "gpt-5.5");
    assert.ok(catalog);
    fs.mkdirSync(env.ELPIS_HOME, { recursive: true });
    fs.writeFileSync(path.join(env.ELPIS_HOME, "models.json"), JSON.stringify({ models: [catalog] }));
    fs.writeFileSync(path.join(env.ELPIS_HOME, "config.toml"), `model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(env.ELPIS_HOME, "models.json"))}\napproval_policy="never"\nsandbox_mode="workspace-write"\n[features]\ncode_mode=false\nautomatic_context_pruning=false\n[memories]\ngenerate_memories=false\nuse_memories=false\n[model_providers.fixture]\nname="A128 local inference"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(root)}]\ntrust_level="trusted"\n`);
    const command = `printf started > ${root}/native-started; while [ ! -f ${env.FAKE_ENGINE_TOOL_RELEASE} ]; do sleep 0.02; done; printf GPT_TOOL_DONE`;
    provider.actions.push(call("native-slow-tool", "exec_command", { cmd: command, workdir: root, yield_time_ms: 10000 }), request => {
      const input = JSON.stringify(request.input);
      assert.ok(input.includes("GPT_TOOL_DONE"), "real native tool result reaches inference");
      let previous = -1;
      for (const text of followups) { const index = input.indexOf(text); assert.ok(index > previous, "native steering reaches inference in send order"); previous = index; }
      return message(`GPT answered: ${followups.join("\n")}`);
    });
  } });
  const { turn } = await f.client.send(f.id, { text: "[native-tool] keep this tool running" });
  await until(() => f.events.some(e => e.method === "item/started" && e.params.item.type === "commandExecution"), "native tool starts");
  if (native) await until(() => fs.existsSync(path.join(f.root, "native-started")), "the actual shell is running");
  for (const text of followups) await f.client.steer(f.id, { text, expectedTurnId: turn.id });
  assert.equal(f.ended(turn.id), undefined, "Enter does not end the running task");
  assert.equal(f.events.filter(e => e.method === "item/completed" && e.params.item.type === "commandExecution").length, 0, "the tool remains in flight");
  assert.equal(f.agent().filter(e => e.method === "session/prompt" || e.method === "_session/steering").length, 0, "GPT continues through native turn/steer");
  if (native) assert.equal(provider.requests.length, 1, "inference waits for the tool");
  fs.writeFileSync(f.env.FAKE_ENGINE_TOOL_RELEASE, "");
  await until(() => f.ended(turn.id) || provider?.error, "the native tool and answer finish");
  if (provider?.error) throw provider.error;
  assert.equal(f.ended(turn.id).params.turn.status, "completed");
  assert.ok(f.events.some(e => e.method === "item/completed" && e.params.item.type === "commandExecution" && e.params.item.exitCode === 0 && e.params.item.aggregatedOutput.includes("GPT_TOOL_DONE")));
  const answer = f.events.filter(e => e.method === "item/completed" && e.params.item.type === "agentMessage").at(-1).params.item.text;
  for (const text of followups) assert.ok(answer.includes(text));
  if (!native) assert.equal(lines(f.env.FAKE_ENGINE_LOG).filter(e => e.method === "turn/interrupt").length, 0);
  assert.equal((await f.client.readThread(f.id)).thread.status.type, "idle");
});

async function agyFixture(t, extra = {}, { nativeCalls = false } = {}) {
  return fixture(t, extra, { model: "agy/gemini-3.8-flash-medium", nativeCalls, prepare: async (root, env) => {
    const executable = path.join(root, "fake-agy");
    fs.copyFileSync(path.join(source, "test/fake-agy.cjs"), executable);
    fs.chmodSync(executable, 0o755);
    delete env.ELPIS_NO_AGY;
    Object.assign(env, { AGY_BIN: executable, FAKE_AGY_LOG: path.join(root, "agy.jsonl"), FAKE_AGY_RELEASE: path.join(root, "agy-release") });
  } });
}

test("a new Antigravity model survives the old model process exiting", { timeout: 20000 }, async t => {
  const f = await agyFixture(t, { FAKE_AGY_DELAY_TERM: '500' });
  const first = await f.client.send(f.id, { text: 'first model' });
  await until(() => f.ended(first.turn.id), 'the first model finishes');
  assert.equal(f.ended(first.turn.id).params.turn.status, 'completed');
  const next = await f.client.send(f.id, { text: '[wait] switched model', model: 'agy/gemini-3.8-pro' });
  await until(() => lines(f.env.FAKE_AGY_LOG).some(row => row.text.includes('switched model')), 'the new model starts');
  await pause(700);
  assert.equal(f.ended(next.turn.id), undefined, 'the old process cannot stop the new model');
  fs.writeFileSync(f.env.FAKE_AGY_RELEASE, '');
  await until(() => f.ended(next.turn.id), 'the new model finishes');
  assert.equal(f.ended(next.turn.id).params.turn.status, 'completed');
  const answer = f.store()[f.id].turns.find(turn => turn.id === next.turn.id).items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n');
  assert.ok(answer.includes('switched model') && !answer.includes('stale model output'));
});

test("an existing chat changes models across providers after idle, stop and failure", { timeout: 30000 }, async t => {
  const f = await agyFixture(t, { FAKE_ACP_MODELS: 'sonnet,opus' }, { nativeCalls: true });
  const nativeReply = request => {
    f.carrier.actions.unshift(nativeReply);
    const last = [...(request.input ?? [])].reverse().find(item => item.role === 'user');
    return mockProvider.message(`native answered ${last?.content?.map(part => part.text ?? '').join(' ') ?? 'context'}`);
  };
  f.carrier.actions.push(nativeReply);
  const send = async (model, text, expected = 'completed') => {
    const { turn } = await f.client.send(f.id, { text, model });
    await until(() => f.ended(turn.id), `${model} finishes`);
    assert.equal(f.ended(turn.id).params.turn.status, expected, `${model}: ${f.ended(turn.id).params.turn.error?.message ?? ''}; native requests: ${JSON.stringify(f.carrier.requests.map(row => ({ model: row.body.model, input: JSON.stringify(row.body.input).slice(-300) })))}`);
    await until(async () => (await f.client.readThread(f.id)).thread.status.type === 'idle', `${model} becomes idle`);
  };
  await assert.rejects(f.client.send(f.id, { text: 'invalid', model: 'agy/not-listed' }), /current Elpis model list/);
  await assert.rejects(f.client.createThread({ cwd: f.root, provider: 'carrier', model: 'agy/gemini-3.8-pro' }), /Subscription model/);
  await send('agy/gemini-3.8-flash-medium', 'Gemini first');
  await send('claude/sonnet', 'Claude from Gemini');
  await send('claude/opus', 'Claude model changed');
  await send('gpt-5.5', 'OpenAI from Claude');
  await send('gpt-6.1-sol', 'OpenAI model changed');
  await send('agy/gemini-3.8-pro', 'Gemini from OpenAI');
  const stopped = await f.client.send(f.id, { text: '[wait] stopped Gemini' });
  await until(() => lines(f.env.FAKE_AGY_LOG).some(row => row.text.includes('stopped Gemini')), 'the turn starts');
  await f.client.interrupt(f.id, { turnId: stopped.turn.id });
  await until(() => f.ended(stopped.turn.id), 'the Gemini turn stops');
  assert.equal(f.ended(stopped.turn.id).params.turn.status, 'interrupted');
  f.release(); // The fake Claude sees the earlier [wait] in the seeded history.
  await send('claude/sonnet', 'Claude after stop');
  await send('agy/gemini-3.8-flash-medium', '[fail] Gemini fails', 'failed');
  await send('gpt-5.5', 'OpenAI after failure');
  await send('claude/opus', 'Claude from OpenAI');
  await send('gpt-6.1-sol', 'OpenAI from Claude again');
  for (const [model, text] of [['gpt-5.5', 'OpenAI from Claude'], ['gpt-6.1-sol', 'OpenAI model changed'], ['gpt-5.5', 'OpenAI after failure'], ['gpt-6.1-sol', 'OpenAI from Claude again']]) {
    assert.ok(f.carrier.requests.some(row => row.body.model === model && JSON.stringify(row.body.input).includes(text)), `${model} reaches the local carrier`);
  }
});

test("retrying a failed Gemini turn with Claude replaces the failed turn", { timeout: 20000 }, async t => {
  const f = await agyFixture(t);
  const failed = await f.client.send(f.id, { text: '[fail] original request' });
  await until(() => f.ended(failed.turn.id), 'Gemini reports the failure');
  assert.equal(f.ended(failed.turn.id).params.turn.status, 'failed');
  const retry = await f.client.revert(f.id, { beforeTurnId: failed.turn.id, text: 'retry with Claude', model: 'claude/sonnet' });
  assert.ok(retry.turn?.id, retry.sendError);
  await until(() => f.ended(retry.turn.id), 'Claude answers the replacement');
  assert.equal(f.ended(retry.turn.id).params.turn.status, 'completed');
  assert.ok(f.agent().some(row => row.method === 'session/prompt' && JSON.stringify(row.params.prompt).includes('retry with Claude')));
  const history = await f.client.readThread(f.id);
  assert.ok(!history.data.some(entry => entry.turnId === failed.turn.id));
});

test("Antigravity answers both follow-ups folded into a running turn", { timeout: 20000 }, async t => {
  const f = await agyFixture(t);
  const { turn } = await f.client.send(f.id, { text: "[wait] original" });
  await until(() => lines(f.env.FAKE_AGY_LOG).length === 1, "Antigravity starts the long turn");
  for (const text of ["first follow-up", "second follow-up"]) await f.client.steer(f.id, { text, expectedTurnId: turn.id });
  await until(() => f.store()[f.id]?.active?.userItems?.length === 3, "both follow-ups are recorded");
  fs.writeFileSync(f.env.FAKE_AGY_RELEASE, "");
  await until(() => f.ended(turn.id), "all three messages are answered");
  const answer = f.store()[f.id].turns.find(saved => saved.id === turn.id).items.filter(item => item.type === "agentMessage").map(item => item.text).join("\n");
  for (const text of ["original", "first follow-up", "second follow-up"]) assert.ok(answer.includes(text), `the reply answers ${text}`);
  assert.deepEqual(lines(f.env.FAKE_AGY_LOG).map(row => row.text.includes('first follow-up') ? 'first' : row.text.includes('second follow-up') ? 'second' : 'original'), ['original', 'first', 'second']);
});

test("Antigravity does not send stopped follow-ups in place of the next message", { timeout: 20000 }, async t => {
  const f = await agyFixture(t);
  const { turn } = await f.client.send(f.id, { text: "[wait] original" });
  await until(() => lines(f.env.FAKE_AGY_LOG).length === 1, "Antigravity starts the long turn");
  for (const text of ["first follow-up", "second follow-up"]) await f.client.steer(f.id, { text, expectedTurnId: turn.id });
  await until(() => f.store()[f.id]?.active?.userItems?.length === 3, "both follow-ups are recorded");
  await f.client.interrupt(f.id, { turnId: turn.id });
  await until(() => f.ended(turn.id), "the turn stops");
  const next = await f.client.send(f.id, { text: "new message after stop" });
  await until(() => f.ended(next.turn.id), "the next turn finishes");
  const input = lines(f.env.FAKE_AGY_LOG).map(row => row.text);
  assert.equal(input.length, 2);
  assert.ok(input[1].includes('new message after stop'), 'the next turn sends the message shown in the chat');
  const answer = f.store()[f.id].turns.find(saved => saved.id === next.turn.id).items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n');
  assert.ok(answer.includes('answered:') && answer.includes('new message after stop'));
  assert.ok(!answer.includes('first follow-up') && !answer.includes('second follow-up'));
});

test("a stopped turn with two delivered follow-ups can replace its first message", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const { turn } = await f.client.send(f.id, { text: "[wait] original long turn" });
  await until(() => f.agent().some(e => e.method === "session/prompt"), "the long turn starts");
  for (const text of ["first follow-up", "second follow-up"]) await f.client.steer(f.id, { text, expectedTurnId: turn.id });
  await until(() => f.agent().filter(e => e.method === "_session/steering").length === 2, "both follow-ups arrive");
  await f.client.interrupt(f.id, { turnId: turn.id });
  await until(() => f.ended(turn.id), "the turn stops");
  const history = await f.client.readThread(f.id);
  assert.deepEqual([...history.data].reverse().filter(e => e.turnId === turn.id && e.item.type === "userMessage").map(e => e.item.content[0].text), ["[wait] original long turn", "first follow-up", "second follow-up"]);
  const replaced = await f.client.revert(f.id, { beforeTurnId: turn.id, text: "replacement" });
  assert.ok(replaced.turn?.id, replaced.sendError);
  await until(() => f.ended(replaced.turn.id), "the replacement is answered");
  const after = await f.client.readThread(f.id);
  assert.deepEqual([...after.data].reverse().filter(e => e.item.type === "userMessage").map(e => e.item.content[0].text), ["replacement"]);
});

for (const count of [0, 1, 2, 4]) test(`Claude delivers a final answer and turn end after ${count} in-flight messages, then hello`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { FAKE_ACP_STEER_DELAY: "120" });
  const started = await f.client.send(f.id, { text: "[wait] original" });
  const turnId = started.turn.id;
  await until(() => f.agent().some(e => e.method === "session/prompt"), "Claude starts the turn");
  for (let n = 0; n < count; n++) await f.client.steer(f.id, { text: `message ${n + 1}`, expectedTurnId: turnId });
  await until(() => f.agent().filter(e => e.method === "_session/steering").length === count, "all in-flight messages reach Claude");
  f.release();
  await until(() => f.ended(turnId), "Claude ended but the desktop is still Working");
  const first = f.store()[f.id].turns.find(turn => turn.id === turnId);
  assert.equal(first.status, "completed");
  const users = first.items.filter(item => item.type === "userMessage").map(item => item.content[0].text);
  assert.deepEqual(users, ["[wait] original", ...Array.from({ length: count }, (_, n) => `message ${n + 1}`)], "all accepted messages are recorded before turn completion, in send order");
  const answer = first.items.filter(item => item.type === "agentMessage").at(-1)?.text;
  assert.ok(answer?.includes("answered:"), "the final answer is recorded");
  for (let n = 0; n < count; n++) assert.ok(answer.includes(`message ${n + 1}`));
  const end = f.events.indexOf(f.ended(turnId));
  assert.ok(f.events.slice(0, end).some(e => e.method === "item/completed" && e.params.item.text === answer), "the desktop receives the answer before its turn end");
  assert.equal((await f.client.readThread(f.id)).thread.status.type, "idle");
  const hello = await f.client.steer(f.id, { text: "hello?", expectedTurnId: turnId });
  await until(() => f.ended(hello.turn.id), "a message to a stale Working chat is answered and ends");
  assert.ok(f.events.some(e => e.method === "item/completed" && e.params.item.text?.includes("answered: hello?")));
  const reread = await f.client.readThread(f.id);
  assert.deepEqual([...reread.data].reverse().filter(entry => entry.item.type === "userMessage").map(entry => entry.item.content[0].text), [...users, "hello?"], "a catch-up read keeps fast consecutive turns and their messages in order");
});

test("a tool in flight retains several waiting messages until it finishes", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const { turn } = await f.client.send(f.id, { text: "[wait] [tool-flight] original" });
  await until(() => f.agent().some(e => e.method === "session/prompt"), "tool starts");
  for (const text of ["first while tool runs", "second while tool runs"]) await f.client.steer(f.id, { text, expectedTurnId: turn.id });
  assert.equal(f.agent().filter(e => e.method === "_session/steering").length, 0, "a steer cannot interrupt the running tool");
  f.releaseTools();
  await until(() => f.agent().filter(e => e.method === "_session/steering").length === 2, "waiting inputs are delivered after the tool");
  f.release();
  await until(() => f.ended(turn.id), "the turn ends");
  assert.deepEqual(f.store()[f.id].turns[0].items.filter(i => i.type === "userMessage").map(i => i.content[0].text), ["[wait] [tool-flight] original", "first while tool runs", "second while tool runs"]);
});

test("a turn ending just after accepted waiting messages runs those messages in order", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const { turn } = await f.client.send(f.id, { text: "[wait] [tool-flight] original" });
  await until(() => f.agent().some(e => e.method === "session/prompt"), "tool starts");
  for (const text of ["first at the boundary", "second at the boundary"]) await f.client.steer(f.id, { text, expectedTurnId: turn.id });
  f.release(); f.releaseTools();
  await until(() => f.store()[f.id]?.turns?.flatMap(t => t.items).filter(i => i.type === "userMessage").length === 3, "every accepted message is retained");
  const turns = f.store()[f.id].turns;
  assert.deepEqual(turns.flatMap(t => t.items).filter(i => i.type === "userMessage").map(i => i.content[0].text), ["[wait] [tool-flight] original", "first at the boundary", "second at the boundary"]);
  assert.ok(turns.every(t => t.status === "completed" && t.items.some(i => i.type === "agentMessage" && i.text.includes("answered:"))));
  assert.equal((await f.client.readThread(f.id)).thread.status.type, "idle");
});

test("reloading the desktop client mid-turn keeps the answer and completion subscription", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const { turn } = await f.client.send(f.id, { text: "[wait] reload the app" });
  await until(() => f.agent().some(e => e.method === "session/prompt"), "turn starts");
  f.client.close();
  const reloaded = await f.connect();
  assert.equal((await reloaded.client.resume(f.id, {})).activeTurnId, turn.id);
  f.release();
  await until(() => reloaded.events.some(e => e.method === "turn/completed" && e.params.turn.id === turn.id), "a fresh client receives the end");
  assert.ok(reloaded.events.some(e => e.method === "item/completed" && e.params.item.text?.includes("answered:")), "a fresh client receives the answer");
  assert.equal((await reloaded.client.readThread(f.id)).thread.status.type, "idle");
});

test("a bridge restart recovers a final answer recorded before its live end was delivered", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const { turn } = await f.client.send(f.id, { text: "[wait] [record-only] restart the bridge" });
  await until(() => f.agent().some(e => e.method === "session/prompt"), "turn starts");
  // Stop the bridge's event loop while its separate adapter writes the final record.
  // Recovery cannot win the old 250ms race and accidentally materialize the carrier.
  await f.freeze();
  f.release();
  await until(() => f.agent().some(e => e.ended), "native Claude answer is saved");
  assert.equal(f.ended(turn.id), undefined, "no live end was delivered before the crash");
  assert.equal(f.store()[f.id].active.turnId, turn.id, "completion has not been saved by the bridge");
  const restarted = await f.restart({ crash: true });
  const read = await restarted.client.readThread(f.id).catch(error => {
    t.diagnostic(`restart read rejected: ${error.code}: ${error.engineMessage ?? error.message}`);
    throw error;
  });
  assert.equal(read.thread.status.type, "idle");
  assert.ok(read.data.some(e => e.turnId === turn.id && e.item.text?.includes("answered:")), "the saved answer survives the restart");
  assert.equal(read.thread.id, f.id, "recovery preserves the original chat identity");
  const resumed = await restarted.client.resume(f.id, {});
  assert.equal(resumed.activeTurnId, null);
  const hello = await restarted.client.send(f.id, { text: "hello after restart" });
  await until(() => restarted.events.some(e => e.method === "turn/completed" && e.params.turn.id === hello.turn.id), "the recovered chat can answer again");
  assert.ok(restarted.events.some(e => e.method === "item/completed" && e.params.item.text?.includes("answered: hello after restart")));
});

test("A37: a Claude chat gets the app's browser, which knows the chat", { timeout: 20000 }, async t => {
  const browserConfig = { "mcp_servers.elpis_browser": { command: process.execPath, args: ["browser-mcp.mjs"], env: { ELPIS_BROWSER_SOCKET: "browser.sock" } } };
  const f = await fixture(t, {}, { connectOptions: { browserConfig } });
  const { turn } = await f.client.send(f.id, { text: "open the docs" });
  await until(() => f.ended(turn.id), "turn completes");
  const created = f.agent().find(e => e.method === "session/new" && e.params._meta).params;
  assert.deepEqual(created.mcpServers.find(s => s.name === "elpis_browser").env,
    [{ name: "ELPIS_BROWSER_SOCKET", value: "browser.sock" }, { name: "ELPIS_THREAD_ID", value: f.id }]);
  assert.deepEqual(created._meta.claudeCode.options.allowedTools, ["mcp__elpis_browser"]);
});

test("A143: rewinding a Claude chat forks its Claude session after the last kept reply", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const turns = [];
  for (const text of ["first", "second"]) {
    const { turn } = await f.client.send(f.id, { text });
    await until(() => f.ended(turn.id), "turn completes");
    turns.push(turn);
  }
  const { session, turns: saved } = f.store()[f.id];
  await f.client.revert(f.id, { beforeTurnId: turns[1].id });
  const fork = f.agent().find(e => e.method === "session/fork");
  assert.ok(saved[0].claudeMessageId, "the first turn records Claude's reply id");
  assert.deepEqual([fork.params.sessionId, fork.params._meta.jetbrains.air.fork.messageId], [session, saved[0].claudeMessageId]);
  assert.equal(f.store()[f.id].session, `${session}-fork`);
  const { turn } = await f.client.send(f.id, { text: "third" });
  await until(() => f.ended(turn.id), "the next turn completes");
  const trace = f.agent(), after = trace.slice(trace.findIndex(e => e.method === "session/fork"));
  assert.ok(after.some(e => e.method === "session/load" && e.params.sessionId === `${session}-fork`), "the next turn continues the fork");
  assert.ok(!after.some(e => e.method === "session/new" && e.params._meta), "no fresh Claude session is seeded");
});

test("A37: Claude's report on a background job that ends after its reply opens a turn in the chat", { timeout: 20000 }, async t => {
  const f = await fixture(t, {}, { prepare: (root, env) => { env.FAKE_ACP_BACKGROUND_RELEASE = path.join(root, "background"); } });
  const { turn } = await f.client.send(f.id, { text: "build it [background]" });
  await until(() => f.ended(turn.id), "the reply ends while the job runs");
  fs.writeFileSync(f.env.FAKE_ACP_BACKGROUND_RELEASE, "");
  await until(() => f.events.some(e => e.method === "turn/completed" && e.params.threadId === f.id && e.params.turn.id !== turn.id), "the report's turn ends");
  const read = await f.client.readThread(f.id);
  assert.ok(read.data.some(e => e.item.text === "The background build finished."), "the report is saved in the chat");
  const next = await f.client.send(f.id, { text: "thanks" });
  await until(() => f.ended(next.turn.id), "the chat takes the next message");
  assert.equal(new Set(f.agent().filter(e => e.method === "session/prompt").map(e => e.params.sessionId)).size, 1, "the same Claude session goes on");
});

for (const [message, expected] of [
  ["Individual quota reached. Resets in 17h3m6s.", "usageLimitExceeded"],
  ["Weekly report failed because the file is missing.", null],
]) test(`ACP turn errors expose the right recovery kind: ${message}`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { FAKE_ACP_PROMPT_ERROR: message, FAKE_ACP_ERROR_KIND: "provider_error" });
  const { turn } = await f.client.send(f.id, { text: "hello" });
  await until(() => f.ended(turn.id), "the failed turn ends");
  assert.equal(f.ended(turn.id).params.turn.error.codexErrorInfo, expected);
});

test("a dropped connection retries on its own until Claude answers, without an ACP error", { timeout: 20000 }, async t => {
  const f = await fixture(t, { ELPIS_RECONNECT_MS: "300" }, { prepare: (root, env) => { env.FAKE_ACP_OFFLINE = path.join(root, "offline"); fs.writeFileSync(env.FAKE_ACP_OFFLINE, ""); } });
  const { turn } = await f.client.send(f.id, { text: "hello" });
  await until(() => f.ended(turn.id), "the dropped turn ends");
  assert.match(f.ended(turn.id).params.turn.error.message, /^Connection lost\. Retrying/);
  assert.doesNotMatch(f.ended(turn.id).params.turn.error.message, /ACP/);
  await until(() => f.agent().filter(e => e.method === "session/prompt").length >= 3, "it keeps retrying while offline");
  fs.unlinkSync(f.env.FAKE_ACP_OFFLINE);
  await until(() => f.events.some(e => e.method === "turn/completed" && e.params.threadId === f.id && e.params.turn.status === "completed"), "a retry gets through once online");
  assert.match(f.agent().filter(e => e.method === "session/prompt").at(-1).params.prompt[0].text, /connection dropped/i);
});

test("sending a message while offline retries at once, in place of the timed retry", { timeout: 20000 }, async t => {
  const f = await fixture(t, { ELPIS_RECONNECT_MS: "60000" }, { prepare: (root, env) => { env.FAKE_ACP_OFFLINE = path.join(root, "offline"); fs.writeFileSync(env.FAKE_ACP_OFFLINE, ""); } });
  const { turn } = await f.client.send(f.id, { text: "hello" });
  await until(() => f.ended(turn.id), "the dropped turn ends");
  fs.unlinkSync(f.env.FAKE_ACP_OFFLINE);
  const next = await f.client.send(f.id, { text: "are you there?" });
  await until(() => f.ended(next.turn.id), "the message is answered");
  assert.equal(f.ended(next.turn.id).params.turn.status, "completed");
  assert.equal(f.agent().filter(e => e.method === "session/prompt").length, 2, "no timed retry on top");
});

test("a completed chat survives a graceful bridge restart with several turns in order", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  for (const text of ["first", "middle", "last — پایان"]) {
    const { turn } = await f.client.send(f.id, { text });
    await until(() => f.ended(turn.id), "turn completes");
  }
  const restarted = await f.restart();
  const read = await restarted.client.readThread(f.id);
  assert.equal(read.thread.status.type, "idle");
  assert.deepEqual([...read.data].reverse().filter(e => e.item.type === "userMessage").map(e => e.item.content[0].text), ["first", "middle", "last — پایان"]);
});

test("the existing desktop reconnects after a bridge restart and can read and continue its chat", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const { turn } = await f.client.send(f.id, { text: "before reconnect" });
  await until(() => f.ended(turn.id), "first reply ends");
  await f.restart({ reconnect: true });
  const read = await f.client.readThread(f.id);
  assert.equal(read.thread.status.type, "idle");
  assert.ok(read.data.some(e => e.item.text?.includes("answered: before reconnect")));
  await f.client.resume(f.id, {});
  const next = await f.client.send(f.id, { text: "after reconnect" });
  await until(() => f.ended(next.turn.id), "the reconnect does not strand the next message");
});

test("a failed carrier persistence barrier rejects the turn before Claude starts", { timeout: 20000, skip: !engine.endsWith("/test/fake-app-server.mjs") && "scripted engine failure" }, async t => {
  const f = await fixture(t, { FAKE_ENGINE_FAIL_MATERIALIZE: "1" });
  const { turn } = await f.client.send(f.id, { text: "do not infer without a durable chat" });
  await until(() => f.ended(turn.id), "persistence failure ends Working");
  assert.equal(f.ended(turn.id).params.turn.status, "failed");
  assert.match(f.ended(turn.id).params.turn.error.message, /persistence refused/);
  assert.equal(f.agent().filter(e => e.method === "session/prompt").length, 0);
});

test("a missed renderer completion is corrected by the next history read", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const { turn } = await f.client.send(f.id, { text: "[wait] missed event" });
  await until(() => f.agent().some(e => e.method === "session/prompt"), "turn starts");
  f.release(); await until(() => f.ended(turn.id), "bridge ends the turn");
  const since = f.events.length;
  const read = await f.client.readThread(f.id);
  assert.ok(read.data.some(e => e.item.text?.includes("answered:")));
  assert.ok(f.events.slice(since).some(e => e.method === "thread/status/changed" && e.params.status.type === "idle"), "the history read also clears a stale renderer Working state");
});

test("a native recorded end releases Working even when every live terminal event is lost", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const { turn } = await f.client.send(f.id, { text: "[wait] [record-only] no manual refresh" });
  await until(() => f.agent().some(e => e.method === "session/prompt"), "turn starts");
  f.release();
  await until(() => f.ended(turn.id), "the app must receive the saved answer and end without another message or a manual refresh");
  assert.ok(f.events.some(e => e.method === "item/completed" && e.params.item.text?.includes("answered:")));
});

test("a stalled native history mirror cannot hold Claude's answer or completion", { timeout: 20000 }, async t => {
  const f = await fixture(t, { FAKE_ENGINE_HOLD_INJECT: "1" });
  const { turn } = await f.client.send(f.id, { text: "answer before the mirror acknowledges" });
  await until(() => f.ended(turn.id), "a finished Claude turn cannot keep Working while its native history copy waits", 2000);
  assert.equal(f.store()[f.id].turns[0].status, "completed");
  assert.ok(f.events.some(e => e.method === "item/completed" && e.params.item.text?.includes("answered:")));
});

test("GPT chat turns still use the native engine and never Claude", { timeout: 20000, skip: !engine.endsWith("/test/fake-app-server.mjs") && "scripted native inference only; use the real-app GPT check" }, async t => {
  const f = await fixture(t);
  const created = await f.client.createThread({ model: "luna-test", cwd: f.root });
  const before = f.agent().filter(e => e.method === "session/prompt").length;
  const { turn } = await f.client.send(created.thread.id, { text: "GPT native message" });
  await until(() => f.events.some(e => e.method === "turn/completed" && e.params.turn.id === turn.id), "native GPT turn ends");
  assert.ok(f.events.some(e => e.method === "item/completed" && e.params.item.text?.includes("Answer from luna-test: GPT native message")));
  assert.equal(f.agent().filter(e => e.method === "session/prompt").length, before);
});

test("a read recovers the recorded final answer and end when Claude's live events are missing (A124)", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const { turn } = await f.client.send(f.id, { text: "[wait] [record-only] original" });
  await until(() => f.agent().some(e => e.method === "session/prompt"), "Claude starts");
  for (const text of ["a folder path", "maybe you don't even need to login"]) await f.client.steer(f.id, { text, expectedTurnId: turn.id });
  await until(() => f.agent().filter(e => e.method === "_session/steering").length === 2, "two messages delivered");
  f.release();
  await until(() => f.agent().some(e => e.ended), "Claude recorded its final answer and end_turn");
  const recovered = await f.client.readThread(f.id);
  assert.equal(recovered.thread.status.type, "idle", "Claude's record ended the turn; the app must stop Working on its next read");
  assert.ok(recovered.data.some(e => e.item.text?.includes("answered:")), "the missing final answer catches up from the record");
  await until(() => f.ended(turn.id), "the desktop receives the recovered turn end");
  const hello = await f.client.steer(f.id, { text: "hello?", expectedTurnId: turn.id });
  await until(() => f.ended(hello.turn.id), "hello is answered in a fresh turn");
  assert.ok(f.events.some(e => e.method === "item/completed" && e.params.item.text?.includes("answered: hello?")));
});

test("an effort picked while a Claude turn runs reaches that turn and survives a bridge restart", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const efforts = () => f.agent().filter(e => e.method === "session/set_config_option" && e.params.configId === "effort");
  const { turn } = await f.client.send(f.id, { text: "[wait] think about it" });
  await until(() => f.agent().some(e => e.method === "session/prompt"), "the turn runs");
  const session = f.agent().find(e => e.method === "session/prompt").params.sessionId;
  const before = efforts().length;
  await f.client.setEffort(f.id, { effort: "xhigh" });
  await until(() => efforts().length > before, "the running session hears the new effort");
  assert.deepEqual(efforts().at(-1).params, { sessionId: session, configId: "effort", value: "xhigh" });
  await until(() => f.store()[f.id]?.effort === "xhigh", "the chat's effort is saved");
  f.release();
  await until(() => f.ended(turn.id), "the turn ends");
  const after = await f.restart();
  assert.equal((await after.client.resume(f.id, {})).thread.reasoningEffort, "xhigh", "a restarted bridge reports the saved effort");
});

// Only the real engine records and restores a chat's permissions: run with A124_ENGINE=/absolute/native/binary.
for (const mode of ["full", "auto", "bypass", "ask"]) test(`a Claude chat set to ${mode} reopens in ${mode} after a bridge and engine restart`, { timeout: 30000, skip: engine.endsWith("fake-app-server.mjs") && "needs the real engine (A124_ENGINE)" }, async t => {
  const f = await fixture(t);
  const { turn } = await f.client.send(f.id, { text: "hello" });
  await until(() => f.ended(turn.id), "the turn ends");
  // From another mode, so the change is a real one.
  await f.client.setPermissions(f.id, { permissions: mode === "full" ? "ask" : "full" });
  assert.deepEqual(await f.client.setPermissions(f.id, { permissions: mode }), { permissions: mode });
  const after = await f.restart();
  assert.equal((await after.client.resume(f.id, {})).permissions, mode);
});
