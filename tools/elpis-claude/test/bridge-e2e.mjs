// End-to-end check of the bridge, acting as the Elpis TUI over the app-server protocol.
// Uses the real engine and Claude (subscription). Run: node test/bridge-e2e.mjs [scenario...]
// Scenarios: text image interrupt approval usage resume delegate compact instructions modes steer tools plan
// shell picker revert review efforts default antigravity structured goal side subagents claude-subagent
// claude-modes full-access plan-full-access context-parts.
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
const approvalThreads = [];
ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  if (m.id !== undefined && !m.method && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.id !== undefined && m.method) { approvals.push(m.params?.command ?? m.method); approvalOffers.push(m.params?.availableDecisions ?? []); approvalThreads.push(m.params?.threadId); ws.send(JSON.stringify({ id: m.id, result: { decision: typeof approvalAnswer === "function" ? approvalAnswer(m) : approvalAnswer } })); }
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

// What the TUI draws for a command string (tui/src/exec_command.rs): it splits the string into
// words; `bash -lc <script>` shows the script, anything else shows the words quoted again.
const shellWords = (s) => {
  const out = []; let cur = null, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { if (cur !== null) out.push(cur); cur = null; i++; }
    else if (c === "'") { const j = s.indexOf("'", i + 1); if (j < 0) return null; cur = (cur ?? "") + s.slice(i + 1, j); i = j + 1; }
    else if (c === '"') { let j = i + 1, v = ""; while (j < s.length && s[j] !== '"') { if (s[j] === "\\" && j + 1 < s.length) { v += s[j + 1]; j += 2; } else v += s[j++]; } if (j >= s.length) return null; cur = (cur ?? "") + v; i = j + 1; }
    else if (c === "\\" && i + 1 < s.length) { cur = (cur ?? "") + s[i + 1]; i += 2; }
    else { cur = (cur ?? "") + c; i++; }
  }
  if (cur !== null) out.push(cur);
  return out;
};
const tuiShows = (cmd) => {
  const w = shellWords(cmd);
  if (!w) return cmd;
  if (w.length === 3 && /(^|\/)(ba|z)?sh$/.test(w[0]) && ["-lc", "-c"].includes(w[1])) return w[2];
  return w.map((x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replaceAll("'", "'\\''")}'`)).join(" ");
};

const init = await call("initialize", { clientInfo: { name: "codex-tui", title: null, version: "0.160.0" }, capabilities: { experimentalApi: true } });
if (init.error) fail(`initialize: ${JSON.stringify(init.error)}`);
ws.send(JSON.stringify({ method: "initialized" }));
const models = await call("model/list", { cursor: null, limit: null, includeHidden: true });
if (!models.result?.data?.some((m) => m.id === "claude/opus")) fail("model/list has no claude/opus");
// The TUI refuses a pasted image unless the selected model lists image input.
const textOnly = (models.result?.data ?? []).filter((m) => m.id.startsWith("claude/") && !m.inputModalities?.includes("image"));
if (textOnly.length) fail(`Claude models without image input: ${textOnly.map((m) => m.id).join(", ")}`);
// A subscription model has none of GPT's speed tiers (Claude's Fast mode bills extra usage); a GPT
// model keeps them, so the check can fail.
const fastOf = (m) => [...(m.serviceTiers ?? []).map((t) => t.name), ...(m.additionalSpeedTiers ?? [])];
const fastSubscription = (models.result?.data ?? []).filter((m) => /^(claude|agy)\//.test(m.id) && fastOf(m).length);
const gptFast = (models.result?.data ?? []).some((m) => !/^(claude|agy)\//.test(m.id) && fastOf(m).length);
if (fastSubscription.length || !gptFast) fail(`speed tiers: subscription models with them ${fastSubscription.map((m) => m.id).join(", ") || "none"}; a GPT model has them ${gptFast}`);
else console.log("PASS tiers (no Fast on subscription models; GPT keeps it)");

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
    // Default is Claude's Accept edits, which runs plain file commands (touch) unasked, so the file
    // is made by a program Claude asks about.
    for (const [answer, file, want, ends] of [["decline", "denied.txt", false, "completed"], ["accept", "allowed.txt", true, "completed"], ["cancel", "stopped.txt", false, "interrupted"]]) {
      approvalAnswer = answer; approvals.length = 0; approvalOffers.length = 0;
      const t = await turn(askId, [{ type: "text", text: `Use your Bash tool to run exactly: python3 -c "open('${file}', 'w')"   Then reply DONE.`, text_elements: [] }]);
      const offered = approvalOffers.at(-1) ?? [];
      const ok = approvals.length > 0 && existsSync(join(dir, file)) === want && t.status === ends && ["accept", "decline", "cancel"].every((d) => offered.includes(d));
      ok ? console.log(`PASS approval ${answer} (asked ${approvals.length}x, file ${want ? "created" : "absent"}, turn ${t.status})`) : fail(`approval ${answer}: asked ${approvals.length}x, file exists=${existsSync(join(dir, file))}, turn ${t.status}, offered ${JSON.stringify(offered)}`);
    }
    approvalAnswer = "accept";
  } else if (s === "agy-approval") {
    // Gemini through Antigravity asks in Elpis before running a command, as Claude does: a
    // declined command does not run, an accepted one does, and it runs in the chat's folder.
    const { existsSync } = await import("node:fs");
    const ask = await call("thread/start", { cwd: dir, approvalPolicy: "on-request", sandbox: "workspace-write" });
    const askId = ask.result?.thread?.id;
    await call("thread/settings/update", { threadId: askId, model: "agy/gemini-3.8-flash-low" });
    for (const [answer, file, want] of [["decline", "agy-denied.txt", false], ["accept", "agy-allowed.txt", true]]) {
      approvalAnswer = answer; approvals.length = 0;
      const t = await turn(askId, [{ type: "text", text: `Use your shell tool to run exactly: touch ${file}   (in the current folder). Then reply DONE.`, text_elements: [] }], 240000);
      const ok = approvals.length > 0 && existsSync(join(dir, file)) === want;
      ok ? console.log(`PASS agy-approval ${answer} (asked ${approvals.length}x: ${approvals[0]}; file ${want ? "created" : "absent"})`) : fail(`agy-approval ${answer}: asked ${approvals.length}x, file exists=${existsSync(join(dir, file))}, turn ${t.status}, reply ${t.text.slice(0, 100)}`);
    }
    approvalAnswer = "accept";
  } else if (s === "helper-approval") {
    // A helper started by a chat that asks before acting asks the user too: its request reaches
    // the TUI (it was declined unseen), a declined command does not run, an accepted one does.
    const { existsSync } = await import("node:fs");
    const st = await call("thread/start", { cwd: dir, approvalPolicy: "untrusted", sandbox: "workspace-write" });
    const tid = st.result?.thread?.id;
    await call("thread/settings/update", { threadId: tid, model: process.env.E2E_MODEL ?? "claude/opus", effort: "low" });
    // The chat's own use of the delegate tool is accepted; the helper's commands are judged.
    approvalAnswer = (m) => (/helper-denied/.test(m.params?.command ?? "") ? "decline" : "accept");
    for (const [file, want] of [["helper-denied.txt", false], ["helper-made.txt", true]]) {
      approvals.length = 0; approvalThreads.length = 0;
      await turn(tid, [{ type: "text", text: `Use the delegate tool (model gpt-6-luna, effort low, allow_writes true) to have a helper run exactly: touch ${file}   in the current folder. Do not run it yourself. Then reply DONE.`, text_elements: [] }], 300000);
      const fromHelper = approvalThreads.some((t) => t && t !== tid);
      const ok = fromHelper && approvals.some((c) => String(c).includes(file)) && existsSync(join(dir, file)) === want;
      ok ? console.log(`PASS helper-approval ${want ? "accept" : "decline"} (the helper asked: ${approvals.find((c) => String(c).includes(file))}; file ${want ? "created" : "absent"})`)
        : fail(`helper-approval ${file}: approvals=${JSON.stringify(approvals)} from-helper=${fromHelper} exists=${existsSync(join(dir, file))}`);
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
    // `last` is the latest request, as the engine reports it: its parts add up to its total, the
    // context now (the dashboard's Last answer card shows them side by side).
    const l = tokens?.last;
    const lastAddsUp = l && l.totalTokens === l.inputTokens + l.outputTokens && l.cachedInputTokens <= l.inputTokens;
    shown === 3 && (process.env.E2E_REAL_USAGE || asked <= 1) && tokens?.modelContextWindow > 0 && inputCounted && lastAddsUp
      ? console.log(`PASS usage (limits on 3 of 3 turns, endpoint asked ${asked}x, 5h ${five.usedPercent}% used, context ${tokens.last.totalTokens}/${tokens.modelContextWindow})`)
      : fail(`usage: limits shown on ${shown} of 3 turns, endpoint asked ${asked}x, context window ${tokens?.modelContextWindow}, total ${JSON.stringify(tokens?.total)} last ${JSON.stringify(l)}`);
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
    wf(join(dir, "word.txt"), word);
    const logBefore = (() => { try { return readFileSync("/tmp/acp-bridge/elpis-agents.log", "utf8").length; } catch { return 0; } })();
    const r = await turn(threadId, [{ type: "text", text: "Use the elpis-agents delegate tool (model gpt-6-luna, effort low) to have that agent read word.txt in the current folder. Do not read the file yourself. Reply with only what the agent reported.", text_elements: [] }], 300000);
    const agentLog = (() => { try { return readFileSync("/tmp/acp-bridge/elpis-agents.log", "utf8").slice(logBefore); } catch { return ""; } })();
    const delegated = /delegate thread=\S+ status=completed/.test(agentLog);
    delegated && r.text.includes(word) ? console.log(`PASS delegate (Claude -> gpt-6-luna -> ${word})`) : fail(`delegate: delegated=${delegated} reply=${r.text.slice(0, 200)}`);
  } else if (s === "compact") {
    const usedNow = () => [...seen].reverse().find((m) => m.method === "thread/tokenUsage/updated" && m.params.threadId === threadId)?.params?.tokenUsage?.last?.totalTokens;
    // Claude Code's own system prompt is most of the context; enough conversation that compacting
    // it shows (two short essays left less than 4k tokens to save).
    for (let i = 0; i < 3; i++) await turn(threadId, [{ type: "text", text: "Write about 1200 words on why tests should be able to fail. Plain prose.", text_elements: [] }], 300000);
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
  } else if (s === "claude-modes") {
    // Each Codex permission mode runs a Claude chat's turn in Claude's matching mode.
    // Manual asks before an edit (declined: no file); Accept edits writes without asking.
    const { existsSync, readFileSync } = await import("node:fs");
    const logFile = process.env.ACP_BRIDGE_LOG ?? "/tmp/acp-bridge/e2e.log";
    const st = await call("thread/start", { cwd: dir, approvalPolicy: "on-request", sandbox: "workspace-write" });
    const tid = st.result?.thread?.id;
    await call("thread/settings/update", { threadId: tid, model: "claude/opus", effort: "low" });
    approvalAnswer = "decline";
    const got = [];
    for (const [want, settings, write] of [
      ["default", { permissions: ":read-only", approvalPolicy: "on-request", approvalsReviewer: "user" }, true],
      ["acceptEdits", { permissions: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "user" }, true],
      ["auto", { permissions: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "auto_review" }, false],
      ["bypassPermissions", { permissions: ":danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" }, false],
    ]) {
      const from = readFileSync(logFile, "utf8").length;
      const set = await call("thread/settings/update", { threadId: tid, ...settings });
      approvals.length = 0;
      const file = `${want}.txt`;
      const r = await turn(tid, [{ type: "text", text: write ? `Create an empty file named ${file} in the current folder with your file-writing tool, then reply DONE. If you are not allowed, reply DENIED.` : "Reply with exactly: OK", text_elements: [] }], 420000);
      const mode = /mode -> (\w+)/.exec(readFileSync(logFile, "utf8").slice(from))?.[1] ?? "(unchanged)";
      got.push({ want, mode, set: set.error ? JSON.stringify(set.error) : "ok", status: r.status, asked: approvals.length, file: write ? existsSync(join(dir, file)) : null });
    }
    approvalAnswer = "accept";
    // Claude's own settings may turn Bypass off (disableBypassPermissionsMode); the bridge's
    // catalog lists the modes they allow. A refused Bypass is not warned of: Full Access answers
    // every question itself (the full-access scenario).
    const { dirname } = await import("node:path");
    const allowed = JSON.parse(readFileSync(join(dirname(storeEnv.ACP_BRIDGE_STORE), "catalog.json"), "utf8")).modes ?? [];
    const warned = seen.some((m) => m.method === "warning" && m.params?.threadId === tid && /Bypass permissions/.test(m.params.message));
    const bypass = got[3];
    const bypassOk = allowed.includes("bypassPermissions") ? bypass.mode === "bypassPermissions" : bypass.mode === "(unchanged)" && !warned;
    console.log(`  ${JSON.stringify(got)} allowed=${JSON.stringify(allowed)} warned=${warned}`);
    const [manual, edits] = got;
    got.slice(0, 3).every((g) => g.mode === g.want) && got.every((g) => g.set === "ok" && g.status === "completed") && manual.asked > 0 && !manual.file && edits.asked === 0 && edits.file && bypassOk
      ? console.log(`PASS claude-modes (Manual asked and wrote nothing; Accept edits wrote unasked; Auto set; Bypass ${allowed.includes("bypassPermissions") ? "set" : "refused by Claude's settings, unwarned"})`)
      : fail("claude-modes: see the line above");
  } else if (s === "full-access") {
    // Full Access never asks, whatever the agent's own mode does (as in Codex, and in Cloudroom).
    // The project's Claude settings turn Bypass off, so Claude stays in a mode that asks before
    // writing in its .claude folder; the bridge answers yes itself. Approvals are declined here,
    // so a question that reached Elpis leaves no file.
    const { existsSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { disableBypassPermissionsMode: "disable" } }));
    const st = await call("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
    const tid = st.result?.thread?.id;
    await call("thread/settings/update", { threadId: tid, model: process.env.E2E_MODEL ?? "claude/opus", effort: "low" });
    approvalAnswer = "decline";
    approvals.length = 0;
    const r = await turn(tid, [{ type: "text", text: "Create an empty file at .claude/full.txt in the current folder with your file-writing tool, then reply DONE. If you are not allowed, reply DENIED.", text_elements: [] }], 420000);
    approvalAnswer = "accept";
    const made = existsSync(join(dir, ".claude", "full.txt"));
    console.log(`  status=${r.status} asked=${approvals.length} made=${made}`);
    r.status === "completed" && approvals.length === 0 && made
      ? console.log("PASS full-access (no question reached Elpis; the file was made)")
      : fail("full-access: see the line above");
  } else if (s === "context-parts") {
    // A Claude chat's context parts are Claude's own token counts from its transcript (which also
    // holds after Elpis restarts), not text length: the tool result and the thinking Elpis draws
    // are those the transcript gives, and they add up to the context Claude reports.
    const { readFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { transcriptTokens } = await import(join(here, "context-split.mjs"));
    const st = await call("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
    const tid = st.result?.thread?.id;
    await call("thread/settings/update", { threadId: tid, model: process.env.E2E_MODEL ?? "claude/opus", effort: "low" });
    const from = seen.length;
    const r = await turn(tid, [{ type: "text", text: "Use your Bash tool to run exactly: seq 1 3000 | paste -sd' ' -   Then reply DONE.", text_elements: [] }], 420000);
    const attr = seen.slice(from).filter((m) => m.method === "thread/tokenUsage/updated" && m.params.threadId === tid).at(-1)?.params?.tokenUsage?.contextAttribution;
    const session = JSON.parse(readFileSync(storeEnv.ACP_BRIDGE_STORE, "utf8"))[tid]?.session;
    const t = transcriptTokens(readFileSync(join(homedir(), ".claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`), "utf8"));
    const parts = attr ? Object.entries(attr).filter(([k]) => k !== "estimatedTotal").reduce((n, [, v]) => n + v, 0) : -1;
    const near = (a, b) => Math.abs(a - b) <= Math.max(50, 0.2 * b);
    console.log(`  status=${r.status} drawn=${JSON.stringify(attr)} transcript=${JSON.stringify(t)}`);
    r.status === "completed" && attr && parts === attr.estimatedTotal && t.toolResults > 2000 && near(attr.toolResults, t.toolResults) && near(attr.reasoning, t.reasoning) && attr.systemInstructions < attr.estimatedTotal
      ? console.log(`PASS context-parts (tool results ${attr.toolResults}, thinking ${attr.reasoning}, system ${attr.systemInstructions} of ${attr.estimatedTotal}: Claude's own counts)`)
      : fail("context-parts: see the line above");
  } else if (s === "plan-full-access") {
    // A Plan turn in Full Access asks only to approve its plan; the approved plan goes on in Full
    // Access, so nothing after it asks, even with Bypass turned off in the project's Claude
    // settings. Every other question is declined here, so one that reached Elpis leaves no file.
    const { existsSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { disableBypassPermissionsMode: "disable" } }));
    const st = await call("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
    const tid = st.result?.thread?.id;
    await call("thread/settings/update", { threadId: tid, model: process.env.E2E_MODEL ?? "claude/opus", effort: "low", collaborationMode: { mode: "plan", settings: { model: process.env.E2E_MODEL ?? "claude/opus", reasoning_effort: "low", developer_instructions: null } } });
    approvals.length = 0;
    approvalAnswer = (m) => (/plan/i.test(m.params?.command ?? "") ? "accept" : "decline");
    const r = await turn(tid, [{ type: "text", text: "Plan this, in one line: create an empty file at .claude/made.txt with your file-writing tool. Present the plan for approval now; once it is approved, do it and reply DONE.", text_elements: [] }], 420000);
    approvalAnswer = "accept";
    const made = existsSync(join(dir, ".claude", "made.txt"));
    console.log(`  status=${r.status} asked=${JSON.stringify(approvals)} made=${made}`);
    r.status === "completed" && approvals.length === 1 && /plan/i.test(approvals[0]) && made
      ? console.log("PASS plan-full-access (only the plan was asked; the file was made after it)")
      : fail("plan-full-access: see the line above");
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
    // Each update draws an "Updated Plan" row, so an unchanged list must not come twice in a row.
    const repeats = plans.filter((m, i) => i > 0 && JSON.stringify(m.params.plan) === JSON.stringify(plans[i - 1].params.plan)).length;
    // Reopening the chat shows its latest plan again (the engine sends plans only while live).
    const reopenFrom = seen.length;
    await call("thread/resume", { threadId });
    await new Promise((r) => setTimeout(r, 1500));
    const replayed = seen.slice(reopenFrom).find((m) => m.method === "turn/plan/updated" && m.params.threadId === threadId)?.params?.plan;
    last.some((p) => /look around/i.test(p.step)) && last.every((p) => ["pending", "inProgress", "completed"].includes(p.status)) && repeats === 0
      && JSON.stringify(replayed) === JSON.stringify(last)
      ? console.log(`PASS plan (${plans.length} plan updates, none repeated, last: ${last.map((p) => `${p.step}=${p.status}`).join(", ")}; shown again on reopen)`)
      : fail(`plan: ${plans.length} updates, ${repeats} repeated, last=${JSON.stringify(last)} replayed=${JSON.stringify(replayed ?? null)}`);
  } else if (s === "shell") {
    // A shell line with an operator must show as typed, not as `echo one '&&' echo two`.
    const from = seen.length;
    await turn(threadId, [{ type: "text", text: "Use your Bash tool to run exactly this one command line, unchanged: echo one && echo two   Then reply DONE.", text_elements: [] }], 180000);
    const rows = seen.slice(from).filter((m) => m.method === "item/completed" && m.params.threadId === threadId && m.params.item?.type === "commandExecution").map((m) => m.params.item);
    const row = rows.find((i) => /echo one/.test(i.command));
    const shown = row ? tuiShows(row.command) : null;
    shown === "echo one && echo two" && /one\s+two/.test(row.aggregatedOutput ?? "")
      ? console.log(`PASS shell (the row reads "${shown}", output one/two)`)
      : fail(`shell: command=${JSON.stringify(row?.command)} shows as ${JSON.stringify(shown)} output=${JSON.stringify(row?.aggregatedOutput)}`);
  } else if (s === "picker") {
    // A chat only Claude answered must be in /resume, named by its first message. Its turns reach
    // the engine as injected history, which never sets the preview that thread/list requires.
    const pdir = mkdtempSync(join(tmpdir(), "elpis-e2e-picker-"));
    const st = await call("thread/start", { cwd: pdir, approvalPolicy: "never", sandbox: "danger-full-access" });
    const tid = st.result?.thread?.id;
    await call("thread/settings/update", { threadId: tid, model: process.env.E2E_MODEL ?? "claude/opus", effort: "low" });
    const word = `PLUM-${Math.floor(Math.random() * 9000 + 1000)}`;
    const r = await turn(tid, [{ type: "text", text: `Reply with exactly: ${word}`, text_elements: [] }]);
    // The /resume picker's request (tui/src/resume_picker.rs), for this folder and for all folders.
    const ask = async (cwd) => (await call("thread/list", { cursor: null, limit: 25, sortKey: "updated_at", modelProviders: null, sourceKinds: ["cli", "vscode"], archived: false, cwd, useStateDbOnly: false })).result?.data ?? [];
    const here = await ask(pdir), all = await ask(null);
    const rows = all.filter((t) => t.id === tid);
    const hereRow = here.find((t) => t.id === tid);
    r.text.includes(word) && hereRow?.preview?.includes(word) && rows.length === 1 && rows[0].preview.includes(word)
      ? console.log(`PASS picker (the Claude-only chat is listed, previewed "${hereRow.preview}")`)
      : fail(`picker: reply=${r.text.slice(0, 40)} in-folder=${JSON.stringify(hereRow?.preview ?? null)} all-folders=${rows.length}x ${JSON.stringify(rows[0]?.preview ?? null)} (${here.length} listed here)`);
  } else if (s === "revert") {
    // Esc-Esc "edit a previous message" on a Claude chat: the rewound turn leaves the history
    // and Claude's memory. Its own chat, so words from other scenarios cannot answer.
    const own = await call("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
    const threadId = own.result?.thread?.id;
    await call("thread/settings/update", { threadId, model: process.env.E2E_MODEL ?? "claude/opus", effort: "low" });
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
  } else if (s === "new-chat-model") {
    // A new Claude chat names its model everywhere Elpis reads one (the agent list showed a
    // fresh Claude chat as GPT-6.1-Sol until its first message). No model is asked.
    const from = seen.length;
    const st = await call("thread/start", { model: "claude/haiku", cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
    const tid = st.result?.thread?.id;
    await new Promise((r) => setTimeout(r, 1500));
    const started = seen.slice(from).find((m) => m.method === "thread/started" && m.params?.thread?.id === tid)?.params.thread;
    const read = (await call("thread/read", { threadId: tid ?? "none", includeTurns: false })).result?.thread;
    const models = { response: st.result?.model, thread: st.result?.thread?.model, started: started?.model ?? "(none)", read: read?.model };
    Object.values(models).every((m) => m === "claude/haiku" || m === "(none)")
      ? console.log(`PASS new-chat-model (${JSON.stringify(models)})`)
      : fail(`new-chat-model: ${JSON.stringify(models)}`);
  } else if (s === "archive-unsaved") {
    // A helper the engine never saved (its only turn failed, so no rollout) archives like any
    // other chat, instead of failing with "no rollout found".
    const { readFileSync: readStore, writeFileSync: writeStore } = await import("node:fs");
    const { randomUUID } = await import("node:crypto");
    const tid = randomUUID();
    const store = (() => { try { return JSON.parse(readStore(storeEnv.ACP_BRIDGE_STORE, "utf8")); } catch { return {}; } })();
    store._delegations = { ...store._delegations, [tid]: { parentThreadId: threadId, model: "agy/gemini-3.8-flash", startedAt: Math.floor(Date.now() / 1000) } };
    writeStore(storeEnv.ACP_BRIDGE_STORE, JSON.stringify(store));
    const from = seen.length;
    const a = await call("thread/archive", { threadId: tid });
    await new Promise((r) => setTimeout(r, 500));
    const told = seen.slice(from).some((m) => m.method === "thread/archived" && m.params?.threadId === tid);
    const after = JSON.parse(readStore(storeEnv.ACP_BRIDGE_STORE, "utf8"));
    !a.error && told && !after._delegations?.[tid]
      ? console.log("PASS archive-unsaved (archived, the TUI was told, the record is gone)")
      : fail(`archive-unsaved: ${JSON.stringify(a.error ?? a.result)} told=${told} record=${!!after._delegations?.[tid]}`);
  } else if (s === "memory") {
    // A Claude chat saves to Elpis's durable memory with the engine's own guarded save, where
    // the workspace opted in (as the Context Ledger's MEMORY.md switch does). Never run against
    // the real Elpis home: MEMORY.md is global.
    const home = process.env.ELPIS_HOME;
    if (!home || !home.startsWith(tmpdir())) { fail("memory: run with ELPIS_HOME set to a temporary folder"); continue; }
    const { createHash } = await import("node:crypto");
    const { mkdirSync, readFileSync: readMemory } = await import("node:fs");
    const { basename } = await import("node:path");
    const slug = basename(dir).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "workspace";
    const key = `${slug}-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`;
    mkdirSync(join(home, "context", "workspaces", key), { recursive: true });
    writeFileSync(join(home, "context", "workspaces", key, "memory-autosave.json"), '{"enabled":true}');
    const st = await call("thread/start", { model: process.env.E2E_MODEL ?? "claude/opus", cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
    const tid = st.result?.thread?.id;
    const word = `MEMTEST-${Math.floor(Math.random() * 9000 + 1000)}`;
    const r = await turn(tid, [{ type: "text", text: `Use your save_memory tool to append exactly this line to memory: "- Prefers Celsius (${word})." (one memory edit with old_text null; checkpoint null). Then reply DONE.`, text_elements: [] }], 240000);
    const memory = (() => { try { return readMemory(join(home, "memories", "MEMORY.md"), "utf8"); } catch { return ""; } })();
    memory.includes(word)
      ? console.log(`PASS memory (Claude saved "${word}" to MEMORY.md through elpis memory-save)`)
      : fail(`memory: MEMORY.md=${JSON.stringify(memory.slice(0, 120))} reply=${r.text.slice(0, 120)}`);
  } else if (s === "smart-prune") {
    // A Claude chat with Smart Prune on sends its requests through the proxy `elpis claude`
    // uses (it shrinks large tool results before Anthropic sees them); with the switch off, it
    // does not. The switch is a global feature flag: run with ELPIS_HOME set to a temporary
    // folder, so the real config is never touched.
    const home = process.env.ELPIS_HOME;
    if (!home || !home.startsWith(tmpdir())) { fail("smart-prune: run with ELPIS_HOME set to a temporary folder"); continue; }
    const { readFileSync: readLog } = await import("node:fs");
    const flip = (on) => call("config/batchWrite", { edits: [{ keyPath: "features.automatic_context_pruning", value: on, mergeStrategy: "replace" }], filePath: null, expectedVersion: null, reloadUserConfig: true });
    const proxied = async () => {
      const origin = [...readLog(process.env.ACP_BRIDGE_LOG ?? "/tmp/acp-bridge/e2e.log", "utf8").matchAll(/smart prune proxy at (\S+)/g)].at(-1)?.[1];
      if (!origin) return 0;
      try { return (await (await fetch(`${origin}/elpis/session.json`)).json()).requests ?? 0; } catch { return 0; }
    };
    const st = await call("thread/start", { model: process.env.E2E_MODEL ?? "claude/opus", cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
    const tid = st.result?.thread?.id;
    await flip(false);
    await new Promise((r) => setTimeout(r, 1500));
    await turn(tid, [{ type: "text", text: "Reply with exactly: OFF", text_elements: [] }]);
    const whileOff = await proxied();
    await flip(true);
    await new Promise((r) => setTimeout(r, 1500));
    const r = await turn(tid, [{ type: "text", text: "Reply with exactly: ON", text_elements: [] }]);
    const whileOn = await proxied();
    whileOff === 0 && whileOn > 0 && r.text.includes("ON")
      ? console.log(`PASS smart-prune (off: no requests through the proxy; on: ${whileOn} request(s) through it, and Claude answered)`)
      : fail(`smart-prune: through the proxy while off=${whileOff}, while on=${whileOn}, reply=${r.text.slice(0, 60)}`);
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
    // Its usage limits reach Elpis like Claude's, and /status can name its Google account.
    const { readFileSync: readAccounts } = await import("node:fs");
    // Asking agy for its usage takes a few seconds after the turn.
    const findLimits = () => seen.find((m) => m.method === "account/rateLimits/updated" && String(m.params?.rateLimits?.limitId).startsWith("antigravity-gemini"))?.params.rateLimits;
    for (let waited = 0; !findLimits() && waited < 30000; waited += 1000) await new Promise((r) => setTimeout(r, 1000));
    const gemLimits = findLimits();
    const storeDir = storeEnv.ACP_BRIDGE_STORE.slice(0, storeEnv.ACP_BRIDGE_STORE.lastIndexOf("/"));
    const accounts = (() => { try { return JSON.parse(readAccounts(`${storeDir}/accounts.json`, "utf8")); } catch { return {}; } })();
    flash?.displayName?.includes("Antigravity") && r.text.includes(word) && ran.includes("ls") && r2.text.includes(word)
      && gemLimits?.primary && gemLimits?.secondary && /@/.test(accounts.agy?.email ?? "")
      ? console.log(`PASS antigravity (${list.filter((m) => m.id.startsWith("agy/")).length} Antigravity models; Gemini ran "ls", answered ${word} and remembered it; limits 5h ${gemLimits.primary.usedPercent}% week ${gemLimits.secondary.usedPercent}%; account recorded)`)
      : fail(`antigravity: listed=${!!flash} reply=${r.text.slice(0, 80)} status=${r.status} ${JSON.stringify(r.error ?? "")} ran=${JSON.stringify(ran)} recall=${r2.text.slice(0, 60)} limits=${JSON.stringify(gemLimits ?? null)} account=${!!accounts.agy}`);
  } else if (s === "structured") {
    // Chat titles and /recap on a Claude chat: the TUI starts a hidden ephemeral thread on the
    // chat's model and asks for JSON (request id "temporary-structured-turn-…"). Claude answers;
    // it used to go to the engine's own model.
    const tmp = await call("thread/start", { model: process.env.E2E_MODEL ?? "claude/opus", cwd: dir, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
    const tid = tmp.result?.thread?.id;
    const schema = { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 36 } }, required: ["title"], additionalProperties: false };
    const from = seen.length;
    const done = new Promise((r) => { const l = (m) => { if (m.method === "turn/completed" && m.params.threadId === tid) { listeners.delete(l); r(m.params.turn); } }; listeners.add(l); setTimeout(() => r({ status: "timeout" }), 60000); });
    const t0 = Date.now();
    const ts = await new Promise((r) => { const id = `temporary-structured-turn-${Date.now()}`; pending.set(id, r); ws.send(JSON.stringify({ id, method: "turn/start", params: { threadId: tid, input: [{ type: "text", text: "Generate a concise task title of at most 36 characters. Do not answer the request.\n\nUser prompt:\nPlease fix the login page so that the password reset email is sent again.", text_elements: [] }], outputSchema: schema } })); });
    const t = await done;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const msg = seen.slice(from).filter((m) => m.method === "item/completed" && m.params.threadId === tid && m.params.item?.type === "agentMessage").at(-1)?.params?.item?.text ?? "";
    let title = null; try { title = JSON.parse(msg).title; } catch {}
    const { readFileSync: rf, existsSync: ex } = await import("node:fs");
    const store = ex(storeEnv.ACP_BRIDGE_STORE) ? JSON.parse(rf(storeEnv.ACP_BRIDGE_STORE, "utf8")) : {};
    !ts.error && t.status === "completed" && typeof title === "string" && title.length >= 1 && title.length <= 36 && /password|reset|login/i.test(title) && !store[tid]?.turns?.length && Date.now() - t0 < 30000
      ? console.log(`PASS structured (Claude titled the chat "${title}" as JSON in ${secs}s; nothing recorded)`)
      : fail(`structured: start=${JSON.stringify(ts.error ?? ts.result?.turn?.status)} status=${t.status} ${JSON.stringify(t.error ?? "")} text=${msg.slice(0, 120)} recorded=${store[tid]?.turns?.length ?? 0} in ${secs}s`);
  } else if (s === "goal") {
    // /goal on a Claude chat runs Claude Code's own /goal: Elpis's goal record says active, a
    // Claude turn pursues it, and the goal reads complete when that turn ends; clear removes it.
    const word = `GOAL-${Math.floor(Math.random() * 9000 + 1000)}`;
    const from = seen.length;
    const done = new Promise((resolve) => listeners.add((m) => { if (m.method === "turn/completed" && m.params.threadId === threadId) resolve(m.params.turn); }));
    const g = await call("thread/goal/set", { threadId, objective: `Reply with exactly ${word}, then stop.`, status: "active" });
    const ended = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), 240000))]);
    await new Promise((r) => setTimeout(r, 1500));
    const later = seen.slice(from).filter((m) => m.params?.threadId === threadId);
    const asked = later.find((m) => m.method === "item/completed" && m.params.item?.type === "userMessage")?.params.item.content?.[0]?.text ?? "";
    const replied = later.filter((m) => m.method === "item/agentMessage/delta").map((m) => m.params.delta).join("");
    const after = (await call("thread/goal/get", { threadId })).result?.goal;
    const cleared = (await call("thread/goal/clear", { threadId })).result?.cleared;
    const gone = (await call("thread/goal/get", { threadId })).result?.goal;
    g.result?.goal?.status === "active" && asked.startsWith("/goal ") && replied.includes(word) && ended?.status === "completed" && after?.status === "complete" && cleared === true && gone === null
      ? console.log(`PASS goal (Claude pursued "${asked.slice(0, 40)}…", replied ${word}; goal complete, then cleared)`)
      : fail(`goal: set=${JSON.stringify(g.error ?? g.result?.goal?.status)} asked=${asked.slice(0, 60)} replied=${replied.slice(0, 60)} turn=${ended?.status} after=${after?.status} cleared=${cleared} gone=${JSON.stringify(gone)}`);
  } else if (s === "queue") {
    // A message queued on a Claude chat (elpis queue, thread/queue/add) runs as its next Claude
    // turn: at once when idle, after the running turn otherwise.
    const words = [1, 2].map(() => `Q-${Math.floor(Math.random() * 9000 + 1000)}`);
    const from = seen.length;
    const replies = [];
    const both = new Promise((resolve) => listeners.add((m) => { if (m.method === "turn/completed" && m.params.threadId === threadId) { replies.push(m.params.turn); if (replies.length === 2) resolve(); } }));
    const a = await call("thread/queue/add", { threadId, input: [{ type: "text", text: `Reply with exactly: ${words[0]}`, text_elements: [] }], clientUserMessageId: "q-a" });
    const b = await call("thread/queue/add", { threadId, input: [{ type: "text", text: `Reply with exactly: ${words[1]}`, text_elements: [] }], clientUserMessageId: "q-b" });
    const waiting = (await call("thread/queue/list", { threadId })).result?.data ?? [];
    await Promise.race([both, new Promise((r) => setTimeout(r, 240000))]);
    const text = seen.slice(from).filter((m) => m.method === "item/agentMessage/delta" && m.params.threadId === threadId).map((m) => m.params.delta).join("");
    const left = (await call("thread/queue/list", { threadId })).result?.data ?? [];
    a.result?.queuedSubmission?.id && b.result?.queuedSubmission?.id && waiting.some((q) => q.clientUserMessageId === "q-b") && replies.length === 2 && text.indexOf(words[0]) >= 0 && text.indexOf(words[1]) > text.indexOf(words[0]) && left.length === 0
      ? console.log(`PASS queue (two queued messages ran in order: ${words.join(", ")})`)
      : fail(`queue: add=${JSON.stringify(a.error ?? a.result)?.slice(0, 120)} waiting=${waiting.length} turns=${replies.length} text=${text.slice(0, 80)} left=${left.length}`);
  } else if (s === "side") {
    // /side and /btw on a Claude chat: an ephemeral fork (on the chat's Claude model) that knows
    // the chat so far and answers with Claude.
    const word = `SIDE-${Math.floor(Math.random() * 9000 + 1000)}`;
    await turn(threadId, [{ type: "text", text: `Remember the word ${word}. Reply with just OK.`, text_elements: [] }]);
    const fk = await call("thread/fork", { threadId, model: process.env.E2E_MODEL ?? "claude/opus", ephemeral: true, excludeTurns: true, cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions: "You are a side-conversation assistant, separate from the main thread." });
    const child = fk.result?.thread?.id;
    const inj = child ? await call("thread/inject_items", { threadId: child, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Side conversation boundary. Everything before this boundary is inherited history from the parent thread. Only messages after it are active." }] }] }) : { error: "no fork" };
    const r = child ? await turn(child, [{ type: "text", text: "Which word did I ask you to remember? Reply with only the word.", text_elements: [] }]) : { text: "", status: "no fork" };
    !fk.error && fk.result?.model === (process.env.E2E_MODEL ?? "claude/opus") && !inj.error && r.status === "completed" && r.text.includes(word)
      ? console.log(`PASS side (fork on ${fk.result.model} answered ${word} from the parent chat)`)
      : fail(`side: fork=${JSON.stringify(fk.error ?? fk.result?.model)} inject=${JSON.stringify(inj.error ?? "ok")} status=${r.status} ${JSON.stringify(r.error ?? "")} reply=${r.text.slice(0, 120)}`);
  } else if (s === "subagents") {
    // The Ledger's Subagents switch, written as the TUI writes it (config/batchWrite of
    // features.multi_agent). Off: from the next turn of the same chat Claude has neither its own
    // agent tools (Agent/Task, Workflow…) nor the elpis-agents delegate tool; on again: both are back. The tools are
    // Claude Code's own list (the bridge logs it each turn) and Claude's answer. Its own bridge
    // runs the engine in a throwaway Elpis home, so the write never reaches the user's config.
    const { readFileSync } = await import("node:fs");
    const home = mkdtempSync(join(tmpdir(), "elpis-e2e-home-"));
    const logPath = join(home, "bridge.log");
    const b3 = spawn("node", [process.env.E2E_BRIDGE ?? join(here, "acp-bridge.mjs")], { env: { ...process.env, ...usageEnv, ...storeEnv, ELPIS_HOME: home, PORT: String(port + 2), NODE_USE_ENV_PROXY: "1", ACP_BRIDGE_LOG: logPath }, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 800));
    const ws3 = new WebSocket(`ws://127.0.0.1:${port + 2}`);
    await new Promise((r, j) => { ws3.on("open", r); ws3.on("error", j); });
    const p3 = new Map(); let t3 = 0; let text3 = ""; let done3;
    ws3.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.id !== undefined && !m.method && p3.has(m.id)) { p3.get(m.id)(m); p3.delete(m.id); } if (m.method === "item/agentMessage/delta") text3 += m.params.delta; if (m.method === "turn/completed") done3?.(m.params.turn); });
    const c3 = (method, params) => new Promise((r) => { const id = `g-${++t3}`; p3.set(id, r); ws3.send(JSON.stringify({ id, method, params })); });
    await c3("initialize", { clientInfo: { name: "codex-tui", title: null, version: "0.160.0" }, capabilities: { experimentalApi: true } });
    ws3.send(JSON.stringify({ method: "initialized" }));
    const tid = (await c3("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" })).result?.thread?.id;
    await c3("thread/settings/update", { threadId: tid, model: process.env.E2E_MODEL ?? "claude/opus", effort: "low" });
    const logText = () => { try { return readFileSync(logPath, "utf8"); } catch { return ""; } };
    const toolsTurn = async (subagents) => {
      const w = subagents === undefined ? null : await c3("config/batchWrite", { edits: [{ keyPath: "features.multi_agent", value: subagents, mergeStrategy: "replace" }], filePath: null, expectedVersion: null, reloadUserConfig: true });
      const from = logText().length;
      text3 = "";
      const finished = new Promise((r) => { done3 = r; setTimeout(() => r({ status: "timeout" }), 180000); });
      c3("turn/start", { threadId: tid, input: [{ type: "text", text: "Without calling any tool, list the exact names of all the tools you can call, comma-separated, and nothing else.", text_elements: [] }] });
      const t = await finished;
      const line = logText().slice(from).split("\n").filter((l) => l.includes("claude tools (session")).at(-1) ?? "";
      const tools = line ? line.slice(line.indexOf("): ") + 3).split(", ") : [];
      return { tools, reply: text3, status: t.status, write: w?.error ?? w?.result?.status ?? "default" };
    };
    const delegating = /^(Agent|Task|ListAgents|SendMessage|Workflow|RemoteTrigger)$/;
    const own = (r) => r.tools.filter((n) => delegating.test(n));
    const del = (r) => r.tools.filter((n) => /elpis-agents/.test(n));
    const on = await toolsTurn(undefined), off = await toolsTurn(false), back = await toolsTurn(true);
    // Claude's own list (its first line); a later "correction" sentence may name removed tools.
    const offReplyClean = !/\b(Agent|Task|ListAgents|SendMessage|Workflow|RemoteTrigger)\b|elpis-agents|delegate/.test(off.reply.trim().split("\n")[0]);
    const ok = [on, back].every((r) => r.tools.some((n) => /^(Agent|Task)$/.test(n)) && del(r).length && r.status === "completed") && off.status === "completed" && off.tools.length > 0 && !own(off).length && !del(off).length && offReplyClean;
    ok ? console.log(`PASS subagents (on: ${[...own(on), ...del(on)].join(", ")}; off: none of them in Claude Code's ${off.tools.length} tools or Claude's answer; on again: ${[...own(back), ...del(back)].join(", ")})`)
      : fail(`subagents: ${[["on", on], ["off", off], ["on again", back]].map(([k, r]) => `${k} [write ${r.write}, turn ${r.status}]: tools=${JSON.stringify([...own(r), ...del(r)])} of ${r.tools.length}, Claude said: ${r.reply.replace(/\s+/g, " ").slice(0, 400)}`).join(" | ")}`);
    ws3.close(); b3.kill();
  } else if (s === "claude-subagent") {
    // A subagent Claude starts with its Agent tool is an Elpis subagent of the chat: a child
    // thread linked to the chat (what Left/Right and /subagents list), "Started"/"Completed" rows
    // in the chat's turn, the subagent's own messages streamed into the child thread, and the
    // child readable again after the turn (resume). Its own chat on Haiku.
    const st = await call("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" });
    const tid = st.result?.thread?.id;
    await call("thread/settings/update", { threadId: tid, model: "claude/haiku" });
    const word = `PONG-${Math.floor(Math.random() * 9000 + 1000)}`;
    const from = seen.length;
    const r = await turn(tid, [{ type: "text", text: `Use your Agent tool (subagent_type general-purpose, description "Say ${word}") to have a subagent reply with exactly ${word} and nothing else. Do not reply ${word} yourself before the subagent has. Then reply DONE.`, text_elements: [] }], 300000);
    const later = seen.slice(from);
    const child = later.find((m) => m.method === "thread/started" && m.params.thread?.parentThreadId === tid)?.params?.thread;
    const cid = child?.id;
    const spawnLink = child?.source?.subAgent?.thread_spawn?.parent_thread_id === tid && child?.canAcceptDirectInput === false && !!child?.agentNickname;
    const activity = (kind) => later.some((m) => m.method === "item/completed" && m.params.threadId === tid && m.params.item?.type === "subAgentActivity" && m.params.item.kind === kind && m.params.item.agentThreadId === cid);
    const childMsgs = later.filter((m) => m.params?.threadId === cid);
    const childText = childMsgs.filter((m) => m.method === "item/agentMessage/delta").map((m) => m.params.delta).join("");
    const childTurnDone = childMsgs.find((m) => m.method === "turn/completed")?.params?.turn?.status;
    const parentLeak = later.filter((m) => m.method === "item/agentMessage/delta" && m.params.threadId === tid).map((m) => m.params.delta).join("");
    // What the TUI asks when it lists and opens the child (agent_navigation, /subagents, resume).
    const read = cid ? await call("thread/read", { threadId: cid, includeTurns: true }) : {};
    const loaded = await call("thread/loaded/list", { cursor: null, limit: null });
    const picker = await call("thread/list", { cursor: null, limit: 100, sortDirection: "desc", modelProviders: [], sourceKinds: ["subAgentThreadSpawn"], useStateDbOnly: true, ancestorThreadId: tid });
    const replay = JSON.stringify(read.result?.thread?.turns ?? []);
    const ok = r.status === "completed" && cid && spawnLink && activity("started") && activity("completed") && childText.includes(word) && childTurnDone === "completed"
      && read.result?.thread?.parentThreadId === tid && replay.includes(word) && (loaded.result?.data ?? []).includes(cid) && (picker.result?.data ?? []).some((t) => t.id === cid);
    ok ? console.log(`PASS claude-subagent (child ${cid} "${child.agentNickname}" of the chat said ${word}; started/completed rows in the chat; readable, listed, replayable)`)
      : fail(`claude-subagent: turn=${r.status} child=${cid ?? "none"} link=${spawnLink} started=${activity("started")} completed=${activity("completed")} child-said=${JSON.stringify(childText.slice(0, 80))} child-turn=${childTurnDone} read=${JSON.stringify(read.error ?? read.result?.thread?.parentThreadId ?? null)} replay-has-word=${replay.includes(word)} loaded=${(loaded.result?.data ?? []).includes(cid)} picker=${(picker.result?.data ?? []).some((t) => t.id === cid)} parent-said=${JSON.stringify(parentLeak.slice(0, 120))}`);
  } else if (s === "pick") {
    // The mother agent reads list_models, hands each job to a helper that fits it, across providers
    // (one must be Gemini through Antigravity), and every helper is recorded under its chat.
    const { readFileSync } = await import("node:fs");
    const work = mkdtempSync(join(tmpdir(), "elpis-e2e-pick-"));
    writeFileSync(join(work, "notes.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(work, "stats.py"), "def average(xs):\n    return sum(xs) / len(xs) - 1\n");
    const logPath = "/tmp/acp-bridge/elpis-agents.log";
    const logAt = (() => { try { return readFileSync(logPath, "utf8").length; } catch { return 0; } })();
    const st = await call("thread/start", { cwd: work, approvalPolicy: "never", sandbox: "danger-full-access" });
    const tid = st.result?.thread?.id;
    await call("thread/settings/update", { threadId: tid, model: process.env.E2E_MODEL ?? "claude/opus", effort: "low" });
    const r = await turn(tid, [{ type: "text", text: "First call list_models to see which helper agents you can use. Then hand off these three jobs with delegate, each to the model that fits it best; do none of them yourself. Job 1 (easy): count the lines in notes.txt. Job 2 (hard): find the bug in stats.py and give the fix. Job 3: have a Gemini model through Antigravity summarise notes.txt in five words. Reply with one line per job: the model you chose and its result.", text_elements: [] }], 900000);
    const agentsLog = (() => { try { return readFileSync(logPath, "utf8").slice(logAt); } catch { return ""; } })();
    const listed = /list_models/.test(agentsLog);
    const models = [...agentsLog.matchAll(/delegate model=(\S+)/g)].map((m) => m[1]);
    const completed = (agentsLog.match(/status=completed/g) ?? []).length;
    const store = (() => { try { return JSON.parse(readFileSync(storeEnv.ACP_BRIDGE_STORE, "utf8")); } catch { return {}; } })();
    const linked = Object.values(store._delegations ?? {}).filter((d) => d.parentThreadId === tid).length;
    listed && models.length >= 3 && models.some((m) => m.startsWith("agy/")) && models.some((m) => !/^(agy|claude)\//.test(m)) && completed >= 3 && linked >= 3 && r.status === "completed"
      ? console.log(`PASS pick (list_models read; helpers ${models.join(", ")}; ${completed} finished; ${linked} recorded under the chat)`)
      : fail(`pick: list_models=${listed} helpers=${JSON.stringify(models)} finished=${completed} recorded=${linked} status=${r.status} reply=${r.text.slice(-300)}`);
  } else if (s === "helper-parent") {
    // A helper started with delegate shows up under the chat that started it: thread/list and
    // thread/read carry parentThreadId, and the chat's descendants list includes it.
    const { readFileSync } = await import("node:fs");
    const work = mkdtempSync(join(tmpdir(), "elpis-e2e-helper-"));
    writeFileSync(join(work, "word.txt"), "PLUM");
    const st = await call("thread/start", { cwd: work, approvalPolicy: "never", sandbox: "danger-full-access" });
    const tid = st.result?.thread?.id;
    await call("thread/settings/update", { threadId: tid, model: process.env.E2E_MODEL ?? "claude/opus", effort: "low" });
    await turn(tid, [{ type: "text", text: "Use the delegate tool (model gpt-6-luna, effort low) to have a helper read word.txt. Do not read it yourself. Reply with what the helper reported.", text_elements: [] }], 300000);
    const store = (() => { try { return JSON.parse(readFileSync(storeEnv.ACP_BRIDGE_STORE, "utf8")); } catch { return {}; } })();
    const helper = Object.entries(store._delegations ?? {}).find(([, d]) => d.parentThreadId === tid)?.[0];
    const listed = (await call("thread/list", { cwd: work, limit: 50, sortKey: "updated_at" })).result?.data ?? [];
    const read = (await call("thread/read", { threadId: helper ?? "none", includeTurns: false })).result?.thread;
    const kids = (await call("thread/list", { ancestorThreadId: tid, limit: 50 })).result?.data ?? [];
    const inList = listed.find((t) => t.id === helper);
    // The chat itself lists with the model it runs on, not the engine's.
    const chatModel = listed.find((t) => t.id === tid)?.model;
    // The helper is titled by its task alone; the list already nests it under its chat.
    const titled = /word\.txt/.test(inList?.name ?? "") && !/^Delegated by/.test(inList?.name ?? "");
    if (!titled) fail(`helper-parent: helper title ${JSON.stringify(inList?.name)}`);
    // The TUI hears of the helper live: its start, with its parent, and its status changes.
    const heardStart = seen.some((m) => m.method === "thread/started" && m.params?.thread?.id === helper && m.params.thread.parentThreadId === tid);
    const heardStatus = seen.some((m) => m.method === "thread/status/changed" && m.params?.threadId === helper);
    if (!heardStart || !heardStatus) fail(`helper-parent: live start heard=${heardStart} status heard=${heardStatus}`);
    helper && inList?.parentThreadId === tid && read?.parentThreadId === tid && kids.some((t) => t.id === helper)
      && chatModel === (process.env.E2E_MODEL ?? "claude/opus") && heardStart && heardStatus
      ? console.log(`PASS helper-parent (helper ${helper} is listed, read and a descendant of its chat, which lists as ${chatModel})`)
      : fail(`helper-parent: helper=${helper} list.parent=${inList?.parentThreadId} read.parent=${read?.parentThreadId} descendants=${JSON.stringify(kids.map((t) => t.id))} chat.model=${chatModel}`);
  } else if (s === "agy-model") {
    // A bare Antigravity family id, as a delegating agent may write it, runs as its medium version.
    const { spawn } = await import("node:child_process");
    const agy = spawn(process.execPath, [new URL("../agy-acp.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
    let buf = ""; const waiting = new Map(); let n = 0;
    agy.stdout.on("data", (d) => { buf += d; for (let i; (i = buf.indexOf("\n")) >= 0;) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiting.get(m.id)?.(m); } catch {} } });
    const rpc = (method, params) => new Promise((r) => { const id = ++n; waiting.set(id, r); agy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
    await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const sid = (await rpc("session/new", { cwd: process.cwd(), mcpServers: [] })).result?.sessionId;
    const set = await rpc("session/set_config_option", { sessionId: sid, configId: "model", value: "gemini-3.8-flash" });
    agy.kill();
    const chosen = set.result?.configOptions?.[0]?.currentValue;
    chosen === "gemini-3.8-flash-medium" ? console.log(`PASS agy-model (gemini-3.8-flash runs as ${chosen})`) : fail(`agy-model: got ${chosen}`);
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
// The run's chats leave Elpis's history (archived, not deleted): each has a temporary
// elpis-e2e-* folder. E2E_KEEP_CHATS=1 keeps them for a look.
if (!process.env.E2E_KEEP_CHATS) {
  const kinds = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];
  const prefix = join(tmpdir(), "elpis-e2e-");
  const mine = [];
  let cursor = null;
  do {
    const r = await call("thread/list", { limit: 200, cursor, sourceKinds: kinds, modelProviders: [] });
    mine.push(...(r.result?.data ?? []).filter((t) => (t.cwd ?? "").startsWith(prefix)));
    cursor = r.result?.nextCursor;
  } while (cursor);
  let archived = 0;
  for (const t of mine) if (!(await call("thread/archive", { threadId: t.id })).error) archived++;
  console.log(`(archived ${archived} of this run's ${mine.length} chats)`);
}
writeFileSync(join(dir, ".done"), "");
// Every message the bridge sent, for checking it against the app-server schema.
if (process.env.E2E_DUMP) writeFileSync(process.env.E2E_DUMP, JSON.stringify(seen));
ws.close();
bridge.kill();
usageServer.close();
process.exit();
