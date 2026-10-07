// End-to-end check of the bridge, acting as the Elpis TUI over the app-server protocol.
// Uses the real engine and Claude (subscription). Run: node test/bridge-e2e.mjs [scenario...]
// Scenarios: text image interrupt approval usage resume delegate compact instructions modes steer tools plan.
// Exit code 0 only if every scenario passes.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const here = new URL("..", import.meta.url).pathname;
const port = 47000 + Math.floor(Math.random() * 900);
// A stand-in for Anthropic's usage endpoint, so tests count requests and never hammer the real
// one (E2E_REAL_USAGE=1 uses the real one).
const { createServer } = await import("node:http");
let usageHits = 0;
const usageServer = createServer((req, res) => { usageHits++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3600e3).toISOString() }, seven_day: { utilization: 34, resets_at: null } })); });
await new Promise((r) => usageServer.listen(0, "127.0.0.1", r));
const usageEnv = process.env.E2E_REAL_USAGE ? {} : { ELPIS_CLAUDE_USAGE_URL: `http://127.0.0.1:${usageServer.address().port}/usage`, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
// The bridge's own store (Claude sessions and the default Claude pick) lives in a test folder.
const storeEnv = { ACP_BRIDGE_STORE: process.env.ACP_BRIDGE_STORE ?? join(mkdtempSync(join(tmpdir(), "elpis-e2e-store-")), "sessions.json") };
const bridge = spawn("node", [process.env.E2E_BRIDGE ?? join(here, "acp-bridge.mjs")], {
  env: { ...process.env, ...usageEnv, ...storeEnv, PORT: String(port), NODE_USE_ENV_PROXY: "1", ACP_BRIDGE_LOG: process.env.ACP_BRIDGE_LOG ?? "/tmp/acp-bridge/e2e.log" },
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
const approvalOffers = [];
let approvalAnswer = "accept";
const seen = [];
ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  if (m.id !== undefined && !m.method && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.id !== undefined && m.method) { approvals.push(m.params?.command ?? m.method); approvalOffers.push(m.params?.availableDecisions ?? []); ws.send(JSON.stringify({ id: m.id, result: { decision: approvalAnswer } })); }
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
// The TUI refuses a pasted image unless the selected model lists image input.
const textOnly = (models.result?.data ?? []).filter((m) => m.id.startsWith("claude/") && !m.inputModalities?.includes("image"));
if (textOnly.length) fail(`Claude models without image input: ${textOnly.map((m) => m.id).join(", ")}`);

const dir = process.env.E2E_CWD ?? mkdtempSync(join(tmpdir(), "elpis-e2e-"));
const started = await call("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
const threadId = started.result?.thread?.id;
if (!threadId) { fail(`thread/start: ${JSON.stringify(started.error ?? started)}`); process.exit(1); }
await call("thread/settings/update", { threadId, model: process.env.E2E_MODEL ?? "claude/opus", effort: "low" });

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
    // "cancel" is "No, and tell Elpis what to do differently": the reply stops so the user can type.
    for (const [answer, file, want, ends] of [["decline", "denied.txt", false, "completed"], ["accept", "allowed.txt", true, "completed"], ["cancel", "stopped.txt", false, "interrupted"]]) {
      approvalAnswer = answer; approvals.length = 0; approvalOffers.length = 0;
      const t = await turn(askId, [{ type: "text", text: `Use your Bash tool to run exactly: touch ${file}   Then reply DONE.`, text_elements: [] }]);
      const offered = approvalOffers.at(-1) ?? [];
      const ok = approvals.length > 0 && existsSync(join(dir, file)) === want && t.status === ends && ["accept", "decline", "cancel"].every((d) => offered.includes(d));
      ok ? console.log(`PASS approval ${answer} (asked ${approvals.length}x, file ${want ? "created" : "absent"}, turn ${t.status})`) : fail(`approval ${answer}: asked ${approvals.length}x, file exists=${existsSync(join(dir, file))}, turn ${t.status}, offered ${JSON.stringify(offered)}`);
    }
    approvalAnswer = "accept";
  } else if (s === "usage") {
    // Three quick turns: each shows Claude's limits, and the usage endpoint is asked at most
    // once (Anthropic refuses with HTTP 429 when asked after every turn).
    const hitsBefore = usageHits;
    let shown = 0, tokens = null, five = null;
    for (let i = 0; i < 3; i++) {
      const from = seen.length;
      await turn(threadId, [{ type: "text", text: `Reply with exactly: USAGE-${i}`, text_elements: [] }]);
      await new Promise((r) => setTimeout(r, 4000));
      const later = seen.slice(from);
      const limits = later.find((m) => m.method === "account/rateLimits/updated")?.params?.rateLimits;
      tokens = later.find((m) => m.method === "thread/tokenUsage/updated" && m.params.threadId === threadId)?.params?.tokenUsage ?? tokens;
      if (limits?.primary?.windowDurationMins === 300 && typeof limits.primary.usedPercent === "number") { shown++; five = limits.primary; }
    }
    const asked = usageHits - hitsBefore;
    // Anthropic reports cached input apart from input; Elpis counts it as input, like OpenAI.
    const inputCounted = tokens?.total?.inputTokens >= 1000 && tokens.total.inputTokens >= tokens.total.cachedInputTokens;
    shown === 3 && (process.env.E2E_REAL_USAGE || asked <= 1) && tokens?.modelContextWindow > 0 && inputCounted
      ? console.log(`PASS usage (limits on 3 of 3 turns, endpoint asked ${asked}x, 5h ${five.usedPercent}% used, context ${tokens.last.totalTokens}/${tokens.modelContextWindow})`)
      : fail(`usage: limits shown on ${shown} of 3 turns, endpoint asked ${asked}x, context window ${tokens?.modelContextWindow}, total ${JSON.stringify(tokens?.total)}`);
  } else if (s === "resume") {
    const word = `PEAR-${Math.floor(Math.random() * 9000 + 1000)}`;
    await turn(threadId, [{ type: "text", text: `Remember this word: ${word}. Reply with just OK.`, text_elements: [] }]);
    ws.close(); bridge.kill(); await new Promise((r) => setTimeout(r, 1500));
    if (process.env.E2E_BREAK_SESSION) {
      const { readFileSync, writeFileSync: wf } = await import("node:fs");
      const storePath = storeEnv.ACP_BRIDGE_STORE;
      const st = JSON.parse(readFileSync(storePath, "utf8"));
      st[threadId] = { ...st[threadId], session: "00000000-0000-4000-8000-000000000000", sessions: undefined };
      wf(storePath, JSON.stringify(st, null, 1));
      console.log("(saved Claude session link broken on purpose)");
    }
    const b2 = spawn("node", [process.env.E2E_BRIDGE ?? join(here, "acp-bridge.mjs")], { env: { ...process.env, ...usageEnv, ...storeEnv, PORT: String(port + 1), NODE_USE_ENV_PROXY: "1", ACP_BRIDGE_LOG: "/tmp/acp-bridge/e2e.log" }, stdio: "ignore" });
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
    model === (process.env.E2E_MODEL ?? "claude/opus") && shown && text2.includes(word) ? console.log(`PASS resume (model ${model}, history shown, remembered ${word})`) : fail(`resume: model=${model} shown=${shown} reply=${text2}`);
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
  } else if (s === "instructions") {
    const word = `DEVNONCE-${Math.floor(Math.random() * 9000 + 1000)}`;
    const st = await call("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions: `The Elpis session code word is ${word}.` });
    const tid = st.result?.thread?.id;
    await call("thread/settings/update", { threadId: tid, model: "claude/opus", effort: "low" });
    const r = await turn(tid, [{ type: "text", text: "Without using any tools or reading files, what is the Elpis session code word given in your instructions? Reply with only the code word, or NONE if you were not given one.", text_elements: [] }]);
    r.text.includes(word) ? console.log(`PASS instructions (Claude knew ${word} from Elpis developer instructions)`) : fail(`instructions: reply=${r.text.slice(0, 160)}`);
  } else if (s === "modes") {
    const { existsSync } = await import("node:fs");
    const st = await call("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
    const tid = st.result?.thread?.id;
    await call("thread/settings/update", { threadId: tid, model: "claude/opus", effort: "low" });
    await call("thread/settings/update", { threadId: tid, collaborationMode: { mode: "plan", settings: { model: "apodex/x", reasoning_effort: "medium", developer_instructions: null } } });
    approvalAnswer = "decline"; approvals.length = 0;
    await turn(tid, [{ type: "text", text: "Create an empty file named planned.txt in the current folder.", text_elements: [] }], 180000);
    const planOk = !existsSync(join(dir, "planned.txt"));
    console.log(`  plan turn asked: ${JSON.stringify(approvals)}`);
    approvalAnswer = "accept";
    await call("thread/settings/update", { threadId: tid, collaborationMode: { mode: "default", settings: { model: "apodex/x", reasoning_effort: null, developer_instructions: null } } });
    await turn(tid, [{ type: "text", text: "Now create the empty file planned.txt in the current folder with your tools, then reply DONE.", text_elements: [] }], 180000);
    const defaultOk = existsSync(join(dir, "planned.txt"));
    planOk && defaultOk ? console.log("PASS modes (Plan mode: no file; Default mode: file created)") : fail(`modes: plan kept folder clean=${planOk}, default created file=${defaultOk}`);
  } else if (s === "steer") {
    // A message sent while Claude works must join that reply (Elpis Esc / Enter), not stop it.
    const word = `STEER-${Math.floor(Math.random() * 9000 + 1000)}`;
    let turnId = null;
    const idL = (m) => { if (m.method === "turn/started" && m.params.threadId === threadId) { turnId = m.params.turn.id; listeners.delete(idL); } };
    listeners.add(idL);
    const echoed = [];
    const echoL = (m) => { if (m.method === "item/started" && m.params.item?.type === "userMessage" && m.params.item.clientId === "steer-1") echoed.push(m.params.turnId); };
    listeners.add(echoL);
    const working = new Promise((r) => { const l = (m) => { if (m.method === "item/started" && m.params.threadId === threadId && m.params.item?.type === "commandExecution") { listeners.delete(l); r(); } }; listeners.add(l); setTimeout(r, 90000); });
    const done = turn(threadId, [{ type: "text", text: "Use your Bash tool to run `sleep 8`, then reply with one short sentence.", text_elements: [] }], 180000);
    await working;
    const sr = await call("turn/steer", { threadId, expectedTurnId: turnId, clientUserMessageId: "steer-1", input: [{ type: "text", text: `Also end your final reply with the code word ${word}.`, text_elements: [] }] });
    const r = await done;
    listeners.delete(echoL);
    !sr.error && sr.result?.turnId === turnId && echoed.includes(turnId) && r.status === "completed" && r.text.includes(word)
      ? console.log(`PASS steer (joined the running reply, which ended with ${word})`)
      : fail(`steer: reply=${JSON.stringify(sr)} echoed=${JSON.stringify(echoed)} turn=${turnId} status=${r.status} text=${r.text.slice(-120)}`);
  } else if (s === "tools") {
    // Claude's tools must look like Elpis's own: the real command, clean output, reads, diffs.
    writeFileSync(join(dir, "a.txt"), "alpha\nbeta x\ngamma\n");
    const from = seen.length;
    await turn(threadId, [{ type: "text", text: "Do these one at a time with your tools, no commentary: 1) run the shell command `ls` 2) Read a.txt 3) Edit a.txt replacing 'beta x' with 'beta y' 4) Write a new file b.txt containing hello. Then reply DONE.", text_elements: [] }], 240000);
    const later = seen.slice(from).filter((m) => m.params?.threadId === threadId);
    const started = later.filter((m) => m.method === "item/started").map((m) => m.params.item);
    const done = later.filter((m) => m.method === "item/completed").map((m) => m.params.item);
    const ls = done.find((i) => i.type === "commandExecution" && /^ls\b/.test(i.command));
    const lsStartedAs = started.find((i) => i.id === ls?.id)?.command;
    const read = done.find((i) => i.type === "commandExecution" && i.commandActions?.[0]?.type === "read" && /a\.txt$/.test(i.commandActions[0].path));
    const edit = done.find((i) => i.type === "fileChange" && i.changes?.some((c) => c.path.endsWith("a.txt") && c.diff.includes("-beta x") && c.diff.includes("+beta y")));
    const write = done.find((i) => i.type === "fileChange" && i.changes?.some((c) => c.path.endsWith("b.txt") && c.kind?.type === "add"));
    const fenced = done.filter((i) => typeof i.aggregatedOutput === "string" && i.aggregatedOutput.includes("```")).length;
    ls && lsStartedAs === ls.command && ls.aggregatedOutput?.includes("a.txt") && read && edit && write && !fenced
      ? console.log(`PASS tools (ran "${ls.command}", read a.txt, edit diff, new b.txt, no code fences)`)
      : fail(`tools: ls=${ls?.command} started-as=${lsStartedAs} output=${JSON.stringify(ls?.aggregatedOutput)?.slice(0, 60)} read=${!!read} edit=${!!edit} write=${!!write} fenced=${fenced} kinds=${done.map((i) => `${i.type}:${i.command ?? i.changes?.[0]?.path ?? ""}`).join(", ")}`);
  } else if (s === "plan") {
    const from = seen.length;
    await turn(threadId, [{ type: "text", text: "Use your task tools (TaskCreate, then TaskUpdate) to make a task list with exactly two tasks, 'look around' and 'reply', mark both completed, then reply DONE.", text_elements: [] }], 180000);
    const plans = seen.slice(from).filter((m) => m.method === "turn/plan/updated" && m.params.threadId === threadId);
    const last = plans.at(-1)?.params?.plan ?? [];
    last.some((p) => /look around/i.test(p.step)) && last.every((p) => ["pending", "inProgress", "completed"].includes(p.status))
      ? console.log(`PASS plan (${plans.length} plan updates, last: ${last.map((p) => `${p.step}=${p.status}`).join(", ")})`)
      : fail(`plan: ${plans.length} updates, last=${JSON.stringify(last)}`);
  } else if (s === "revert") {
    // Esc-Esc "edit a previous message" on a Claude chat: the rewound turn leaves the history
    // and Claude's memory.
    const ids = [];
    const idL = (m) => { if (m.method === "turn/started" && m.params.threadId === threadId) ids.push(m.params.turn.id); };
    listeners.add(idL);
    const a = `APPLE-${Math.floor(Math.random() * 9000 + 1000)}`, b = `BERRY-${Math.floor(Math.random() * 9000 + 1000)}`;
    await turn(threadId, [{ type: "text", text: `Remember the word ${a}. Reply with just OK.`, text_elements: [] }]);
    await turn(threadId, [{ type: "text", text: `Also remember the word ${b}. Reply with just OK.`, text_elements: [] }]);
    listeners.delete(idL);
    const rv = await call("thread/revert", { threadId, beforeTurnId: ids.at(-1) });
    const listed = await call("thread/turns/list", { threadId, limit: 50, sortDirection: "desc", itemsView: "full" });
    const kept = JSON.stringify(listed.result?.data ?? []);
    const r = await turn(threadId, [{ type: "text", text: "Which words did I ask you to remember in this chat? Reply with only the words.", text_elements: [] }]);
    !rv.error && rv.result?.thread?.id === threadId && kept.includes(a) && !kept.includes(b) && r.text.includes(a) && !r.text.includes(b)
      ? console.log(`PASS revert (history and Claude keep ${a}, forget ${b})`)
      : fail(`revert: error=${JSON.stringify(rv.error)} history has a=${kept.includes(a)} b=${kept.includes(b)} reply=${r.text.slice(0, 120)}`);
  } else if (s === "review") {
    // /review on a Claude chat reviews with Claude (it used to run on the engine's own model).
    const { execFileSync } = await import("node:child_process");
    const repo = mkdtempSync(join(tmpdir(), "elpis-e2e-review-"));
    const git = (...a) => execFileSync("git", ["-c", "user.email=e2e@x", "-c", "user.name=e2e", ...a], { cwd: repo });
    writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a + b\n");
    git("init", "-q"); git("add", "calc.py"); git("commit", "-qm", "add");
    writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n");
    const st = await call("thread/start", { cwd: repo, approvalPolicy: "never", sandbox: "danger-full-access" });
    const tid = st.result?.thread?.id;
    await call("thread/settings/update", { threadId: tid, model: process.env.E2E_MODEL ?? "claude/opus", effort: "low" });
    const from = seen.length;
    const done = new Promise((r) => { const l = (m) => { if (m.method === "turn/completed" && m.params.threadId === tid) { listeners.delete(l); r(m.params.turn); } }; listeners.add(l); setTimeout(() => r({ status: "timeout" }), 300000); });
    const rs = await call("review/start", { threadId: tid, target: { type: "uncommittedChanges" }, delivery: "inline" });
    const t = await done;
    const later = seen.slice(from).filter((m) => m.params?.threadId === tid);
    const entered = later.some((m) => m.method === "item/started" && m.params.item?.type === "enteredReviewMode");
    const exited = later.some((m) => m.method === "item/completed" && m.params.item?.type === "exitedReviewMode");
    const text = later.filter((m) => m.method === "item/agentMessage/delta").map((m) => m.params.delta).join("");
    !rs.error && rs.result?.reviewThreadId === tid && entered && exited && t.status === "completed" && /calc\.py/.test(text) && /subtract|minus|a - b/i.test(text)
      ? console.log("PASS review (Claude reviewed the uncommitted change and found the a - b bug in calc.py)")
      : fail(`review: error=${JSON.stringify(rs.error)} thread=${rs.result?.reviewThreadId} entered=${entered} exited=${exited} status=${t.status} ${JSON.stringify(t.error ?? "")} text=${text.slice(0, 160)}`);
  } else if (s === "efforts") {
    // Each Claude model offers its own effort levels: Haiku has none, so none are offered. A new
    // store has no saved levels yet; the bridge reads them in the background (~1 min).
    let list = models.result?.data ?? [];
    for (let i = 0; i < 12 && list.find((m) => m.id === "claude/haiku")?.supportedReasoningEfforts?.length; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      list = (await call("model/list", { cursor: null, limit: null, includeHidden: true })).result?.data ?? [];
    }
    const haiku = list.find((m) => m.id === "claude/haiku");
    const opus = list.find((m) => m.id === "claude/opus");
    const opusLevels = (opus?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
    haiku && haiku.supportedReasoningEfforts.length === 0 && opusLevels.includes("high") && opusLevels.includes(opus.defaultReasoningEffort)
      ? console.log(`PASS efforts (haiku: none; opus: ${opusLevels.join(",")}, default ${opus.defaultReasoningEffort})`)
      : fail(`efforts: haiku=${JSON.stringify(haiku?.supportedReasoningEfforts)} opus=${opusLevels} default=${opus?.defaultReasoningEffort}`);
  } else if (s === "default") {
    // Picking Claude with "enter default" must make new chats and the next start use Claude,
    // as a GPT pick does. Elpis reads its default from config/read, and the TUI sends that
    // model in thread/start.
    const engineDefault = (await call("config/read", { includeLayers: false, cwd: dir })).result?.config?.model;
    const w = await call("config/batchWrite", { edits: [{ keyPath: "model", value: "claude/haiku", mergeStrategy: "replace" }, { keyPath: "model_reasoning_effort", value: "low", mergeStrategy: "replace" }], filePath: null, expectedVersion: null, reloadUserConfig: true });
    const read = (await call("config/read", { includeLayers: false, cwd: dir })).result?.config;
    const fresh = await call("thread/start", { model: read?.model ?? null, cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
    const restart = await call("thread/start", { model: engineDefault ?? null, cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
    const word = `NEW-${Math.floor(Math.random() * 9000 + 1000)}`;
    const r = fresh.result?.thread?.id ? await turn(fresh.result.thread.id, [{ type: "text", text: `Reply with exactly: ${word}`, text_elements: [] }]) : { text: "" };
    const ok = !w.error && read?.model === "claude/haiku" && fresh.result?.model === "claude/haiku" && restart.result?.model === "claude/haiku" && r.text.includes(word);
    ok ? console.log(`PASS default (config/read, /new and startup all say claude/haiku; the new chat answered ${word})`)
      : fail(`default: write=${JSON.stringify(w.error ?? w.result?.status)} read=${read?.model} new-chat=${fresh.result?.model ?? JSON.stringify(fresh.error)} startup(${engineDefault})=${restart.result?.model} reply=${r.text.slice(0, 60)}`);
  } else if (s === "antigravity") {
    // Gemini from the Antigravity (Google) sign-in, chosen like a Claude model: listed, answers,
    // its tools drawn as Elpis rows, and it remembers the chat across a model switch back.
    const list = models.result?.data ?? [];
    const flash = list.find((m) => m.id === "agy/gemini-3.8-flash-low");
    const st = await call("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
    const tid = st.result?.thread?.id;
    await call("thread/settings/update", { threadId: tid, model: "agy/gemini-3.8-flash-low" });
    const word = `GEM-${Math.floor(Math.random() * 9000 + 1000)}`;
    const from = seen.length;
    const r = await turn(tid, [{ type: "text", text: `Use your shell tool to run \`ls\`, then reply with exactly: ${word}`, text_elements: [] }], 180000);
    const ran = seen.slice(from).filter((m) => m.method === "item/completed" && m.params.threadId === tid && m.params.item?.type === "commandExecution").map((m) => m.params.item.command);
    const r2 = await turn(tid, [{ type: "text", text: "What exact word did you reply with a moment ago? Reply with only that word.", text_elements: [] }], 180000);
    flash?.displayName?.includes("Antigravity") && r.text.includes(word) && ran.includes("ls") && r2.text.includes(word)
      ? console.log(`PASS antigravity (${list.filter((m) => m.id.startsWith("agy/")).length} Antigravity models; Gemini ran "ls", answered ${word} and remembered it)`)
      : fail(`antigravity: listed=${!!flash} reply=${r.text.slice(0, 80)} status=${r.status} ${JSON.stringify(r.error ?? "")} ran=${JSON.stringify(ran)} recall=${r2.text.slice(0, 60)}`);
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
usageServer.close();
process.exit();
