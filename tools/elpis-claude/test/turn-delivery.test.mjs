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

async function fixture(t, extra = {}, { model = "claude/sonnet", prepare, connectOptions } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a124-"));
  const carrier = new mockProvider.Provider();
  await carrier.start();
  t.after(() => {
    carrier.close();
    assert.equal(carrier.requests.length + carrier.titleRequests.length, 0, "the native carrier must not perform inference for a provider turn");
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
  await until(() => fs.existsSync(socketPath) && (fs.statSync(socketPath).mode & 0o777) === 0o600, `bridge starts: ${errors}`);
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
      if (!fs.existsSync(socketPath)) return false;
      const next = fs.statSync(socketPath);
      return (next.ino !== previous.ino || next.ctimeMs !== previous.ctimeMs) && (next.mode & 0o777) === 0o600;
    }, "the new bridge replaces the dead listener");
    if (reconnect) { await until(() => desktop.client.connected, "the existing desktop reconnects"); return desktop; }
    return connect();
  };
  return { ...desktop, id, root, connect, restart, bridge, env,
    freeze: async () => { bridge.kill("SIGSTOP"); await until(() => /^State:\s+T/m.test(fs.readFileSync(`/proc/${bridge.pid}/status`, "utf8")), "the old bridge is stopped before Claude writes"); },
    agent: () => lines(agentLog), store: () => fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, "utf8")) : {},
    release: () => fs.writeFileSync(release, ""), releaseTools: () => fs.writeFileSync(toolRelease, ""),
    releaseNextTool: () => fs.writeFileSync(env.FAKE_ACP_NEXT_TOOL_RELEASE, ""),
    releaseBetweenTools: () => fs.writeFileSync(env.FAKE_ACP_BETWEEN_TOOL_RELEASE, ""),
    ended: turnId => desktop.events.find(e => e.method === "turn/completed" && e.params.turn.id === turnId) };
}

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
