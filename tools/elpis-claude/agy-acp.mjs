// ACP agent for Antigravity (`agy`, Google sign-in): lets the Elpis bridge run Gemini (and the
// other Antigravity models) exactly as it runs Claude Code. One `agy` print-mode process per
// session, in its NDJSON stream mode: each {"event":"user"} line is one turn; `step_update`
// events stream text and tool steps; `result` ends the turn. Tool steps are reported with
// Claude Code's tool names, which the bridge already draws as Elpis items.
//
// Approvals: agy has no approval channel in print mode, but runs PreToolUse hooks from each
// workspace's .agents/hooks.json. While Elpis asks before acting, the wrapper adds its own hooks
// folder as a workspace; the hook (agy-gate.mjs) asks the Elpis user through a local socket and
// this wrapper's session/request_permission. Full Access passes --dangerously-skip-permissions,
// Plan mode --mode plan.
import { spawn, execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

const AGY = process.env.AGY_BIN ?? `${process.env.HOME}/.local/bin/agy`;
const DEFAULT_MODEL = process.env.AGY_DEFAULT_MODEL ?? "gemini-3.8-flash-medium";
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const notify = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
// Requests this agent sends its client (the bridge), answered on stdin.
let requestSeq = 0;
const pendingRequests = new Map();
const request = (method, params) => new Promise((resolve, reject) => {
  const id = `agy-${++requestSeq}`;
  pendingRequests.set(id, { resolve, reject });
  send({ id, method, params });
});

// The tools Elpis asks about: commands and file edits; reading and searching run unasked.
const GATED_TOOLS = "run_command|send_command_input|write_to_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit|notebook_execution";
const HOOKS_DIR = join(process.env.ELPIS_HOME || join(process.env.HOME, ".elpis-next"), "elpis-claude", "agy-approvals");
function writeHooks() {
  mkdirSync(join(HOOKS_DIR, ".agents"), { recursive: true });
  const gate = fileURLToPath(new URL("./agy-gate.mjs", import.meta.url));
  const hook = { command: `"${process.execPath}" "${gate}"`, timeout: 86400 };
  writeFileSync(join(HOOKS_DIR, ".agents", "hooks.json"), JSON.stringify({ "elpis-approvals": { PreToolUse: [{ matcher: GATED_TOOLS, hooks: [hook] }] } }, null, 1));
}
// One socket per session: the hook sends the tool call, Elpis's answer goes back.
function approvalSocket(s) {
  const path = join(tmpdir(), `elpis-agy-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
  const server = createServer((conn) => {
    let buf = "";
    conn.on("data", async (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const asked = JSON.parse(buf.slice(0, i)).toolCall ?? {};
      const tool = describe({ name: asked.name, parameters: asked.args });
      const reply = await request("session/request_permission", {
        sessionId: s.id,
        toolCall: { toolCallId: randomUUID(), title: tool.title, kind: tool.name === "Bash" ? "execute" : "edit", rawInput: tool.input, _meta: { claudeCode: { toolName: tool.name } } },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
      }).catch(() => null);
      conn.end(JSON.stringify({ allowed: reply?.outcome?.outcome === "selected" && reply.outcome.optionId === "allow" }) + "\n");
    });
  });
  server.listen(path);
  return { path, close: () => server.close() };
}

const contextSize = (model) => (/^gemini/.test(model) ? 1_048_576 : /^claude/.test(model) ? 200_000 : 131_072);

let modelList = null;
function models() {
  // `agy models` prints "id<TAB>name" lines (and a progress line without a tab).
  modelList ??= new Promise((resolve) => execFile(AGY, ["models"], { timeout: 60_000 }, (err, out) => {
    if (err) process.stderr.write(`agy models: ${err.message}\n`);
    resolve(String(out ?? "").split("\n").map((l) => l.split("\t")).filter((p) => p.length === 2 && p[0].trim())
      .map(([value, name]) => ({ value: value.trim(), name: name.trim(), description: "Antigravity, your Google sign-in" })));
  }));
  return modelList;
}
// Antigravity's ids carry the effort (gemini-3.8-flash-high); a bare family id, as a delegating
// agent may write it, takes its medium version, else the first one listed.
async function resolveModel(value) {
  const list = await models();
  if (list.some((m) => m.value === value)) return value;
  const family = list.filter((m) => m.value.startsWith(`${value}-`));
  return (family.find((m) => m.value === `${value}-medium`) ?? family[0])?.value ?? value;
}
const configOptions = async (s) => [{ id: "model", name: "Model", type: "select", currentValue: s.model, options: await models() }];

// Smallest one-hunk diff (common head and tail kept as context) in Claude Code's structuredPatch form.
function patch(oldText, newText) {
  const a = oldText.split("\n"), b = newText.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (head === a.length && head === b.length) return [];
  const ctx = 3, from = Math.max(0, head - ctx), aEnd = a.length - tail, bEnd = b.length - tail;
  const after = Math.min(tail, ctx);
  const lines = [...a.slice(from, head).map((l) => ` ${l}`), ...a.slice(head, aEnd).map((l) => `-${l}`), ...b.slice(head, bEnd).map((l) => `+${l}`), ...a.slice(aEnd, aEnd + after).map((l) => ` ${l}`)];
  return [{ oldStart: from + 1, oldLines: aEnd + after - from, newStart: from + 1, newLines: bEnd + after - from, lines }];
}
const readOr = (path) => readFile(path, "utf8").catch(() => null);

// agy tool step -> Claude Code tool name, input and title.
function describe(tool) {
  const p = tool?.parameters ?? {};
  const file = p.AbsolutePath ?? p.TargetFile ?? p.FilePath ?? p.Path;
  switch (tool?.name) {
    case "run_command": return { name: "Bash", input: { command: p.CommandLine ?? "" }, title: p.CommandLine ?? "command" };
    case "view_file": return { name: "Read", input: { file_path: file }, title: `Read ${basename(file ?? "")}` };
    case "write_to_file": return { name: "Write", input: { file_path: file }, title: `Write ${basename(file ?? "")}`, file };
    case "replace_file_content": case "multi_replace_file_content": case "sed_file":
      return { name: "Edit", input: { file_path: file }, title: `Edit ${basename(file ?? "")}`, file };
    case "grep_search": return { name: "Grep", input: { pattern: p.Query ?? p.Pattern, path: p.SearchPath ?? p.SearchDirectory }, title: `Search ${p.Query ?? p.Pattern ?? ""}` };
    case "find_by_name": return { name: "Glob", input: { pattern: p.Pattern ?? p.Query, path: p.SearchDirectory ?? p.SearchPath }, title: `Find ${p.Pattern ?? ""}` };
    case "list_dir": return { name: "LS", input: { path: p.DirectoryPath ?? file }, title: `List ${p.DirectoryPath ?? file ?? ""}` };
    default: {
      const first = Object.values(p).find((v) => typeof v === "string");
      return { name: tool?.name ?? "tool", input: p, title: `${tool?.name ?? "tool"}${first ? ` ${String(first).slice(0, 80)}` : ""}` };
    }
  }
}

const sessions = new Map();

function startProcess(s) {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--model", s.model];
  if (s.mode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  if (s.mode === "plan") args.push("--mode", "plan");
  if (s.conversationId) args.push("--conversation", s.conversationId);
  // Elpis asks before acting: its hooks folder joins the workspaces, after the chat's own.
  const asks = s.mode === "default";
  if (asks) { writeHooks(); s.gate ??= approvalSocket(s); args.push("--add-dir", s.cwd, "--add-dir", HOOKS_DIR); }
  args.push("--print=");
  const env = asks ? { ...process.env, ELPIS_AGY_GATE: s.gate.path, ELPIS_AGY_CWD: s.cwd, ELPIS_AGY_HOOKS: HOOKS_DIR } : process.env;
  const proc = spawn(AGY, args, { cwd: s.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  s.proc = proc; s.flags = `${s.model}|${s.mode}`;
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      onEvent(s, m).catch((e) => process.stderr.write(`agy event: ${e.message}\n`));
    }
  });
  proc.stderr.on("data", (d) => process.stderr.write(`agy: ${String(d).trim().slice(0, 300)}\n`));
  proc.on("exit", (code) => {
    if (s.proc === proc) s.proc = null;
    s.initWaiters.splice(0).forEach((r) => r(null));
    const turn = s.turn;
    if (turn) { s.turn = null; turn.cancelled ? turn.resolve({ stopReason: "cancelled" }) : turn.reject({ code: -32603, message: `Antigravity stopped (exit ${code})` }); }
  });
  return new Promise((resolve) => { s.initWaiters.push(resolve); setTimeout(() => resolve(null), 60_000); });
}

async function onEvent(s, m) {
  if (m.event === "init") {
    s.conversationId ??= m.conversation_id ?? m.init?.conversation_id;
    s.initWaiters.splice(0).forEach((r) => r(s.conversationId));
    return;
  }
  const turn = s.turn;
  if (!turn) return;
  if (m.event === "step_update") {
    const u = m.step_update ?? {};
    if (u.step_type === "agent_response") {
      if (u.text_delta) notify(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: u.text_delta } });
      if (u.usage) { turn.used = (u.usage.input_tokens ?? 0) + (u.usage.output_tokens ?? 0); notify(s.id, { sessionUpdate: "usage_update", used: turn.used, size: contextSize(s.model) }); }
    } else if (u.step_type === "tool") {
      const id = `agy-${s.conversationId}-${u.step_index}`;
      const d = describe(u.tool_info ?? { name: u.tool_name });
      const meta = (extra) => ({ claudeCode: { toolName: d.name, ...extra } });
      if (u.state !== "DONE") {
        if (turn.tools.has(id)) return;
        turn.tools.set(id, { before: d.file ? await readOr(d.file) : null });
        notify(s.id, { sessionUpdate: "tool_call", toolCallId: id, title: d.title, kind: d.name === "Bash" ? "execute" : d.name === "Read" ? "read" : "other", status: "pending", rawInput: d.input, _meta: meta() });
        return;
      }
      const before = turn.tools.get(id)?.before ?? null;
      turn.tools.set(id, { done: true });
      const output = u.tool_info?.output ?? "";
      let response;
      if (d.name === "Bash") response = { stdout: String(output).replace(/\r\n/g, "\n").replace(/\n$/, ""), stderr: "" };
      else if (d.file && (d.name === "Edit" || d.name === "Write")) {
        const after = (await readOr(d.file)) ?? "";
        response = before == null ? { type: "create", filePath: d.file, content: after } : { filePath: d.file, structuredPatch: patch(before, after) };
      }
      const failed = u.state === "ERROR" || u.error;
      notify(s.id, { sessionUpdate: "tool_call_update", toolCallId: id, title: d.title, rawInput: d.input, status: failed ? "failed" : "completed", content: output && d.name !== "Bash" ? [{ type: "content", content: { type: "text", text: String(output) } }] : [], _meta: meta(response ? { toolResponse: response } : {}) });
    }
  } else if (m.event === "result") {
    const r = m.result ?? {};
    const u = r.usage ?? {};
    turn.usage.input += u.input_tokens ?? 0; turn.usage.output += u.output_tokens ?? 0; turn.usage.cached += u.cache_read_tokens ?? 0;
    // agy's stream input runs one turn per user message, not a tool-boundary steer. Keep
    // unsent acknowledged messages on the session when the current turn fails or its process
    // stops. Dequeue when handed to agy so failed/cancelled work is never silently replayed.
    const next = s.pendingSteers[0];
    if (next && r.status === "SUCCESS" && s.proc) { s.proc.stdin.write(JSON.stringify({ event: "user", message: { content: next } }) + "\n"); s.pendingSteers.shift(); return; }
    s.turn = null;
    if (r.status !== "SUCCESS") return turn.cancelled ? turn.resolve({ stopReason: "cancelled" }) : turn.reject({ code: -32603, message: r.error || `Antigravity turn ${r.status ?? "failed"}` });
    turn.resolve({ stopReason: "end_turn", usage: { inputTokens: turn.usage.input - turn.usage.cached, outputTokens: turn.usage.output, cachedReadTokens: turn.usage.cached, cachedWriteTokens: 0, totalTokens: turn.usage.input + turn.usage.output } });
  }
}

async function promptText(s, prompt) {
  const parts = [];
  for (const c of prompt ?? []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "image" && c.data) {
      s.imageDir ??= await mkdtemp(join(tmpdir(), "agy-images-"));
      const path = join(s.imageDir, `${randomUUID()}.${(c.mimeType ?? "image/png").split("/")[1] ?? "png"}`);
      await writeFile(path, Buffer.from(c.data, "base64"));
      parts.push(`[The user attached an image: ${path} — open it with your file viewer to see it.]`);
    } else if (c.type === "image" && c.uri) parts.push(`[The user attached an image: ${c.uri}]`);
  }
  let text = parts.join("\n");
  if (s.instructions !== null && !s.instructionsSent) {
    // agy accepts instructions in its conversation, not a replaceable system prompt. Keep the
    // native history, but explicitly supersede its earlier instruction blocks on every change.
    text = `<elpis_instructions>\nThese are the current instructions admitted by Elpis. This block completely replaces every earlier elpis_instructions block; those earlier blocks are historical and no longer apply.\n\n${s.instructions || "No Elpis instruction sources are currently admitted."}\n</elpis_instructions>\n\n${text}`;
    s.instructionsSent = true;
  }
  // The extra hooks workspace is visible to the model, including on resumed conversations.
  // Restate the actual chat directory on every prompt instead of letting that workspace win.
  return `<elpis_session>\nProject directory: ${JSON.stringify(s.cwd)}\nResolve relative task paths in this project. The additional workspace ${JSON.stringify(HOOKS_DIR)} is only Elpis permission infrastructure, not the task project.\n</elpis_session>\n\n${text}`;
}

async function handle(msg) {
  const p = msg.params ?? {};
  const s = p.sessionId ? sessions.get(p.sessionId) : null;
  switch (msg.method) {
    case "initialize":
      return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [] };
    case "session/new":
    case "session/load": {
      const id = msg.method === "session/load" ? p.sessionId : randomUUID();
      const sess = sessions.get(id) ?? { id, cwd: p.cwd ?? process.cwd(), model: DEFAULT_MODEL, mode: "default", conversationId: msg.method === "session/load" ? id : null, proc: null, turn: null, pendingSteers: [], initWaiters: [], instructions: null, instructionsSent: msg.method === "session/load" };
      sess.cwd = p.cwd ?? sess.cwd;
      const instructions = p._meta?.systemPrompt?.append;
      if (typeof instructions === "string" && instructions !== sess.instructions) {
        sess.instructions = instructions;
        sess.instructionsSent = false;
      }
      sessions.set(id, sess);
      // The Antigravity conversation id is the ACP session id, so the bridge can reload it later.
      if (msg.method === "session/new") {
        const conv = await startProcess(sess);
        if (!conv) throw { code: -32603, message: "Antigravity did not start (is `agy` installed and signed in?)" };
        sessions.delete(id); sess.id = conv; sessions.set(conv, sess);
        return { sessionId: conv, configOptions: await configOptions(sess), modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }, { id: "bypassPermissions", name: "Full access" }] } };
      }
      return { configOptions: await configOptions(sess) };
    }
    case "session/set_config_option":
      if (!s) throw { code: -32602, message: "unknown session" };
      if (p.configId === "model") s.model = await resolveModel(p.value);
      else throw { code: -32602, message: `Antigravity has no ${p.configId} option` };
      return { configOptions: await configOptions(s) };
    case "session/set_mode":
      if (!s) throw { code: -32602, message: "unknown session" };
      s.mode = p.modeId;
      return {};
    case "session/prompt": {
      if (!s) throw { code: -32602, message: "unknown session" };
      if (s.turn) throw { code: -32603, message: "a turn is already running" };
      if (s.proc && s.flags !== `${s.model}|${s.mode}`) { const old = s.proc; s.proc = null; old.kill("SIGTERM"); }
      if (!s.proc) await startProcess(s);
      if (!s.proc) throw { code: -32603, message: "Antigravity did not start" };
      const text = await promptText(s, p.prompt);
      return new Promise((resolve, reject) => {
        const hasPendingSteers = s.pendingSteers.length > 0;
        if (hasPendingSteers) s.pendingSteers.push(text);
        s.turn = { resolve, reject, tools: new Map(), usage: { input: 0, output: 0, cached: 0 }, cancelled: false };
        s.proc.stdin.write(JSON.stringify({ event: "user", message: { content: hasPendingSteers ? s.pendingSteers[0] : text } }) + "\n");
        if (hasPendingSteers) s.pendingSteers.shift();
      });
    }
    case "session/cancel":
      if (s?.turn) { s.turn.cancelled = true; const proc = s.proc; s.proc = null; proc?.kill("SIGTERM"); }
      return undefined;
    case "_session/steering": {
      if (!s?.turn) return { outcome: "promptRequired", reason: "noRunningTurn" };
      const turn = s.turn;
      const text = await promptText(s, p.prompt);
      if (s.turn !== turn) return { outcome: "promptRequired", reason: "noRunningTurn" };
      s.pendingSteers.push(text);
      return { outcome: "queued", _meta: { delivery: "nextTurn" } };
    }
    case "session/delete":
      if (s) { s.proc?.kill("SIGTERM"); s.gate?.close(); sessions.delete(p.sessionId); }
      return {};
    default:
      throw { code: -32601, message: `Antigravity adapter does not support ${msg.method}` };
  }
}

let inBuf = "";
process.stdin.on("data", (d) => {
  inBuf += d;
  let i;
  while ((i = inBuf.indexOf("\n")) >= 0) {
    const line = inBuf.slice(0, i).trim(); inBuf = inBuf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === undefined && msg.id !== undefined) {
      const waiting = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      if (waiting) msg.error ? waiting.reject(msg.error) : waiting.resolve(msg.result);
      continue;
    }
    handle(msg).then(
      (result) => { if (msg.id !== undefined) send({ id: msg.id, result: result ?? null }); },
      (e) => { if (msg.id !== undefined) send({ id: msg.id, error: { code: e?.code ?? -32603, message: e?.message ?? String(e) } }); },
    );
  }
});
process.stdin.on("end", () => { for (const s of sessions.values()) { s.proc?.kill("SIGTERM"); s.gate?.close(); } process.exit(0); });
