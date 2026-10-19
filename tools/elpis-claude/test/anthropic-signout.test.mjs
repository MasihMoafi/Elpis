import { createTestTempDir, removeTestTempDir } from './temp-root.mjs';
// Elpis's own "Anthropic sign out": a switch in the Elpis home that stops Elpis, and only Elpis, from
// using the Claude subscription. Claude Code's login (~/.claude) is never touched.
// Actual bridge, deterministic local engine and ACP adapter, isolated home; no provider calls.
// Run: node --test tools/elpis-claude/test/anthropic-signout.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const self = fileURLToPath(import.meta.url);
const MESSAGE = "Anthropic is signed out in Elpis — sign in under Settings → Models & accounts.";

if (process.argv.includes("app-server")) {
  // The engine: answers what the bridge asks, and records the thread/start requests it receives.
  const record = (event) => fs.appendFileSync(process.env.SIGNOUT_TRACE, JSON.stringify(event) + "\n");
  const codex = { limitId: "codex", limitName: null, primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null }, secondary: null, credits: null, planType: null, rateLimitReachedType: null };
  let threads = 0;
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    record({ engine: msg.method, params: msg.params });
    let result = {};
    if (msg.method === "model/list") result = { data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT test" }], nextCursor: null };
    if (msg.method === "account/rateLimits/read") result = { rateLimits: codex, rateLimitsByLimitId: { codex } };
    if (msg.method === "thread/start") result = { thread: { id: `chat-${++threads}`, cwd: process.cwd(), source: "cli", modelProvider: "openai", preview: "", turns: [] }, model: "gpt-test", approvalPolicy: "on-request" };
    process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\n");
  });
} else if (process.env.SIGNOUT_ROLE === "adapter") {
  // The Claude ACP adapter: records every method it is asked, and answers a prompt at once.
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const configOptions = [{ id: "model", category: "model", type: "select", name: "Model", currentValue: "haiku", options: [
    { value: "default", name: "Default" }, { value: "haiku", name: "Haiku", description: "Fast" }, { value: "sonnet", name: "Sonnet", description: "Balanced" }] }];
  let sessions = 0;
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method) fs.appendFileSync(process.env.SIGNOUT_ADAPTER_TRACE, msg.method + "\n");
    if (msg.id === undefined) return;
    const result = msg.method === "initialize" ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      : msg.method === "session/new" ? { sessionId: `session-${++sessions}`, configOptions }
      : msg.method === "session/prompt" ? { stopReason: "end_turn" }
      : msg.method === "session/set_config_option" ? { configOptions } : {};
    send({ id: msg.id, result });
  });
} else {
  const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const { isSignedOut, setSignedOut, SIGNED_OUT_MESSAGE } = await import("../anthropic-signout.mjs");

  test("the switch file: missing means signed in; it is private, atomic and fails closed", (t) => {
    const dir = createTestTempDir(path.join(os.tmpdir(), "elpis-signout-unit-"));
    t.after(() => removeTestTempDir(dir));
    assert.equal(SIGNED_OUT_MESSAGE, MESSAGE);
    assert.equal(isSignedOut(dir), false, "no file: signed in");
    setSignedOut(path.join(dir, "made", "on", "demand"), true);
    assert.equal(isSignedOut(path.join(dir, "made", "on", "demand")), true);
    setSignedOut(dir, true);
    const file = path.join(dir, "anthropic.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "owner-only file");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).signedOut, true);
    assert.equal(isSignedOut(dir), true);
    setSignedOut(dir, false);
    assert.equal(isSignedOut(dir), false, "signing in clears the switch");
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name !== "made"), ["anthropic.json"], "no temporary file is left behind");
    for (const damaged of ["{not json", "{}", "[]", ""]) { fs.writeFileSync(file, damaged); assert.equal(isSignedOut(dir), true, `damaged ${JSON.stringify(damaged)}: stays signed out`); }
    assert.throws(() => setSignedOut(dir, "yes"), /true or false/);
  });

  // A real bridge on an isolated home. `preset` is written to the switch file before the bridge starts.
  async function setup(t, { preset, sessions, defaultStore } = {}) {
    const root = createTestTempDir(path.join(os.tmpdir(), "elpis-signout-"));
    const userHome = path.join(root, "home"), elpisHome = path.join(userHome, ".elpis-next"), state = path.join(elpisHome, "elpis-claude");
    const claudeDir = path.join(userHome, ".claude");
    for (const dir of [state, claudeDir, path.join(root, "bin")]) fs.mkdirSync(dir, { recursive: true });
    // Claude Code's own login, which must survive everything below untouched.
    fs.writeFileSync(path.join(claudeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", refreshToken: "fixture-refresh", subscriptionType: "max" } }));
    fs.writeFileSync(path.join(userHome, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "person@example.test" } }));
    const login = [path.join(claudeDir, ".credentials.json"), path.join(userHome, ".claude.json")];
    const loginBefore = login.map((file) => [sha(file), fs.statSync(file).mtimeMs]);
    // A `claude` that records every call; the bridge must never run `claude auth logout` or anything else.
    const claudeCalls = path.join(root, "claude-calls.log");
    const claude = path.join(root, "bin", "claude");
    fs.writeFileSync(claude, `#!/bin/sh\necho "$@" >> ${JSON.stringify(claudeCalls)}\n`, { mode: 0o755 });
    if (preset !== undefined) fs.writeFileSync(path.join(state, "anthropic.json"), preset);
    if (sessions) fs.writeFileSync(path.join(state, "sessions.json"), JSON.stringify(sessions));
    const trace = path.join(root, "engine.jsonl"), adapterTrace = path.join(root, "adapter.log");
    fs.writeFileSync(trace, ""); fs.writeFileSync(adapterTrace, "");
    const engine = path.join(root, "engine");
    fs.writeFileSync(engine, `#!${process.execPath}\nimport ${JSON.stringify(self)};\n`, { mode: 0o755 });
    let usageHits = 0;
    const usage = createServer((req, res) => { usageHits++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ five_hour: { utilization: 41, resets_at: "2030-01-01T00:00:00Z" }, seven_day: { utilization: 86, resets_at: "2030-01-07T00:00:00Z" } })); });
    await new Promise((resolve) => usage.listen(0, "127.0.0.1", resolve));
    const log = path.join(root, "bridge.log");
    const child = spawn(process.execPath, [process.env.ELPIS_SIGNOUT_TEST_BRIDGE ?? fileURLToPath(new URL("../acp-bridge.mjs", import.meta.url))], {
      cwd: root, stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: `${path.join(root, "bin")}:${process.env.PATH}`, HOME: userHome, ELPIS_HOME: elpisHome, CODEX_HOME: elpisHome, CODEX_AUTH_HOME: elpisHome,
        XDG_RUNTIME_DIR: root, TMPDIR: root, ELPIS_ENGINE_BIN: engine, ACP_BRIDGE_LOG: log, ...(defaultStore ? {} : { ACP_BRIDGE_STORE: path.join(state, "sessions.json") }),
        ACP_ADAPTER: self, CLAUDE_CODE_EXECUTABLE: claude, SIGNOUT_ROLE: "adapter", SIGNOUT_TRACE: trace, SIGNOUT_ADAPTER_TRACE: adapterTrace,
        ELPIS_CLAUDE_USAGE_URL: `http://127.0.0.1:${usage.address().port}/usage`, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
        PORT: "0", ELPIS_NO_AGY: "1", ACP_BRIDGE_NO_AGENTS: "1" },
    });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    const sockets = [];
    t.after(async () => {
      for (const socket of sockets) socket.close();
      usage.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
        await exited; clearTimeout(timer);
      }
      removeTestTempDir(root);
    });
    const until = async (condition, label, ms = 8000) => {
      const end = Date.now() + ms;
      while (!condition()) { assert(Date.now() < end, `${label}: ${stderr}\n${fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(-800) : ""}`); await pause(10); }
    };
    await until(() => fs.existsSync(log) && /LISTENING/.test(fs.readFileSync(log, "utf8")), "bridge startup");
    const endpoint = `ws://127.0.0.1:${fs.readFileSync(log, "utf8").match(/LISTENING (\d+)/)[1]}`;
    // One client: the terminal or the desktop. Both talk to the same bridge.
    async function connect(name) {
      const socket = new WebSocket(endpoint); sockets.push(socket);
      await once(socket, "open");
      const pending = new Map(), notices = []; let seq = 0;
      socket.on("message", (data) => {
        const msg = JSON.parse(String(data)), waiter = msg.method ? null : pending.get(msg.id);
        if (waiter) { pending.delete(msg.id); waiter(msg); } else notices.push(msg);
      });
      const call = (method, params = {}, { id = ++seq, ms = 10000 } = {}) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error(`${method} timed out`)), ms);
        pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
        socket.send(JSON.stringify({ id, method, params }));
      });
      assert.ok((await call("initialize", { clientInfo: { name, version: "1" }, capabilities: { experimentalApi: true } })).result);
      return { call, notices };
    }
    const records = () => fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const adapterCalls = () => fs.readFileSync(adapterTrace, "utf8").trim().split("\n").filter(Boolean);
    return {
      connect, until, records, adapterCalls, state, root, accounts: () => { try { return JSON.parse(fs.readFileSync(path.join(state, "accounts.json"), "utf8")); } catch { return null; } },
      usageHits: () => usageHits, claudeCalls: () => (fs.existsSync(claudeCalls) ? fs.readFileSync(claudeCalls, "utf8") : ""),
      loginUntouched: () => login.every((file, i) => sha(file) === loginBefore[i][0] && fs.statSync(file).mtimeMs === loginBefore[i][1]),
    };
  }
  const ids = (reply) => reply.result.data.map((model) => model.id);
  const userInput = [{ type: "text", text: "hello", text_elements: [] }];
  const claudeLimit = (reply) => reply.result?.rateLimitsByLimitId?.claude;
  const started = async (client, model) => (await client.call("thread/start", { model, cwd: process.cwd() })).result.thread.id;
  const completed = (client, threadId) => client.notices.find((m) => m.method === "turn/completed" && m.params.threadId === threadId);

  test("signed in: Claude models, usage and turns work (the baseline for the tests below)", async (t) => {
    const fx = await setup(t);
    const tui = await fx.connect("tui");
    assert.deepEqual(ids(await tui.call("model/list")).filter((id) => id.startsWith("claude/")), ["claude/haiku", "claude/sonnet"]);
    assert.equal(claudeLimit(await tui.call("account/rateLimits/read")).primary.usedPercent, 41);
    const thread = await started(tui, "claude/haiku");
    const turn = await tui.call("turn/start", { threadId: thread, input: userInput });
    assert.ifError(turn.error);
    await fx.until(() => completed(tui, thread), "turn completed");
    assert.equal(completed(tui, thread).params.turn.status, "completed");
    assert.ok(fx.adapterCalls().includes("session/prompt"), "the adapter got the prompt");
    await fx.until(() => fx.accounts()?.claude, "accounts file");
    assert.equal(fx.accounts().claude.email, "person@example.test");
  });

  test("signing out in Elpis removes Claude models and usage, refuses turns and leaves Claude Code alone", async (t) => {
    const fx = await setup(t);
    const tui = await fx.connect("tui"), desktop = await fx.connect("desktop");
    const thread = await started(tui, "claude/haiku");
    assert.equal((await desktop.call("claudeSubscription/read")).result.signedOut, false);
    assert.ok(ids(await desktop.call("model/list")).includes("claude/haiku"));
    const hitsBefore = fx.usageHits(), promptsBefore = fx.adapterCalls().filter((m) => m === "session/prompt").length;

    // The desktop signs out; the terminal's bridge connection follows at once.
    assert.deepEqual((await desktop.call("claudeSubscription/write", { signedOut: true })).result, { signedOut: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(fx.state, "anthropic.json"), "utf8")).signedOut, true);
    assert.equal((await tui.call("claudeSubscription/read")).result.signedOut, true);
    const models = ids(await tui.call("model/list"));
    assert.deepEqual(models.filter((id) => id.startsWith("claude/")), [], "no Claude models");
    assert.ok(models.includes("gpt-test"), "other models stay");
    const limits = await tui.call("account/rateLimits/read");
    assert.equal(claudeLimit(limits), undefined, "no Claude usage");
    assert.ok(limits.result.rateLimitsByLimitId.codex, "other usage stays");
    assert.equal(fx.usageHits(), hitsBefore, "Anthropic's usage endpoint is not asked while signed out");

    const refused = await tui.call("turn/start", { threadId: thread, input: userInput });
    assert.equal(refused.error?.message, MESSAGE);
    const refusedSwitch = await desktop.call("turn/start", { threadId: thread, model: "claude/sonnet", input: userInput });
    assert.equal(refusedSwitch.error?.message, MESSAGE, "switching a chat to another Claude model does not get around it");
    assert.equal(fx.adapterCalls().filter((m) => m === "session/prompt").length, promptsBefore, "no prompt reached Claude");

    await fx.until(() => !fx.accounts()?.claude, "accounts file without Claude");
    assert.deepEqual(fx.claudeCalls(), "", "the claude program was never run (no `claude auth logout`)");
    assert.ok(fx.loginUntouched(), "Claude Code's login files are byte-for-byte unchanged");
  });

  test("signing in again brings models, usage and turns back", async (t) => {
    const fx = await setup(t);
    const tui = await fx.connect("tui");
    const thread = await started(tui, "claude/haiku");
    await tui.call("claudeSubscription/write", { signedOut: true });
    assert.deepEqual((await tui.call("claudeSubscription/write", { signedOut: false })).result, { signedOut: false });
    assert.equal(JSON.parse(fs.readFileSync(path.join(fx.state, "anthropic.json"), "utf8")).signedOut, false);
    assert.ok(ids(await tui.call("model/list")).includes("claude/haiku"));
    assert.equal(claudeLimit(await tui.call("account/rateLimits/read")).primary.usedPercent, 41);
    assert.ifError((await tui.call("turn/start", { threadId: thread, input: userInput })).error);
    await fx.until(() => completed(tui, thread), "turn completed");
    assert.equal(completed(tui, thread).params.turn.status, "completed");
    await fx.until(() => fx.accounts()?.claude, "accounts file with Claude");
    assert.equal(fx.claudeCalls(), "");
    assert.ok(fx.loginUntouched());
  });

  test("a bridge that starts on a signed-out home stays signed out, also when the file is damaged", async (t) => {
    for (const preset of [JSON.stringify({ signedOut: true }), "{not json"]) {
      const fx = await setup(t, { preset });
      const tui = await fx.connect("tui");
      assert.equal((await tui.call("claudeSubscription/read")).result.signedOut, true, preset);
      assert.deepEqual(ids(await tui.call("model/list")).filter((id) => id.startsWith("claude/")), [], preset);
      assert.equal(claudeLimit(await tui.call("account/rateLimits/read")), undefined, preset);
      assert.equal(fx.usageHits(), 0, preset);
      assert.equal(fx.adapterCalls().length, 0, "the Claude adapter is not even started");
      await fx.until(() => fx.accounts(), "accounts file");
      assert.equal(fx.accounts().claude, undefined, "the account file does not claim a Claude sign-in");
    }
  });

  test("by default the switch is an owner-only file in the Elpis home's elpis-claude folder", async (t) => {
    const fx = await setup(t, { defaultStore: true });
    const tui = await fx.connect("tui");
    await tui.call("claudeSubscription/write", { signedOut: true });
    const file = path.join(fx.state, "anthropic.json");
    assert.equal(fx.state, path.join(fx.root, "home", ".elpis-next", "elpis-claude"));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).signedOut, true);
    assert.deepEqual(fs.readdirSync(fx.state).filter((name) => name.includes("anthropic")), ["anthropic.json"], "no temporary file is left behind");
  });

  test("a bad write is refused and changes nothing", async (t) => {
    const fx = await setup(t);
    const tui = await fx.connect("tui");
    for (const params of [{}, { signedOut: "true" }, { signedOut: 1 }, null]) {
      const reply = await tui.call("claudeSubscription/write", params);
      assert.match(reply.error?.message ?? "", /true or false/);
    }
    assert.equal(fs.existsSync(path.join(fx.state, "anthropic.json")), false);
    assert.equal((await tui.call("claudeSubscription/read")).result.signedOut, false);
  });

  test("new chats skip a saved Claude default while signed out, and use it again after sign-in", async (t) => {
    const fx = await setup(t, { sessions: { _default: { model: "claude/haiku", effort: null } } });
    const tui = await fx.connect("tui");
    assert.equal((await tui.call("thread/start", { cwd: process.cwd() })).result.model, "claude/haiku", "signed in: the default applies");
    await tui.call("claudeSubscription/write", { signedOut: true });
    assert.equal((await tui.call("thread/start", { cwd: process.cwd() })).result.model, "gpt-test", "signed out: the engine's own default");
    await tui.call("claudeSubscription/write", { signedOut: false });
    assert.equal((await tui.call("thread/start", { cwd: process.cwd() })).result.model, "claude/haiku", "signed in again: the default applies");
  });

  test("other ways to start a Claude turn (compact, review) fail with the message and never reach Claude", async (t) => {
    const fx = await setup(t);
    const tui = await fx.connect("tui");
    const thread = await started(tui, "claude/haiku");
    await tui.call("claudeSubscription/write", { signedOut: true });
    const promptsBefore = fx.adapterCalls().filter((m) => m === "session/prompt").length;
    await tui.call("thread/compact/start", { threadId: thread });
    await fx.until(() => completed(tui, thread), "compact turn ended");
    assert.equal(completed(tui, thread).params.turn.status, "failed");
    assert.equal(completed(tui, thread).params.turn.error.message, MESSAGE);
    tui.notices.length = 0;
    await tui.call("review/start", { threadId: thread, target: { type: "custom", instructions: "look" } });
    await fx.until(() => completed(tui, thread), "review turn ended");
    assert.equal(completed(tui, thread).params.turn.error.message, MESSAGE);
    assert.equal(fx.adapterCalls().filter((m) => m === "session/prompt").length, promptsBefore);
  });

  test("hidden title and recap requests do not use the signed-out subscription either", async (t) => {
    const fx = await setup(t);
    const tui = await fx.connect("tui");
    const thread = await started(tui, "claude/haiku");
    const hiddenTurn = () => tui.call("turn/start", { threadId: thread, input: userInput, outputSchema: { type: "object" } }, { id: `temporary-structured-turn-${Math.random()}` });
    await tui.call("claudeSubscription/write", { signedOut: true });
    const callsBefore = fx.adapterCalls().length;
    assert.ok((await hiddenTurn()).result.turn, "the request is accepted, then ends failed");
    await fx.until(() => completed(tui, thread), "hidden request ended");
    assert.equal(completed(tui, thread).params.turn.status, "failed");
    assert.equal(completed(tui, thread).params.turn.error.message, MESSAGE);
    assert.equal(fx.adapterCalls().length, callsBefore, "Claude was not asked anything, not even for a session");
  });
}
