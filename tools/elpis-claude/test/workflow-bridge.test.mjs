// Workflows through the real shared bridge (SPEC WR1, WR5, WR6): a chat's workflow tool (the real elpis-agents MCP
// server) -> bridge -> runner -> helper chats -> the end notice, for an engine chat and a Claude chat, with the
// Subagents switch off. The engine is this file run as a scripted app-server; Claude is fake-acp-agent.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTestTempDir, removeTestTempDir } from "./temp-root.mjs";
import { DesktopClient } from "../../../apps/elpis-desktop/bridge/client.mjs";
import { startDesktopServer } from "../../../apps/elpis-desktop/bridge/server.mjs";

const source = fileURLToPath(new URL("..", import.meta.url));
const self = fileURLToPath(import.meta.url);

if (process.argv.includes("app-server")) {
  // A scripted engine: threads in memory per process and on disk under HOME, so every engine of the bridge sees them.
  const file = (id) => path.join(process.env.HOME, "threads", `${id}.json`);
  fs.mkdirSync(path.join(process.env.HOME, "threads"), { recursive: true });
  const load = (id) => { try { return JSON.parse(fs.readFileSync(file(id), "utf8")); } catch { return null; } };
  const save = (t) => { fs.writeFileSync(`${file(t.id)}.tmp`, JSON.stringify(t)); fs.renameSync(`${file(t.id)}.tmp`, file(t.id)); };
  const answer = (schema, prompt) => schema ? JSON.stringify(Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, s]) => [k, [].concat(s.type)[0] === "integer" ? prompt.length : `${k} of ${prompt}`]))) : `engine answered: ${prompt}`;
  const sockets = new Set();
  const handle = (msg, send) => {
    if (msg.id === undefined) return;
    const p = msg.params ?? {};
    const ok = (result) => send({ id: msg.id, result });
    const bcast = (m) => { for (const s of sockets) s(m); if (!sockets.size) send(m); };
    const t = p.threadId ? load(p.threadId) : null;
    switch (msg.method) {
      case "initialize": return ok({ userAgent: "workflow-fixture" });
      case "config/read": return ok({ config: { model: "fake-model", features: { multi_agent: false } } });
      case "model/list": return ok({ data: [] });
      case "thread/start": {
        const thread = { id: randomUUID(), cwd: p.cwd ?? process.env.HOME, model: p.model ?? "fake-model", modelProvider: p.modelProvider ?? "fake", status: { type: "idle" }, turns: [], preview: "", createdAt: 1, updatedAt: 1, config: p.config ?? null };
        save(thread);
        ok({ thread: { ...thread, turns: [] }, model: thread.model, modelProvider: thread.modelProvider, approvalPolicy: p.approvalPolicy ?? "never", sandbox: { type: "dangerFullAccess" }, cwd: thread.cwd });
        return bcast({ method: "thread/started", params: { thread: { ...thread, turns: [] } } });
      }
      case "thread/resume": return t ? ok({ thread: { ...t, turns: [] }, model: t.model, modelProvider: t.modelProvider, approvalPolicy: "never", sandbox: { type: "dangerFullAccess" }, cwd: t.cwd }) : send({ id: msg.id, error: { code: -32600, message: `thread not found: ${p.threadId}` } });
      case "thread/read": return t ? ok({ thread: { ...t, turns: p.includeTurns ? t.turns : [] } }) : send({ id: msg.id, error: { code: -32600, message: `thread not found: ${p.threadId}` } });
      case "thread/turns/list": return ok({ data: t ? [...t.turns].reverse().slice(0, p.limit ?? 50) : [], nextCursor: null });
      case "thread/list": return ok({ data: [], nextCursor: null });
      case "turn/start": {
        if (!t) return send({ id: msg.id, error: { code: -32600, message: `thread not found: ${p.threadId}` } });
        if (t.status.type === "active") return send({ id: msg.id, error: { code: -32600, message: "thread already has an active turn" } });
        const text = p.input.map((i) => i.text ?? "").join("\n");
        const turn = { id: randomUUID(), status: "inProgress", items: [{ id: randomUUID(), type: "userMessage", content: p.input }] };
        t.turns.push(turn); t.status = { type: "active", activeFlags: [] }; save(t);
        ok({ turn }); bcast({ method: "turn/started", params: { threadId: t.id, turn } });
        if (text.includes("[hold]")) return;
        setTimeout(() => {
          const now = load(t.id);
          const last = now.turns.at(-1);
          const item = { id: randomUUID(), type: "agentMessage", text: answer(p.outputSchema, text.split("\n\n").at(-1)) };
          last.items.push(item); last.status = "completed"; now.status = { type: "idle" }; save(now);
          bcast({ method: "item/completed", params: { threadId: t.id, turnId: last.id, item } });
          bcast({ method: "thread/tokenUsage/updated", params: { threadId: t.id, turnId: last.id, tokenUsage: { last: { outputTokens: 7 }, total: { outputTokens: 7 } } } });
          bcast({ method: "turn/completed", params: { threadId: t.id, turn: last } });
        }, 20);
        return;
      }
      case "turn/interrupt": {
        if (!t) return ok({});
        const last = t.turns.at(-1);
        if (last?.status === "inProgress") { last.status = "interrupted"; t.status = { type: "idle" }; save(t); bcast({ method: "turn/completed", params: { threadId: t.id, turn: last } }); }
        return ok({});
      }
      default: return ok({});
    }
  };
  const sock = process.argv.find((a) => a.startsWith("unix://"))?.slice(7);
  if (sock) {
    const server = http.createServer();
    new WebSocketServer({ server }).on("connection", (ws) => {
      const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
      sockets.add(send); ws.on("close", () => sockets.delete(send));
      ws.on("message", (d) => handle(JSON.parse(String(d)), send));
    });
    server.listen(sock);
  } else readline.createInterface({ input: process.stdin }).on("line", (line) => handle(JSON.parse(line), (m) => process.stdout.write(`${JSON.stringify(m)}\n`)));
} else {
  test("a chat's workflow tool runs a script through the bridge to the end, only when the person asked (WR1, WR5, WR6)", { timeout: 60_000 }, async (t) => {
    const root = createTestTempDir(path.join(os.tmpdir(), "wf-bridge-"));
    const socketPath = path.join(root, "bridge.sock");
    const engine = path.join(root, "engine.mjs");
    fs.writeFileSync(engine, `#!${process.execPath}\nawait import(${JSON.stringify(self)});\n`, { mode: 0o755 });
    const acpLog = path.join(root, "acp.jsonl");
    const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: root, CODEX_HOME: root, CODEX_AUTH_HOME: root, XDG_RUNTIME_DIR: root, TMPDIR: root,
      ELPIS_SHARED_BRIDGE: "1", ELPIS_BRIDGE_SOCKET: socketPath, ELPIS_ENGINE_BIN: engine, ELPIS_NO_AGY: "1",
      ACP_ADAPTER: path.join(source, "test/fake-acp-agent.mjs"), FAKE_ACP_LOG: acpLog, FAKE_ACP_MODELS: "default,haiku", ACP_BRIDGE_STORE: path.join(root, "sessions.json"), ACP_BRIDGE_LOG: path.join(root, "bridge.log"),
      ELPIS_WORKFLOW_RETRY_MS: "20" };
    const bridge = spawn(process.execPath, [path.join(source, "acp-bridge.mjs")], { env, cwd: root, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    bridge.stderr.on("data", (d) => { stderr += d; });
    const mcps = [];
    let ws, desktop, app, sse;
    t.after(async () => {
      await sse?.cancel().catch(() => {}); await app?.close(); desktop?.close();
      for (const m of mcps) await m.close().catch(() => {});
      ws?.close();
      try { process.kill(-bridge.pid, "SIGKILL"); } catch {}
      if (!process.env.WF_KEEP) removeTestTempDir(root);
    });
    const until = async (what, check, ms = 20_000) => {
      const end = Date.now() + ms;
      for (;;) { const v = await check(); if (v) return v; assert.ok(Date.now() < end, `${what}\n${stderr}\n${fs.existsSync(env.ACP_BRIDGE_LOG) ? fs.readFileSync(env.ACP_BRIDGE_LOG, "utf8").slice(-3000) : ""}`); await pause(20); }
    };
    await until("bridge startup", () => fs.existsSync(socketPath));
    ws = new WebSocket(`ws+unix://${socketPath}:/`);
    await once(ws, "open");
    const pending = new Map(), events = [];
    let seq = 0;
    ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.method) events.push(m); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const rpc = (method, params) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    const ok = async (method, params) => { const r = await rpc(method, params); assert.ifError(r.error); return r.result; };
    await ok("initialize", { clientInfo: { name: "wf-desktop", version: "1" }, capabilities: { experimentalApi: true } });
    const tool = async (parentEnv) => {
      const c = new Client({ name: "wf-chat", version: "1" });
      await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(source, "elpis-agents-mcp.mjs")], env: { ...env, ELPIS_BRIDGE_URL: `ws+unix://${socketPath}:/`, ELPIS_AGENT_TOOLS: "0", ELPIS_WORKFLOW_TOOL: "1", ELPIS_AGENTS_LOG: path.join(root, "agents.log"), ...parentEnv } }));
      mcps.push(c);
      return c;
    };
    const launch = async (c, args, meta) => {
      const r = await c.callTool({ name: "workflow", arguments: args, ...(meta && { _meta: meta }) });
      return { text: r.content.map((x) => x.text).join("\n"), isError: Boolean(r.isError) };
    };
    const SCRIPT = `export const meta = { name: 'bridge-check', description: 'through the bridge', phases: [{ title: 'Ask' }] }
phase('Ask')
const [a, b] = await parallel([() => agent('first ' + args.word), () => agent('second', { schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } })])
return { a, b }`;
    const runOf = (text) => /as (wf_[\w-]+)/.exec(text)?.[1];
    const runFile = (id) => JSON.parse(fs.readFileSync(path.join(root, "workflows/runs", id, "run.json"), "utf8"));

    await t.test("an engine chat: refused without the person's request or a running turn, run to the end with it", async () => {
      const chat = await tool({});
      const listed = (await chat.listTools()).tools.map((x) => x.name);
      assert.deepEqual(listed, ["workflow"], "the workflow tool alone, with the Subagents switch off");
      const parent = (await ok("thread/start", { cwd: root, approvalPolicy: "never", sandbox: "danger-full-access" })).thread.id;
      const idle = await launch(chat, { script: SCRIPT, args: { word: "x" } }, { threadId: parent });
      assert.match(idle.text, /did not start: Workflows start only during a message from the person/);
      await ok("turn/start", { threadId: parent, input: [{ type: "text", text: "[hold] please review the repo", text_elements: [] }] });
      const unasked = await launch(chat, { script: SCRIPT, args: { word: "x" } }, { threadId: parent });
      assert.match(unasked.text, /did not start: The person did not ask for a workflow/);
      await ok("turn/interrupt", { threadId: parent, turnId: "x" });
      await until("the turn ends", async () => (await ok("thread/read", { threadId: parent })).thread.status.type === "idle");
      await ok("turn/start", { threadId: parent, input: [{ type: "text", text: "[hold] ultracode: review the repo", text_elements: [] }] });
      const started = await launch(chat, { script: SCRIPT, args: { word: "kiwi" } }, { threadId: parent });
      assert.equal(started.isError, false, started.text);
      const id = runOf(started.text);
      assert.match(started.text, /Script saved at .*script\.js/);
      await until("the run ends", () => runFile(id).status === "completed");
      const run = runFile(id);
      assert.deepEqual(run.result.b, { n: "second".length });
      assert.match(run.result.a, /^engine answered: first kiwi$/);
      assert.equal(run.notice.state, "pending", "the chat is still busy; the notice waits");
      assert.equal(run.model, "fake-model");
      const helper = (await ok("thread/read", { threadId: run.agents[0].threadId })).thread;
      assert.equal(helper.parentThreadId, parent);
      assert.equal(helper.workflowRunId, id);
      const helperTool = await launch(chat, { script: SCRIPT }, { threadId: run.agents[0].threadId });
      assert.match(helperTool.text, /A helper chat cannot start a workflow/);
      await ok("turn/interrupt", { threadId: parent, turnId: "x" });
      await until("the notice is delivered", () => runFile(id).notice.state === "delivered");
      const turns = (await ok("thread/turns/list", { threadId: parent, limit: 1, sortDirection: "desc" })).data;
      const notice = turns[0].items[0].content[0].text;
      assert.match(notice, new RegExp(`^<workflow-notification>\\n<run-id>${id}</run-id>`));
      assert.match(notice, /"n": 6/);
      assert.ok(events.some((m) => m.method === "workflowRun/updated" && m.params.runId === id && m.params.kind === "ended"));
    });

    await t.test("the desktop app lists, reads and hears runs, and starts one from a chat without a keyword (WR7)", async () => {
      desktop = await DesktopClient.connect({ socketPath, timeoutMs: 4000, appHome: root, rewindHome: path.join(root, "rewind"), archiveDirectory: path.join(root, "archives"), spawnLinksFile: path.join(root, "links.json"), workflowOptions: { stateDir: path.join(root, "desktop-workflows") } });
      app = await startDesktopServer({ client: desktop, elpisHome: root, trashFile: path.join(root, "trash.json"), loveSpot: { directory: path.join(root, "drawing"), screenshots: path.join(root, "shots") } });
      const launch = new URL(app.url), origin = launch.origin;
      const session = await fetch(`${origin}/api/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: launch.hash.slice(7) }) });
      const cookie = session.headers.get("set-cookie").split(";")[0];
      const api = async (route, body) => {
        const r = await fetch(`${origin}/api${route}`, { method: body === undefined ? "GET" : "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
        return { status: r.status, body: await r.json() };
      };
      const stream = await fetch(`${origin}/api/events`, { headers: { Cookie: cookie } });
      sse = stream.body.getReader();
      let live = "";
      void (async () => { for (;;) { const r = await sse.read().catch(() => ({ done: true })); if (r.done) break; live += Buffer.from(r.value).toString(); } })();
      const parent = (await ok("thread/start", { cwd: root, approvalPolicy: "never", sandbox: "danger-full-access" })).thread.id;
      const started = await api("/workflow-runs", { threadId: parent, script: SCRIPT, args: { word: "app" } });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      const id = started.body.runId;
      await until("the app's run ends", async () => (await api(`/workflow-runs/${id}`)).body.run?.status === "completed");
      const read = (await api(`/workflow-runs/${id}`)).body.run;
      assert.equal(read.origin, "app");
      assert.deepEqual(read.phases.map((x) => x.title), ["Ask"]);
      assert.ok(read.agents.every((a) => a.state === "done" && a.threadId && a.phase === "Ask"));
      assert.match(read.result.a, /first app/);
      const listed = (await api(`/workflow-runs?threadId=${parent}`)).body.data;
      assert.deepEqual(listed.map((x) => x.id), [id]);
      await until("the app hears the run end", () => live.includes("event: workflowRun") && live.includes(`"runId":"${id}"`) && live.includes('"kind":"ended"'));
      assert.equal((await api("/workflow-runs/wf_nope")).status, 404);
      assert.equal((await api(`/workflow-runs/${id}/resume`, {})).status >= 400, true, "a completed run is not resumed in place");
    });

    await t.test("a Claude chat: the same tool through its own MCP server, Claude agents, and the notice as a Claude turn", async () => {
      const parent = (await ok("thread/start", { model: "claude/haiku", cwd: root, approvalPolicy: "never", sandbox: "danger-full-access" })).thread.id;
      await ok("turn/start", { threadId: parent, input: [{ type: "text", text: "[hang] Use a workflow to check the notes", text_elements: [] }] });
      const session = await until("Claude's session", () => fs.existsSync(acpLog) && fs.readFileSync(acpLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.method === "session/new"));
      const server = session.params.mcpServers.find((s) => s.name === "elpis-agents");
      assert.ok(server, "a Claude chat gets the elpis-agents server with the Subagents switch off");
      assert.equal(server.env.find((e) => e.name === "ELPIS_WORKFLOW_TOOL")?.value, "1");
      assert.equal(server.env.find((e) => e.name === "ELPIS_AGENT_TOOLS")?.value, "0");
      const disallowed = session.params._meta.claudeCode.options.disallowedTools;
      assert.ok(disallowed.includes("mcp__elpis-agents__delegate") && !disallowed.some((x) => /workflow$|elpis-agents__\*/.test(x)), disallowed.join(", "));
      const chat = await tool({ ELPIS_PARENT_THREAD: parent });
      const started = await launch(chat, { script: SCRIPT, args: { word: "plum" } });
      assert.equal(started.isError, false, started.text);
      const id = runOf(started.text);
      await until("the run ends", () => runFile(id).status === "completed");
      const run = runFile(id);
      assert.equal(run.model, "claude/haiku");
      assert.match(run.result.a, /answered: .*first plum/s, "the agent ran on Claude");
      assert.equal(run.result.b, null, "Claude's non-JSON answers fail the schema three times: null");
      await ok("turn/interrupt", { threadId: parent, turnId: "x" });
      await until("the notice is delivered", () => runFile(id).notice.state === "delivered");
      await until("Claude answers the notice", () => fs.readFileSync(acpLog, "utf8").includes(`<run-id>${id}</run-id>`) && fs.readFileSync(acpLog, "utf8").split("\n").some((l) => l.includes('"ended"') && l.includes("workflow-notification")));
      await until("the chat is idle", async () => (await ok("thread/read", { threadId: parent })).thread.status.type === "idle");
      const after = await launch(chat, { script: SCRIPT, args: { word: "late" } });
      assert.match(after.text, /did not start: Workflows start only during a message from the person/, "an idle Claude chat, or its notice turn, cannot launch");
    });
  });
}
