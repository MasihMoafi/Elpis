// Workflows that run until they finish (SPEC "Workflows that run until they finish"), copied from Claude Code's
// Workflow tool: a script orchestrates helper agents; the run lives in the long-lived runtime, keeps a journal per
// run under ELPIS_HOME, resumes from it after a restart (finished agents return their journaled result at once,
// unfinished ones run again), retries passing failures, and tells the chat that started it when it ends.
//
// The runner knows nothing about engines: an executor opens a helper chat and runs one turn in it.
//   executor.open({ runId, agentId, label, phase, model, effort, cwd, parentThreadId, threadId? }) -> { threadId, model }
//   executor.turn({ threadId, text, outputSchema, signal }) -> { text, outputTokens }
// A turn that fails rejects; `error.threadGone` asks for a new chat on the next attempt.
import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { parseScript, checkSchema, validate, strictSchema, fromStrict, jsonAnswer } from "./workflow-script.mjs";

export const LIMITS = Object.freeze({ agents: 1000, items: 4096 });
export const WORKFLOW_WORKER_CAP = 4;
export const defaultConcurrency = () => WORKFLOW_WORKER_CAP;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const OPTS = ["label", "phase", "schema", "model", "effort", "isolation", "agentType"];
const LOG_LINES = 2000;
const NOTICE_RESULT_CHARS = 60_000;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sorted = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
// The reference's cache key: the prompt and the options exactly as the script passed them.
export const agentKey = (prompt, opts) => `v2:${sha256(sorted({ prompt, opts: opts ?? {} }))}`;
const firstLine = (s) => { const l = String(s).trim().split("\n")[0]; return l.length <= 80 ? l : `${l.slice(0, 80).replace(/\s+\S*$/, "")}…`; };
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const t = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(t); reject(signal.reason); };
  signal?.addEventListener("abort", stop, { once: true });
});
const git = (cwd, args) => new Promise((resolve, reject) => execFile("git", ["-C", cwd, ...args], { timeout: 60_000 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(String(out).trim()))));
const writeAtomic = (file, data) => { fs.writeFileSync(`${file}.tmp`, data, { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file); };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const Stopped = () => Object.assign(new Error("The run was stopped."), { name: "Stopped" });

export function startTokenOf(pid) {
  try { const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; } catch { return null; }
}
function ownerAlive(owner) {
  if (!owner?.pid) return false;
  try { process.kill(owner.pid, 0); } catch (e) { if (e.code !== "EPERM") return false; }
  return owner.token == null || startTokenOf(owner.pid) === owner.token;
}

// The person's own request: Claude Code honours "ultracode" or their words asking for a workflow, on turns a person
// started. Autonomous turns (a workflow's notice, a background job's reply) never count.
export const NOTICE_TAG = "<workflow-notification>";
const ASKED = /\bultracode\b|\b(?:use|run|start|launch|create|write|try|with|via|through|using)\s+(?:a|an|the|this|that|my|one|some|\w+\s+)?\s*(?:multi-agent\s+)?workflows?\b|\bworkflows?\s+(?:tool|run)\b|\bfan(?:ning)?\s+out\b[^.\n]{0,40}\bagents?\b/i;
export function personAskedForWorkflow(texts) {
  return texts.some((t) => typeof t === "string" && !t.trimStart().startsWith(NOTICE_TAG) && ASKED.test(t));
}

export function noticeText(run) {
  let result = run.status === "completed" ? JSON.stringify(run.result ?? null, null, 2) : null;
  const cut = result && result.length > NOTICE_RESULT_CHARS;
  if (cut) result = `${result.slice(0, NOTICE_RESULT_CHARS)}\n… (cut; the full result is in ${path.join(run.dir, "result.json")})`;
  const agents = run.agents.length, failed = run.agents.filter((a) => a.state === "failed").length;
  const secs = Math.round(((run.endedAt ?? run.updatedAt) - run.createdAt) / 1000);
  const summary = run.status === "completed" ? `Workflow "${run.name}" completed: ${agents} agents${failed ? ` (${failed} returned null after retries)` : ""}, ${secs} s.`
    : run.status === "stopped" ? `Workflow "${run.name}" was stopped by the person after ${agents} agents.`
      : `Workflow "${run.name}" failed: ${run.error}`;
  return [NOTICE_TAG, `<run-id>${run.id}</run-id>`, `<name>${run.name}</name>`, `<status>${run.status}</status>`, `<summary>${summary}</summary>`,
    ...(result !== null ? [`<result>\n${result}\n</result>`] : []), ...(run.status === "stopped" ? ["Do not restart it unless the person asks."] : []), `<script-path>${run.scriptPath}</script-path>`,
    `<journal>${path.join(run.dir, "journal.jsonl")}</journal>`, "</workflow-notification>"].join("\n");
}

export class WorkflowRunner extends EventEmitter {
  #home; #executor; #slots; #retry; #schemaTries; #maxAgents; #maxItems; #owner; #log; #now;
  #runs = new Map(); // run id -> state (what run.json holds)
  #live = new Map(); // run id -> { worker, controller, slots, agents: Map agentId -> AbortController }
  #saving = new Map();

  constructor({ home, executor, concurrency = defaultConcurrency(), retry = {}, schemaTries = 3, maxAgents = LIMITS.agents, maxItems = LIMITS.items, log = () => {}, now = Date.now }) {
    super();
    this.#home = path.join(home, "workflows");
    this.#executor = executor;
    this.#slots = { free: Math.max(1, concurrency), queue: [] };
    this.#retry = { attempts: retry.attempts ?? 4, delays: retry.delays ?? [2000, 8000, 30000] };
    this.#schemaTries = schemaTries;
    this.#maxAgents = maxAgents;
    this.#maxItems = maxItems;
    this.#owner = { pid: process.pid, token: startTokenOf(process.pid), instance: randomUUID() };
    this.#log = log;
    this.#now = now;
    fs.mkdirSync(path.join(this.#home, "runs"), { recursive: true, mode: 0o700 });
  }

  get runsDir() { return path.join(this.#home, "runs"); }
  busy() { return this.#live.size > 0; }

  // ---- protocol ---------------------------------------------------------------------------------------

  // Launch: `script` (saved to the run's script.js) or `scriptPath`; `resumeFromRunId` starts a new run whose
  // unchanged prefix of agent() calls returns that run's journaled results.
  async start({ script, scriptPath, args, resumeFromRunId, parentThreadId = null, cwd = process.cwd(), model = null, provider = null, effort = null, budget = null, origin = "tool" }) {
    let source = script;
    if (source === undefined || source === null || source === "") {
      if (!scriptPath) throw new Error("Pass script (the workflow's source) or scriptPath.");
      try { source = fs.readFileSync(scriptPath, "utf8"); } catch (e) { throw new Error(`Cannot read scriptPath ${scriptPath}: ${e.message}`); }
    }
    const { meta } = parseScript(source); // a broken meta or script fails the launch, not the run
    let cache = null, from = null;
    if (resumeFromRunId) {
      from = this.#load(resumeFromRunId);
      if (!from) throw new Error(`No workflow run ${resumeFromRunId}.`);
      cache = this.#journal(from.dir);
    }
    const id = `wf_${randomUUID()}`;
    const dir = path.join(this.runsDir, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const saved = path.join(dir, "script.js");
    writeAtomic(saved, source);
    const at = this.#now();
    const run = {
      id, dir, name: meta.name, description: meta.description, whenToUse: meta.whenToUse ?? null,
      phases: (meta.phases ?? []).map((p) => ({ title: p.title, detail: p.detail ?? null, ...(p.model && { model: p.model }) })),
      status: "running", origin, parentThreadId, cwd, model, provider, effort, args: args === undefined ? null : args, argsGiven: args !== undefined,
      budget: Number.isFinite(budget) && budget > 0 ? budget : null, spent: 0,
      scriptPath: saved, resumedFrom: from?.id ?? null, createdAt: at, updatedAt: at, endedAt: null, launches: 0,
      result: null, error: null, logs: [], agents: [], scriptErrors: [], notice: null, owner: this.#owner,
    };
    this.#runs.set(id, run);
    this.#launch(run, cache, { copy: true, previous: from?.agents });
    this.#save(run, true);
    return { runId: id, scriptPath: saved, name: run.name, status: run.status };
  }

  list({ parentThreadId } = {}) {
    this.#scan();
    return [...this.#runs.values()].filter((r) => !parentThreadId || r.parentThreadId === parentThreadId)
      .sort((a, b) => b.createdAt - a.createdAt).map((r) => this.#summary(r));
  }

  read(runId) {
    const run = this.#runs.get(runId) ?? this.#load(runId);
    if (!run) return null;
    const now = this.#now();
    return {
      ...this.#summary(run), description: run.description, phases: run.phases, args: run.argsGiven ? run.args : undefined,
      logs: run.logs, scriptErrors: run.scriptErrors, result: run.result, error: run.error, journal: path.join(run.dir, "journal.jsonl"),
      agents: run.agents.map((a) => ({ ...a, elapsedMs: a.startedAt ? (a.endedAt ?? now) - a.startedAt : 0 })),
    };
  }

  async stop(runId) {
    const run = this.#runs.get(runId) ?? this.#load(runId);
    if (!run) throw new Error(`No workflow run ${runId}.`);
    if (run.status !== "running") return this.read(runId);
    this.#halt(run, "stopped");
    for (const a of run.agents) if (["queued", "running", "retrying"].includes(a.state)) { a.state = "stopped"; a.endedAt = this.#now(); }
    this.#end(run, { status: "stopped", error: null });
    return this.read(runId);
  }

  // Resume in place: the same run, its journal as the cache.
  async resume(runId) {
    const run = this.#runs.get(runId) ?? this.#load(runId);
    if (!run) throw new Error(`No workflow run ${runId}.`);
    if (this.#live.has(runId)) return this.read(runId);
    if (run.status === "completed") throw new Error(`Workflow run ${runId} already completed; start it again with resumeFromRunId to re-run edited calls.`);
    this.#claim(run);
    Object.assign(run, { status: "running", endedAt: null, error: null, result: null, notice: null });
    this.#launch(run, this.#journal(run.dir), { copy: false });
    return this.read(runId);
  }

  // The person skips one agent: agent() returns null for it (the reference's skip).
  skip(runId, agentId) {
    const live = this.#live.get(runId);
    const control = live?.agents.get(agentId);
    if (!control) throw new Error(`Agent ${agentId} is not running in ${runId}.`);
    control.skipped = true;
    control.abort(Object.assign(new Error("Skipped by the person."), { name: "Skipped" }));
  }

  // A run whose chat is still owed its notice, for the runtime to deliver it now.
  pending(runId) {
    const run = this.#runs.get(runId) ?? this.#load(runId);
    return run?.parentThreadId && run.status !== "running" && run.notice?.state === "pending" ? run : null;
  }

  markNotice(runId, notice) {
    const run = this.#runs.get(runId);
    if (!run) return;
    run.notice = { ...run.notice, ...notice };
    this.#save(run, true);
  }

  // After a restart: every run whose owner is gone continues here. Runs that ended but whose chat was never told
  // are offered again through "ended".
  recover() {
    this.#scan();
    const resumed = [];
    for (const run of this.#runs.values()) {
      if (this.#live.has(run.id)) continue;
      const mine = run.owner?.instance === this.#owner.instance;
      if (!mine && run.owner && ownerAlive(run.owner)) continue;
      if (run.status === "running") {
        this.#claim(run);
        this.#log(`workflow ${run.id} resumes after a restart`);
        this.#launch(run, this.#journal(run.dir), { copy: false });
        resumed.push(run.id);
      } else if (!mine && run.parentThreadId && run.notice?.state === "pending") {
        this.#claim(run);
        this.emit("ended", run);
      }
    }
    return resumed;
  }

  // A newer runtime takes over: stop the scripts here without ending the runs, so it resumes them.
  release() {
    for (const run of [...this.#runs.values()]) {
      if (!this.#live.has(run.id)) continue;
      this.#halt(run, "handed over");
      run.owner = null;
      this.#save(run, true);
    }
  }

  close() { for (const run of [...this.#runs.values()]) if (this.#live.has(run.id)) { this.#halt(run, "closed"); this.#save(run, true); } }

  // ---- runs -------------------------------------------------------------------------------------------

  #summary(run) {
    const count = (s) => run.agents.filter((a) => a.state === s).length;
    return {
      id: run.id, name: run.name, status: run.status, parentThreadId: run.parentThreadId, origin: run.origin, cwd: run.cwd,
      scriptPath: run.scriptPath, resumedFrom: run.resumedFrom, createdAt: run.createdAt, updatedAt: run.updatedAt, endedAt: run.endedAt,
      agents: { total: run.agents.length, running: count("running") + count("retrying"), queued: count("queued"), done: count("done"), failed: count("failed"), skipped: count("skipped") },
      budget: run.budget, spent: run.spent, notice: run.notice?.state ?? null,
    };
  }

  #scan() {
    let names = [];
    try { names = fs.readdirSync(this.runsDir); } catch {}
    for (const name of names) if (!this.#runs.has(name)) this.#load(name);
  }

  #load(id) {
    if (this.#runs.has(id)) return this.#runs.get(id);
    if (!/^wf_[\w-]+$/.test(id)) return null;
    const run = readJson(path.join(this.runsDir, id, "run.json"));
    if (!run) return null;
    run.dir = path.join(this.runsDir, id);
    this.#runs.set(id, run);
    return run;
  }

  #claim(run) { run.owner = this.#owner; this.#save(run, true); }

  #save(run, now = false) {
    run.updatedAt = this.#now();
    const write = () => { this.#saving.delete(run.id); try { const { dir, ...rest } = run; writeAtomic(path.join(run.dir, "run.json"), JSON.stringify(rest)); } catch (e) { this.#log(`workflow ${run.id}: save failed: ${e.message}`); } };
    if (now) { clearTimeout(this.#saving.get(run.id)); write(); return; }
    if (!this.#saving.has(run.id)) this.#saving.set(run.id, setTimeout(write, 50));
  }

  #changed(run, change = {}) {
    this.#save(run);
    this.emit("updated", { runId: run.id, run: this.#summary(run), ...change });
  }

  #append(run, record) { fs.appendFileSync(path.join(run.dir, "journal.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 }); }

  // The journal as a cache: results per key in order, and agents started without a result.
  #journal(dir) {
    const results = new Map(), unfinished = new Map(), known = new Set();
    let lines = [];
    try { lines = fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").split("\n").filter(Boolean); } catch {}
    const open = new Map();
    for (const line of lines) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.type === "started") { known.add(r.key); open.set(r.agentId, r); }
      if (r.type === "result") {
        known.add(r.key); open.delete(r.agentId);
        if (!results.has(r.key)) results.set(r.key, []);
        if (!results.get(r.key).some((x) => x.agentId === r.agentId)) results.get(r.key).push({ agentId: r.agentId, result: r.result });
      }
    }
    for (const r of open.values()) {
      if (!unfinished.has(r.key)) unfinished.set(r.key, []);
      if (!unfinished.get(r.key).includes(r.agentId)) unfinished.get(r.key).push(r.agentId);
    }
    return { results, unfinished, known, any: lines.length > 0 };
  }

  #launch(run, cache, { copy, previous: earlier }) {
    run.launches = (run.launches ?? 0) + 1;
    this.#append(run, { type: "launched" });
    const previous = new Map((earlier ?? run.agents).map((a) => [a.id, a]));
    const state = { cache, copy, broken: false, count: 0, previous, seen: new Set() };
    if (!copy) run.agents = [];
    const source = fs.readFileSync(run.scriptPath, "utf8");
    const spent = new SharedArrayBuffer(8);
    const controller = new AbortController();
    const live = { controller, spent, agents: new Map(), state, worker: null };
    Atomics.store(new BigInt64Array(spent), 0, BigInt(run.spent ?? 0));
    this.#live.set(run.id, live);
    const worker = live.worker = new Worker(new URL("./workflow-worker.mjs", import.meta.url), {
      workerData: { source, args: run.argsGiven ? run.args : undefined, budgetTotal: run.budget, spent, maxItems: this.#maxItems, scriptPath: run.scriptPath },
      resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true,
    });
    worker.on("message", (m) => this.#message(run, live, m));
    worker.on("error", (e) => { if (this.#live.get(run.id) === live) this.#finish(run, { status: "failed", error: e.message }); });
    worker.on("exit", () => { if (this.#live.get(run.id) === live && run.status === "running") this.#finish(run, { status: "failed", error: "The script stopped without returning." }); });
    this.#changed(run, { kind: "launched" });
  }

  #message(run, live, m) {
    if (this.#live.get(run.id) !== live) return;
    const reply = (value) => live.worker.postMessage({ id: m.id, value });
    const refuse = (e) => live.worker.postMessage({ id: m.id, error: e.message, errorName: e.name });
    switch (m.type) {
      case "agent": this.#agent(run, live, m).then(reply, (e) => { if (e?.name !== "Stopped") refuse(e); }); return;
      case "phase":
        if (!run.phases.some((p) => p.title === m.title)) run.phases.push({ title: m.title, detail: null });
        run.currentPhase = m.title;
        this.#changed(run, { kind: "phase", phase: m.title });
        return;
      case "log": this.#note(run, m.message.slice(0, 4000), m.group); return;
      case "scriptError":
        run.scriptErrors.push({ at: this.#now(), where: m.where, message: m.message });
        if (run.scriptErrors.length > 200) run.scriptErrors.shift();
        this.#changed(run, { kind: "scriptError" });
        return;
      case "child":
        for (const p of m.phases) if (!run.phases.some((x) => x.title === p.title && x.group === m.name)) run.phases.push({ title: p.title, detail: p.detail ?? null, group: m.name });
        this.#changed(run, { kind: "child", name: m.name });
        return;
      case "workflow": this.#child(run, m.ref).then(reply, refuse); return;
      case "done": this.#finish(run, { status: "completed", result: m.value }); return;
      case "failed": this.#finish(run, { status: "failed", error: m.message }); return;
    }
  }

  async #child(run, ref) {
    let file;
    if (ref && typeof ref === "object" && typeof ref.scriptPath === "string") file = path.resolve(run.cwd ?? process.cwd(), ref.scriptPath);
    else if (typeof ref === "string" && /^[\w.-]+$/.test(ref)) file = path.join(this.#home, `${ref}.js`);
    else throw new Error("workflow() takes a saved workflow's name or {scriptPath}");
    let source;
    try { source = fs.readFileSync(file, "utf8"); } catch { throw new Error(`Unknown workflow ${typeof ref === "string" ? ref : file}`); }
    parseScript(source);
    return { source, path: file };
  }

  #halt(run, why) {
    const live = this.#live.get(run.id);
    if (!live) return;
    this.#live.delete(run.id);
    live.controller.abort(Stopped());
    for (const c of live.agents.values()) c.abort(Stopped());
    this.#slots.queue = this.#slots.queue.filter(slot => { if (slot.runId !== run.id) return true; slot.reject(Stopped()); return false; });
    live.worker.terminate().catch(() => {});
    this.#log(`workflow ${run.id} halted: ${why}`);
  }

  #finish(run, outcome) {
    if (run.status !== "running") return;
    this.#halt(run, outcome.status);
    this.#end(run, outcome);
  }

  #end(run, { status, result = null, error = null }) {
    Object.assign(run, { status, result, error, endedAt: this.#now(), currentPhase: null });
    if (status === "completed") writeAtomic(path.join(run.dir, "result.json"), JSON.stringify(result, null, 2));
    if (run.parentThreadId) run.notice = { state: "pending" };
    this.#save(run, true);
    this.emit("updated", { runId: run.id, run: this.#summary(run), kind: "ended" });
    this.emit("ended", run);
  }

  // ---- agents -----------------------------------------------------------------------------------------

  #validate(prompt, opts) {
    if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("agent() needs a prompt (a non-empty string)");
    if (opts === null || typeof opts !== "object" || Array.isArray(opts)) throw new TypeError("agent() options must be an object");
    const unknown = Object.keys(opts).filter((k) => !OPTS.includes(k));
    if (unknown.length) throw new TypeError(`agent() does not take ${unknown.join(", ")}`);
    if (opts.schema !== undefined) checkSchema(opts.schema);
    if (opts.effort !== undefined && !EFFORTS.includes(opts.effort)) throw new TypeError(`effort must be one of ${EFFORTS.join(", ")}`);
    if (opts.isolation !== undefined && opts.isolation !== "worktree") throw new TypeError("isolation can only be 'worktree'");
    for (const k of ["label", "phase", "model", "agentType"]) if (opts[k] !== undefined && typeof opts[k] !== "string") throw new TypeError(`${k} must be a string`);
  }

  async #agent(run, live, m) {
    const { prompt, opts } = m;
    this.#validate(prompt, opts);
    const { state } = live;
    if (state.count >= this.#maxAgents) throw new RangeError(`This run reached its limit of ${this.#maxAgents} agents.`);
    if (run.budget != null && run.spent >= run.budget) throw new RangeError(`The token budget (${run.budget}) is spent: ${run.spent} output tokens.`);
    state.count++;
    const key = agentKey(prompt, opts);
    const phase = opts.phase ?? m.phase ?? null;
    const label = opts.label ?? firstLine(prompt);
    const group = m.group ?? null;
    const cache = state.cache;
    // The longest unchanged prefix returns journaled results; the first call the journal never saw (edited or
    // new) and every call after it run live. A call that started but never finished runs again in place.
    if (cache && !state.broken) {
      const hit = cache.results.get(key);
      if (hit?.length) {
        const { agentId, result } = hit.shift();
        const before = state.previous.get(agentId);
        const rec = { id: agentId, key, label, phase, group, state: "done", cached: true, threadId: before?.threadId ?? null, model: before?.model ?? null,
          startedAt: before?.startedAt ?? null, endedAt: before?.endedAt ?? null, attempts: before?.attempts ?? 1, error: null, worktree: before?.worktree ?? null, worktreeBranch: before?.worktreeBranch ?? null };
        if (state.copy || !run.agents.some((a) => a.id === agentId)) run.agents.push(rec);
        if (state.copy) { this.#append(run, { type: "started", key, agentId, label, phase }); this.#append(run, { type: "result", key, agentId, result }); }
        this.#changed(run, { kind: "agent", agent: rec });
        return result;
      }
      if (cache.any && !cache.known.has(key)) state.broken = true;
    }
    const again = !state.copy ? cache?.unfinished.get(key)?.shift() : undefined;
    const before = again ? state.previous.get(again) : null;
    const rec = { id: again ?? `a${randomBytes(8).toString("hex")}`, key, label, phase, group, state: "queued", cached: false,
      threadId: before?.threadId ?? null, model: null, startedAt: null, endedAt: null, attempts: 0, error: null, worktree: null, worktreeBranch: null, resumed: Boolean(again) };
    run.agents.push(rec);
    this.#changed(run, { kind: "agent", agent: rec });
    await this.#acquire(run.id);
    const control = new AbortController();
    live.agents.set(rec.id, control);
    try {
      if (live.controller.signal.aborted) throw Stopped();
      rec.state = "running"; rec.startedAt = this.#now();
      this.#append(run, { type: "started", key, agentId: rec.id, label, phase });
      this.#writeAgentMeta(run, rec, opts);
      this.#changed(run, { kind: "agent", agent: rec });
      const value = await this.#runAgent(run, rec, prompt, opts, control.signal);
      if (value === null) return null;
      this.#append(run, { type: "result", key, agentId: rec.id, result: value });
      rec.state = "done"; rec.endedAt = this.#now(); rec.error = null;
      this.#changed(run, { kind: "agent", agent: rec });
      return value;
    } catch (e) {
      if (control.skipped) { rec.state = "skipped"; rec.endedAt = this.#now(); this.#changed(run, { kind: "agent", agent: rec }); return null; }
      throw e;
    } finally {
      live.agents.delete(rec.id);
      this.#release();
    }
  }

  #writeAgentMeta(run, rec, opts) {
    try {
      writeAtomic(path.join(run.dir, `agent-${rec.id}.meta.json`), JSON.stringify({ agentType: opts.agentType ?? "workflow-agent", description: rec.label, workflowPhase: rec.phase,
        group: rec.group, model: opts.model ?? run.model ?? null, effort: opts.effort ?? run.effort ?? null, isolation: opts.isolation ?? null, threadId: rec.threadId }));
    } catch {}
  }

  #acquire(runId) {
    if (this.#slots.free > 0) { this.#slots.free--; return Promise.resolve(); }
    return new Promise((resolve, reject) => this.#slots.queue.push({ runId, resolve, reject }));
  }
  #release() {
    const next = this.#slots.queue.shift();
    if (next) next.resolve(); else this.#slots.free++;
  }

  // One agent: retried with backoff until its attempts run out; null after that.
  async #runAgent(run, rec, prompt, opts, signal) {
    let cwd = run.cwd;
    if (opts.isolation === "worktree") ({ top: rec.worktree, branch: rec.worktreeBranch, cwd } = await this.#worktree(run, rec));
    let value = null;
    try {
      for (let attempt = 1; ; attempt++) {
        rec.attempts = attempt;
        try {
          if (!rec.threadId) {
            const model = opts.model ?? run.model ?? null;
            const opened = await this.#executor.open({ runId: run.id, agentId: rec.id, label: rec.label, phase: rec.phase, model,
              providerName: model === run.model ? run.provider ?? null : null, effort: opts.effort ?? run.effort ?? null, cwd, parentThreadId: run.parentThreadId, signal });
            rec.threadId = opened.threadId; rec.model = opened.model ?? opts.model ?? run.model ?? null;
            this.#writeAgentMeta(run, rec, opts);
            this.#changed(run, { kind: "agent", agent: rec });
          }
          const note = attempt > 1 ? `(Attempt ${attempt}: the last one failed with "${rec.error}". Do the task again from where it stands.)\n\n` : rec.resumed ? "(The workflow restarted before you finished. Do the task again from where it stands.)\n\n" : "";
          value = await this.#ask(run, rec, note + this.#frame(run, prompt, opts), opts.schema, signal);
          break;
        } catch (e) {
          if (signal.aborted) throw signal.reason ?? Stopped();
          rec.error = String(e?.message ?? e).slice(0, 500);
          if (e?.terminal || attempt >= this.#retry.attempts) {
            rec.state = "failed"; rec.endedAt = this.#now();
            this.#log(`workflow ${run.id} agent ${rec.id} failed: ${rec.error}`);
            this.#changed(run, { kind: "agent", agent: rec });
            return null;
          }
          if (e?.threadGone) rec.threadId = null;
          rec.state = "retrying";
          this.#changed(run, { kind: "agent", agent: rec });
          await pause(this.#retry.delays[Math.min(attempt - 1, this.#retry.delays.length - 1)], signal);
          rec.state = "running";
          this.#changed(run, { kind: "agent", agent: rec });
        }
      }
    } finally {
      if (rec.threadId) try { this.#executor.close?.(rec.threadId); } catch {}
      if (opts.isolation === "worktree" && rec.worktree && !(rec.worktree = await this.#dropWorktree(run, rec))) rec.worktreeBranch = null;
    }
    if (typeof value === "string" && rec.worktree) value += `\n\n[Changes left in worktree ${rec.worktree} on branch ${rec.worktreeBranch}]`;
    return value;
  }

  // Subagents are told their final message is the return value, not a message for a person (the reference).
  #frame(run, prompt, opts) {
    const lines = [`You are an agent in the workflow "${run.name}". Your final message is returned to the workflow's script as data, not shown to a person: give the result itself.`];
    if (opts.isolation === "worktree") lines.push("You work in your own git worktree; commit nothing unless the task says so.");
    if (opts.schema) lines.push(`Answer with only a JSON object that matches this JSON Schema:\n${JSON.stringify(opts.schema)}`);
    return `${lines.join("\n")}\n\n${prompt}`;
  }

  // A structured answer is validated; a mismatch asks again in the same chat, and is final after its tries.
  async #ask(run, rec, text, schema, signal) {
    for (let i = 1; ; i++) {
      const r = await this.#executor.turn({ threadId: rec.threadId, text, outputSchema: schema ? strictSchema(schema) : null, signal });
      this.#spend(run, r.outputTokens ?? 0);
      if (!schema) return r.text ?? "";
      let answer = jsonAnswer(r.text);
      if (answer !== undefined) answer = fromStrict(answer, schema);
      const errors = answer === undefined ? ["the answer is not a JSON object"] : validate(schema, answer);
      if (!errors.length) return answer;
      this.#log(`workflow ${run.id} agent ${rec.id}: answer ${i} does not match its schema: ${errors.slice(0, 3).join("; ")}`);
      if (i >= this.#schemaTries) throw Object.assign(new Error(`The structured answer did not match the schema after ${i} tries: ${errors.slice(0, 5).join("; ")}`), { terminal: true });
      text = `Your answer did not match the required JSON Schema: ${errors.slice(0, 10).join("; ")}.\nAnswer again with only a JSON object matching:\n${JSON.stringify(schema)}`;
    }
  }

  #spend(run, tokens) {
    if (!tokens) return;
    run.spent = (run.spent ?? 0) + tokens;
    const live = this.#live.get(run.id);
    if (live) Atomics.store(new BigInt64Array(live.spent), 0, BigInt(run.spent));
  }

  // The reference's isolation: a fresh worktree on its own branch per agent, removed with the branch when the agent
  // changed nothing, kept with it otherwise. Where it started is saved beside it, so an agent resumed after a restart
  // keeps its worktree, and one that committed before the restart is not taken for unchanged.
  async #worktree(run, rec) {
    let repo;
    try { repo = await git(run.cwd, ["rev-parse", "--show-toplevel"]); }
    catch { throw Object.assign(new Error("isolation: 'worktree' needs the run's folder to be in a git repository"), { terminal: true }); }
    const top = path.join(run.dir, "worktrees", rec.id), file = `${top}.json`;
    let made = readJson(file);
    if (!made || !fs.existsSync(top)) {
      made ??= { repo, branch: `elpis-workflow/${run.id.slice(3, 11)}/${rec.id}`, base: await git(repo, ["rev-parse", "HEAD"]) };
      fs.mkdirSync(path.dirname(top), { recursive: true });
      writeAtomic(file, JSON.stringify(made));
      const exists = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${made.branch}`]).then(() => true, () => false);
      await git(repo, ["worktree", "add", ...(exists ? [top, made.branch] : ["-b", made.branch, top, made.base])]);
    }
    return { top, branch: made.branch, cwd: path.join(top, path.relative(repo, run.cwd)) };
  }

  async #dropWorktree(run, rec) {
    const file = `${rec.worktree}.json`;
    try {
      const made = readJson(file);
      const dirty = await git(rec.worktree, ["status", "--porcelain"]);
      const head = await git(rec.worktree, ["rev-parse", "HEAD"]);
      if (made && !dirty && head === made.base) {
        await git(made.repo, ["worktree", "remove", "--force", rec.worktree]);
        await git(made.repo, ["branch", "-D", made.branch]);
        fs.rmSync(file, { force: true });
        return null;
      }
      this.#note(run, `${rec.label}: changes kept in worktree ${rec.worktree} on branch ${rec.worktreeBranch}`);
      return rec.worktree;
    } catch (e) { this.#log(`workflow ${run.id}: worktree cleanup: ${e.message}`); return rec.worktree; }
  }

  #note(run, message, group = null) {
    const line = { at: this.#now(), message, ...(group && { group }) };
    run.logs.push(line);
    if (run.logs.length > LOG_LINES) run.logs.splice(0, run.logs.length - LOG_LINES);
    this.#changed(run, { kind: "log", log: line });
  }
}
