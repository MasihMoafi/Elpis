// End-to-end check of the bridge, acting as the Elpis TUI over the app-server protocol.
// Uses the real engine and Claude (subscription). Run: node test/bridge-e2e.mjs [scenario...]
// Scenarios: text, image. Exit code 0 only if every scenario passes.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const here = new URL("..", import.meta.url).pathname;
const port = 47000 + Math.floor(Math.random() * 900);
const bridge = spawn("node", [process.env.E2E_BRIDGE ?? join(here, "acp-bridge.mjs")], {
  env: { ...process.env, PORT: String(port), NODE_USE_ENV_PROXY: "1", ACP_BRIDGE_LOG: process.env.ACP_BRIDGE_LOG ?? "/tmp/acp-bridge/e2e.log" },
  stdio: "ignore",
});
const fail = (msg) => { console.log(`FAIL ${msg}`); process.exitCode = 1; };
await new Promise((r) => setTimeout(r, 800));

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
let seq = 0;
const pending = new Map();
const listeners = new Set();
const approvals = [];
let approvalAnswer = "accept";
const seen = [];
ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  if (m.id !== undefined && !m.method && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.id !== undefined && m.method) { approvals.push(m.params?.command ?? m.method); ws.send(JSON.stringify({ id: m.id, result: { decision: approvalAnswer } })); }
  seen.push(m);
  for (const l of listeners) l(m);
});
const call = (method, params) => new Promise((r) => { const id = `e2e-${++seq}`; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const turn = (threadId, input, timeoutMs = 120000) => new Promise((resolve) => {
  let text = "";
  const l = (m) => {
    if (m.method === "item/agentMessage/delta" && m.params.threadId === threadId) text += m.params.delta;
    if (m.method === "turn/completed" && m.params.threadId === threadId) { listeners.delete(l); resolve({ text, status: m.params.turn.status, error: m.params.turn.error }); }
  };
  listeners.add(l);
  setTimeout(() => { listeners.delete(l); resolve({ text, status: "timeout" }); }, timeoutMs);
  call("turn/start", { threadId, input });
});

const init = await call("initialize", { clientInfo: { name: "codex-tui", title: null, version: "0.160.0" }, capabilities: { experimentalApi: true } });
if (init.error) fail(`initialize: ${JSON.stringify(init.error)}`);
ws.send(JSON.stringify({ method: "initialized" }));
const models = await call("model/list", { cursor: null, limit: null, includeHidden: true });
if (!models.result?.data?.some((m) => m.id === "claude/opus")) fail("model/list has no claude/opus");

const dir = mkdtempSync(join(tmpdir(), "elpis-e2e-"));
const started = await call("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
const threadId = started.result?.thread?.id;
if (!threadId) { fail(`thread/start: ${JSON.stringify(started.error ?? started)}`); process.exit(1); }
await call("thread/settings/update", { threadId, model: "claude/opus", effort: "low" });

const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ["text", "image"];
for (const s of scenarios) {
  if (s === "text") {
    const word = `KIWI-${Math.floor(Math.random() * 9000 + 1000)}`;
    const r = await turn(threadId, [{ type: "text", text: `Reply with exactly: ${word}`, text_elements: [] }]);
    r.text.includes(word) && r.status === "completed" ? console.log(`PASS text (${word})`) : fail(`text: ${JSON.stringify(r)}`);
  } else if (s === "interrupt") {
    const t0 = Date.now();
    let turnId = null;
    const firstDelta = new Promise((r) => { const l = (m) => { if (m.method === "item/agentMessage/delta" && m.params.threadId === threadId) { listeners.delete(l); r(); } }; listeners.add(l); });
    const idL = (m) => { if (m.method === "turn/started" && m.params.threadId === threadId) { turnId = m.params.turn.id; listeners.delete(idL); } };
    listeners.add(idL);
    const done = turn(threadId, [{ type: "text", text: "Write the numbers from 1 to 400, one per line, with a short word after each.", text_elements: [] }], 180000);
    await firstDelta;
    const ir = await call("turn/interrupt", { threadId, turnId });
    const r = await done;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    r.status === "interrupted" && !ir.error ? console.log(`PASS interrupt (stopped after ${secs}s, ${r.text.length} chars)`) : fail(`interrupt: status=${r.status} after ${secs}s, interrupt reply ${JSON.stringify(ir)}`);
    const after = await turn(threadId, [{ type: "text", text: "Reply with exactly: AFTER-STOP", text_elements: [] }]);
    after.text.includes("AFTER-STOP") ? console.log("PASS turn after interrupt") : fail(`turn after interrupt: ${JSON.stringify(after)}`);
  } else if (s === "approval") {
    const { existsSync } = await import("node:fs");
    const ask = await call("thread/start", { cwd: dir, approvalPolicy: "on-request", sandbox: "workspace-write" });
    const askId = ask.result?.thread?.id;
    await call("thread/settings/update", { threadId: askId, model: "claude/opus", effort: "low" });
    for (const [answer, file, want] of [["decline", "denied.txt", false], ["accept", "allowed.txt", true]]) {
      approvalAnswer = answer; approvals.length = 0;
      await turn(askId, [{ type: "text", text: `Use your Bash tool to run exactly: touch ${file}   Then reply DONE.`, text_elements: [] }]);
      const ok = approvals.length > 0 && existsSync(join(dir, file)) === want;
      ok ? console.log(`PASS approval ${answer} (asked ${approvals.length}x, file ${want ? "created" : "absent"})`) : fail(`approval ${answer}: asked ${approvals.length}x, file exists=${existsSync(join(dir, file))}`);
    }
    approvalAnswer = "accept";
  } else if (s === "usage") {
    const from = seen.length;
    await turn(threadId, [{ type: "text", text: "Reply with exactly: USAGE", text_elements: [] }]);
    await new Promise((r) => setTimeout(r, 6000));
    const later = seen.slice(from);
    const limits = later.find((m) => m.method === "account/rateLimits/updated")?.params?.rateLimits;
    const tokens = later.find((m) => m.method === "thread/tokenUsage/updated" && m.params.threadId === threadId)?.params?.tokenUsage;
    const five = limits?.primary;
    five?.windowDurationMins === 300 && typeof five.usedPercent === "number" && tokens?.modelContextWindow > 0
      ? console.log(`PASS usage (5h ${five.usedPercent}% used, context ${tokens.last.totalTokens}/${tokens.modelContextWindow})`)
      : fail(`usage: limits=${JSON.stringify(limits)} tokens=${JSON.stringify(tokens)}`);
  } else if (s === "resume") {
    const word = `PEAR-${Math.floor(Math.random() * 9000 + 1000)}`;
    await turn(threadId, [{ type: "text", text: `Remember this word: ${word}. Reply with just OK.`, text_elements: [] }]);
    ws.close(); bridge.kill(); await new Promise((r) => setTimeout(r, 1500));
    if (process.env.E2E_BREAK_SESSION) {
      const { readFileSync, writeFileSync: wf } = await import("node:fs");
      const storePath = `${process.env.HOME}/.elpis-next/elpis-claude/sessions.json`;
      const st = JSON.parse(readFileSync(storePath, "utf8"));
      st[threadId] = { ...st[threadId], session: "00000000-0000-4000-8000-000000000000", sessions: undefined };
      wf(storePath, JSON.stringify(st, null, 1));
      console.log("(saved Claude session link broken on purpose)");
    }
    const b2 = spawn("node", [process.env.E2E_BRIDGE ?? join(here, "acp-bridge.mjs")], { env: { ...process.env, PORT: String(port + 1), NODE_USE_ENV_PROXY: "1", ACP_BRIDGE_LOG: "/tmp/acp-bridge/e2e.log" }, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 800));
    const ws2 = new WebSocket(`ws://127.0.0.1:${port + 1}`);
    await new Promise((r) => ws2.on("open", r));
    const p2 = new Map(); let t2 = 0; let text2 = ""; let doneT;
    ws2.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.id !== undefined && !m.method && p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id); } if (m.method === "item/agentMessage/delta") text2 += m.params.delta; if (m.method === "turn/completed") doneT?.(); });
    const c2 = (method, params) => new Promise((r) => { const id = `r-${++t2}`; p2.set(id, r); ws2.send(JSON.stringify({ id, method, params })); });
    await c2("initialize", { clientInfo: { name: "codex-tui", title: null, version: "0.160.0" }, capabilities: { experimentalApi: true } });
    ws2.send(JSON.stringify({ method: "initialized" }));
    const res = await c2("thread/resume", { threadId });
    const model = res.result?.model;
    const items = await c2("thread/items/list", { threadId, turnId: null, cursor: null, limit: 100, sortDirection: "desc" });
    const shown = (items.result?.data ?? []).some((e) => e.item?.type === "userMessage" && JSON.stringify(e.item).includes(word));
    const finished = new Promise((r) => { doneT = r; setTimeout(r, 120000); });
    c2("turn/start", { threadId, input: [{ type: "text", text: "What word did I ask you to remember? Reply with only the word.", text_elements: [] }] });
    await finished;
    model === "claude/opus" && shown && text2.includes(word) ? console.log(`PASS resume (model ${model}, history shown, remembered ${word})`) : fail(`resume: model=${model} shown=${shown} reply=${text2}`);
    ws2.close(); b2.kill();
    process.exit();
  } else if (s === "delegate") {
    const { writeFileSync: wf, readFileSync } = await import("node:fs");
    const word = `SOL-${Math.floor(Math.random() * 9000 + 1000)}`;
    wf(join(dir, "secret.txt"), word);
    const logBefore = (() => { try { return readFileSync("/tmp/acp-bridge/elpis-agents.log", "utf8").length; } catch { return 0; } })();
    const r = await turn(threadId, [{ type: "text", text: "Use the elpis-agents delegate tool (model gpt-6-luna, effort low) to have that agent read secret.txt in the current folder. Do not read the file yourself. Reply with only what the agent reported.", text_elements: [] }], 300000);
    const agentLog = (() => { try { return readFileSync("/tmp/acp-bridge/elpis-agents.log", "utf8").slice(logBefore); } catch { return ""; } })();
    const delegated = /delegate thread=\S+ status=completed/.test(agentLog);
    delegated && r.text.includes(word) ? console.log(`PASS delegate (Claude -> gpt-6-luna -> ${word})`) : fail(`delegate: delegated=${delegated} reply=${r.text.slice(0, 200)}`);
  } else if (s === "compact") {
    const usedNow = () => [...seen].reverse().find((m) => m.method === "thread/tokenUsage/updated" && m.params.threadId === threadId)?.params?.tokenUsage?.last?.totalTokens;
    for (let i = 0; i < 2; i++) await turn(threadId, [{ type: "text", text: "Write about 600 words on why tests should be able to fail. Plain prose.", text_elements: [] }], 240000);
    await new Promise((r) => setTimeout(r, 2000));
    const before = usedNow();
    const done = new Promise((r) => { const l = (m) => { if (m.method === "turn/completed" && m.params.threadId === threadId) { listeners.delete(l); r(m.params.turn); } }; listeners.add(l); setTimeout(() => r({ status: "timeout" }), 300000); });
    const cr = await call("thread/compact/start", { threadId });
    const ct = await done;
    await new Promise((r) => setTimeout(r, 2000));
    const after = usedNow();
    const word = `FIG-${Math.floor(Math.random() * 9000 + 1000)}`;
    const next = await turn(threadId, [{ type: "text", text: `Reply with exactly: ${word}`, text_elements: [] }]);
    await new Promise((r) => setTimeout(r, 2000));
    const claudeAfter = usedNow();
    !cr.error && ct.status === "completed" && claudeAfter < before - 4000 && next.text.includes(word)
      ? console.log(`PASS compact (Claude context ${before} -> ${claudeAfter} on the next Claude turn)`)
      : fail(`compact: err=${JSON.stringify(cr.error)} status=${ct.status} before=${before} after-compact=${after} claude-next=${claudeAfter} next=${next.text.slice(0, 60)}`);
  } else if (s === "image") {
    const word = process.env.E2E_IMAGE_WORD;
    const path = process.env.E2E_IMAGE_PATH;
    if (!word || !path) { fail("image: set E2E_IMAGE_PATH and E2E_IMAGE_WORD"); continue; }
    const r = await turn(threadId, [
      { type: "text", text: "What word is written in this image? Reply with only the word.", text_elements: [] },
      { type: "localImage", path },
    ]);
    r.text.includes(word) ? console.log(`PASS image (${word})`) : fail(`image: ${JSON.stringify(r)}`);
  }
}
writeFileSync(join(dir, ".done"), "");
ws.close();
bridge.kill();
process.exit();
