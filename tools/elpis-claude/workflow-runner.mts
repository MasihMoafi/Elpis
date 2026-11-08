import { createWorkflowProcesses } from './workflow-processes.mts';
import { createRunRecords } from './workflow-records.mts';
import { writeAtomic, readJson, startTokenOf, ownerAlive } from './workflow-files.mts';
export { startTokenOf } from './workflow-files.mts'
export { NOTICE_TAG, personAskedForWorkflow, noticeText } from './workflow-notices.mts'
import type { Schema, AgentOptions, Owner, AgentRecord, Run, Executor, Cache, LaunchState, Control, Live, AgentMessage, WorkerMessage, RunnerOptions, StartOptions } from './workflow-types.mts';
// Workflows that run until they finish (SPEC "Workflows that run until they finish"), copied from Claude Code's
// Workflow tool: a script orchestrates helper agents; the run lives in the long-lived runtime, keeps a journal per
// run under ELPIS_HOME, resumes from it after a restart (finished agents return their journaled result at once,
// unfinished ones run again), retries passing failures, and tells the chat that started it when it ends.
//
// The runner knows nothing about engines: an executor opens a helper chat and runs one turn in it.
//   executor.open({ runId, agentId, label, phase, model, effort, cwd, parentThreadId, threadId? }) -> { threadId, model }
//   executor.turn({ threadId, text, outputSchema, signal }) -> { text, outputTokens }
// A turn that fails rejects; `error.threadGone` asks for a new chat on the next attempt.

//

//

//

import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { parseScript, checkSchema, validate, strictSchema, fromStrict, jsonAnswer } from "./workflow-script.mts";
import { autoConcurrency } from "./workflow-concurrency.mts";

export const LIMITS = Object.freeze({ agents: 1000, items: 4096 });
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const OPTS = ["label", "phase", "schema", "model", "effort", "isolation", "agentType"];
const LOG_LINES = 2000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const sorted = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
// The reference's cache key: the prompt and the options exactly as the script passed them.
export const agentKey = (prompt: string, opts: AgentOptions | null | undefined) => `v2:${sha256(sorted({ prompt, opts: opts ?? {} }))}`;
const firstLine = (s: string) => { const l = String(s).trim().split("\n")[0] as string; return l.length <= 80 ? l : `${l.slice(0, 80).replace(/\s+\S*$/, "")}…`; };
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const t = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(t); reject((signal as AbortSignal).reason); };
  signal?.addEventListener("abort", stop, { once: true });
});
const git = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => execFile("git", ["-C", cwd, ...args], { timeout: 60_000 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(String(out).trim()))));
const Stopped = () => Object.assign(new Error("The run was stopped."), { name: "Stopped" });

export class WorkflowRunner extends EventEmitter {
  #home: string; #executor: Executor; #slots: { running: number; queue: { runId: string; resolve: () => void; reject: (reason: unknown) => void }[]; limit: () => number };
  #retry: { attempts: number; delays: number[] }; #schemaTries: number; #maxAgents: number; #maxItems: number; #owner: Owner; #log: (message: string) => void; #now: () => number;
  #records: ReturnType<typeof createRunRecords>;
  #processes: ReturnType<typeof createWorkflowProcesses>;

  constructor({ home, executor, concurrency, retry = {}, schemaTries = 3, maxAgents = LIMITS.agents, maxItems = LIMITS.items, log = () => {}, now = Date.now }: RunnerOptions) {
    super();
    this.#processes = createWorkflowProcesses(maxItems);
    this.#home = path.join(home, "workflows");
    this.#executor = executor;
    this.#slots = { running: 0, queue: [], limit: () => concurrency === undefined ? autoConcurrency() : Math.max(1, concurrency) };
    this.#retry = { attempts: retry.attempts ?? 4, delays: retry.delays ?? [2000, 8000, 30000] };
    this.#schemaTries = schemaTries;
    this.#maxAgents = maxAgents;
    this.#maxItems = maxItems;
    this.#owner = { pid: process.pid, token: startTokenOf(process.pid), instance: randomUUID() };
    this.#log = log;
    this.#now = now;
    this.#records = createRunRecords(this.#home, now, log);
  }

  get runsDir() { return this.#records.runsDir; }
  busy() { return this.#processes.live.size > 0; }

  // ---- protocol ---------------------------------------------------------------------------------------

  // Launch: `script` (saved to the run's script.js) or `scriptPath`; `resumeFromRunId` starts a new run whose
  // unchanged prefix of agent() calls returns that run's journaled results.
  async start({ script, scriptPath, args, resumeFromRunId, parentThreadId = null, cwd = process.cwd(), model = null, provider = null, effort = null, budget = null, origin = "tool" }: StartOptions) {
    let source = script;
    if (source === undefined || source === null || source === "") {
      if (!scriptPath) throw new Error("Pass script (the workflow's source) or scriptPath.");
      try { source = fs.readFileSync(scriptPath, "utf8"); } catch (e) { throw new Error(`Cannot read scriptPath ${scriptPath}: ${(e as Error).message}`); }
    }
    const { meta } = parseScript(source); // a broken meta or script fails the launch, not the run
    let cache: Cache | null = null, from: Run | null = null;
    if (resumeFromRunId) {
      from = this.#records.load(resumeFromRunId);
      if (!from) throw new Error(`No workflow run ${resumeFromRunId}.`);
      cache = this.#records.journal(from.dir);
    }
    const id = `wf_${randomUUID()}`;
    const dir = path.join(this.runsDir, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const saved = path.join(dir, "script.js");
    writeAtomic(saved, source);
    const at = this.#now();
    const run: Run = {
      id, dir, name: meta.name, description: meta.description, whenToUse: meta.whenToUse ?? null,
      phases: (meta.phases ?? []).map((p: { title: string; detail?: string; model?: string }) => ({ title: p.title, detail: p.detail ?? null, ...(p.model && { model: p.model }) })),
      status: "running", origin, parentThreadId, cwd, model, provider, effort, args: args === undefined ? null : args, argsGiven: args !== undefined,
      budget: typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? budget : null, spent: 0,
      scriptPath: saved, resumedFrom: from?.id ?? null, createdAt: at, updatedAt: at, endedAt: null, launches: 0,
      result: null, error: null, logs: [], agents: [], scriptErrors: [], notice: null, owner: this.#owner,
    };
    this.#records.runs.set(id, run);
    this.#launch(run, cache, { copy: true, previous: from?.agents });
    this.#records.save(run, true);
    return { runId: id, scriptPath: saved, name: run.name, status: run.status };
  }

  list({ parentThreadId }: { parentThreadId?: string } = {}) {
    this.#records.scan();
    return [...this.#records.runs.values()].filter((r) => !parentThreadId || r.parentThreadId === parentThreadId)
      .sort((a, b) => b.createdAt - a.createdAt).map((r) => this.#records.summary(r));
  }

  read(runId: string) {
    const run = this.#records.runs.get(runId) ?? this.#records.load(runId);
    if (!run) return null;
    const now = this.#now();
    return {
      ...this.#records.summary(run), description: run.description, phases: run.phases, args: run.argsGiven ? run.args : undefined,
      logs: run.logs, scriptErrors: run.scriptErrors, result: run.result, error: run.error, journal: path.join(run.dir, "journal.jsonl"),
      agents: run.agents.map((a) => ({ ...a, elapsedMs: a.startedAt ? (a.endedAt ?? now) - a.startedAt : 0 })),
    };
  }

  async stop(runId: string) {
    const run = this.#records.runs.get(runId) ?? this.#records.load(runId);
    if (!run) throw new Error(`No workflow run ${runId}.`);
    if (run.status !== "running") return this.read(runId);
    this.#halt(run, "stopped");
    for (const a of run.agents) if (["queued", "running", "retrying"].includes(a.state)) { a.state = "stopped"; a.endedAt = this.#now(); }
    this.#end(run, { status: "stopped", error: null });
    return this.read(runId);
  }

  // Resume in place: the same run, its journal as the cache.
  async resume(runId: string) {
    const run = this.#records.runs.get(runId) ?? this.#records.load(runId);
    if (!run) throw new Error(`No workflow run ${runId}.`);
    if (this.#processes.live.has(runId)) return this.read(runId);
    if (run.status === "completed") throw new Error(`Workflow run ${runId} already completed; start it again with resumeFromRunId to re-run edited calls.`);
    this.#claim(run);
    Object.assign(run, { status: "running", endedAt: null, error: null, result: null, notice: null });
    this.#launch(run, this.#records.journal(run.dir), { copy: false });
    return this.read(runId);
  }

  // The person skips one agent: agent() returns null for it (the reference's skip).
  skip(runId: string, agentId: string) {
    const live = this.#processes.live.get(runId);
    const control = live?.agents.get(agentId);
    if (!control) throw new Error(`Agent ${agentId} is not running in ${runId}.`);
    control.skipped = true;
    control.abort(Object.assign(new Error("Skipped by the person."), { name: "Skipped" }));
  }

  // A run whose chat is still owed its notice, for the runtime to deliver it now.
  pending(runId: string) {
    const run = this.#records.runs.get(runId) ?? this.#records.load(runId);
    return run?.parentThreadId && run.status !== "running" && run.notice?.state === "pending" ? run : null;
  }

  markNotice(runId: string, notice: Record<string, unknown>) {
    const run = this.#records.runs.get(runId);
    if (!run) return;
    run.notice = { ...run.notice, ...notice };
    this.#records.save(run, true);
  }

  // After a restart: every run whose owner is gone continues here. Runs that ended but whose chat was never told
  // are offered again through "ended".
  recover() {
    this.#records.scan();
    const resumed = [];
    for (const run of this.#records.runs.values()) {
      if (this.#processes.live.has(run.id)) continue;
      const mine = run.owner?.instance === this.#owner.instance;
      if (!mine && run.owner && ownerAlive(run.owner)) continue;
      if (run.status === "running") {
        this.#claim(run);
        this.#log(`workflow ${run.id} resumes after a restart`);
        this.#launch(run, this.#records.journal(run.dir), { copy: false });
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
    for (const run of [...this.#records.runs.values()]) {
      if (!this.#processes.live.has(run.id)) continue;
      this.#halt(run, "handed over");
      run.owner = null;
      this.#records.save(run, true);
    }
  }

  close() { for (const run of [...this.#records.runs.values()]) if (this.#processes.live.has(run.id)) { this.#halt(run, "closed"); this.#records.save(run, true); } }

  #claim(run: Run) { run.owner = this.#owner; this.#records.save(run, true); }

  #changed(run: Run, change: object = {}) {
    this.#records.save(run);
    this.emit("updated", { runId: run.id, run: this.#records.summary(run), ...change });
  }

  #launch(run: Run, cache: Cache | null, { copy, previous: earlier }: { copy: boolean; previous?: AgentRecord[] | undefined }) {
    run.launches = (run.launches ?? 0) + 1;
    this.#records.append(run, { type: "launched" });
    const previous = new Map((earlier ?? run.agents).map((a) => [a.id, a]));
    const state: LaunchState = { cache, copy, broken: false, count: 0, previous, seen: new Set<string>() };
    if (!copy) run.agents = [];
    this.#processes.launch(run, state, (live, value) => this.#message(run, live, value), outcome => this.#finish(run, outcome));
    this.#changed(run, { kind: "launched" });
  }

  #message(run: Run, live: Live, m: WorkerMessage) {
    if (this.#processes.live.get(run.id) !== live) return;
    const reply = (value: unknown) => (live.worker as Worker).postMessage({ id: m.id, value });
    const refuse = (e: Error) => (live.worker as Worker).postMessage({ id: m.id, error: e.message, errorName: e.name });
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

  async #child(run: Run, ref: unknown) {
    let file;
    if (ref && typeof ref === "object" && "scriptPath" in ref && typeof ref.scriptPath === "string") file = path.resolve(run.cwd ?? process.cwd(), ref.scriptPath);
    else if (typeof ref === "string" && /^[\w.-]+$/.test(ref)) file = path.join(this.#home, `${ref}.js`);
    else throw new Error("workflow() takes a saved workflow's name or {scriptPath}");
    let source;
    try { source = fs.readFileSync(file, "utf8"); } catch { throw new Error(`Unknown workflow ${typeof ref === "string" ? ref : file}`); }
    parseScript(source);
    return { source, path: file };
  }

  #halt(run: Run, why: string) {
    if (!this.#processes.halt(run.id, Stopped())) return;
    this.#slots.queue = this.#slots.queue.filter(slot => { if (slot.runId !== run.id) return true; slot.reject(Stopped()); return false; });
    this.#log(`workflow ${run.id} halted: ${why}`);
  }

  #finish(run: Run, outcome: { status: string; result?: unknown; error?: string | null }) {
    if (run.status !== "running") return;
    this.#halt(run, outcome.status);
    this.#end(run, outcome);
  }

  #end(run: Run, { status, result = null, error = null }: { status: string; result?: unknown; error?: string | null }) {
    Object.assign(run, { status, result, error, endedAt: this.#now(), currentPhase: null });
    if (status === "completed") writeAtomic(path.join(run.dir, "result.json"), JSON.stringify(result, null, 2));
    if (run.parentThreadId) run.notice = { state: "pending" };
    this.#records.save(run, true);
    this.emit("updated", { runId: run.id, run: this.#records.summary(run), kind: "ended" });
    this.emit("ended", run);
  }

  // ---- agents -----------------------------------------------------------------------------------------

  #validate(prompt: string, opts: AgentOptions) {
    if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("agent() needs a prompt (a non-empty string)");
    if (opts === null || typeof opts !== "object" || Array.isArray(opts)) throw new TypeError("agent() options must be an object");
    const unknown = Object.keys(opts).filter((k) => !OPTS.includes(k));
    if (unknown.length) throw new TypeError(`agent() does not take ${unknown.join(", ")}`);
    if (opts.schema !== undefined) checkSchema(opts.schema);
    if (opts.effort !== undefined && !EFFORTS.includes(opts.effort)) throw new TypeError(`effort must be one of ${EFFORTS.join(", ")}`);
    if (opts.isolation !== undefined && opts.isolation !== "worktree") throw new TypeError("isolation can only be 'worktree'");
    for (const k of ["label", "phase", "model", "agentType"] as const) if (opts[k] !== undefined && typeof opts[k] !== "string") throw new TypeError(`${k} must be a string`);
  }

  async #agent(run: Run, live: Live, m: AgentMessage) {
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
        const { agentId, result } = hit.shift() as { agentId: string; result: unknown };
        const before = state.previous.get(agentId);
        const rec: AgentRecord = { id: agentId, key, label, phase, group, state: "done", cached: true, threadId: before?.threadId ?? null, model: before?.model ?? null,
          startedAt: before?.startedAt ?? null, endedAt: before?.endedAt ?? null, attempts: before?.attempts ?? 1, error: null, worktree: before?.worktree ?? null, worktreeBranch: before?.worktreeBranch ?? null };
        if (state.copy || !run.agents.some((a) => a.id === agentId)) run.agents.push(rec);
        if (state.copy) { this.#records.append(run, { type: "started", key, agentId, label, phase }); this.#records.append(run, { type: "result", key, agentId, result }); }
        this.#changed(run, { kind: "agent", agent: rec });
        return result;
      }
      if (cache.any && !cache.known.has(key)) state.broken = true;
    }
    const again = !state.copy ? cache?.unfinished.get(key)?.shift() : undefined;
    const before = again ? state.previous.get(again) : null;
    const rec: AgentRecord = { id: again ?? `a${randomBytes(8).toString("hex")}`, key, label, phase, group, state: "queued", cached: false,
      threadId: before?.threadId ?? null, model: null, startedAt: null, endedAt: null, attempts: 0, error: null, worktree: null, worktreeBranch: null, resumed: Boolean(again) };
    run.agents.push(rec);
    this.#changed(run, { kind: "agent", agent: rec });
    await this.#acquire(run.id);
    const control: Control = new AbortController();
    live.agents.set(rec.id, control);
    try {
      if (live.controller.signal.aborted) throw Stopped();
      rec.state = "running"; rec.startedAt = this.#now();
      this.#records.append(run, { type: "started", key, agentId: rec.id, label, phase });
      this.#writeAgentMeta(run, rec, opts);
      this.#changed(run, { kind: "agent", agent: rec });
      const value = await this.#runAgent(run, rec, prompt, opts, control.signal);
      if (value === null) return null;
      this.#records.append(run, { type: "result", key, agentId: rec.id, result: value });
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

  #writeAgentMeta(run: Run, rec: AgentRecord, opts: AgentOptions) {
    try {
      writeAtomic(path.join(run.dir, `agent-${rec.id}.meta.json`), JSON.stringify({ agentType: opts.agentType ?? "workflow-agent", description: rec.label, workflowPhase: rec.phase,
        group: rec.group, model: opts.model ?? run.model ?? null, effort: opts.effort ?? run.effort ?? null, isolation: opts.isolation ?? null, threadId: rec.threadId }));
    } catch {}
  }

  #acquire(runId: string) {
    this.#drain();
    if (!this.#slots.queue.length && this.#slots.running < this.#slots.limit()) { this.#slots.running++; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => this.#slots.queue.push({ runId, resolve, reject }));
  }
  #drain() {
    while (this.#slots.queue.length && this.#slots.running < this.#slots.limit()) {
      this.#slots.running++; (this.#slots.queue.shift() as { resolve: () => void }).resolve();
    }
  }
  #release() {
    this.#slots.running--; this.#drain();
  }

  // One agent: retried with backoff until its attempts run out; null after that.
  async #runAgent(run: Run, rec: AgentRecord, prompt: string, opts: AgentOptions, signal: AbortSignal) {
    let cwd = run.cwd;
    if (opts.isolation === "worktree") ({ top: rec.worktree, branch: rec.worktreeBranch, cwd } = await this.#worktree(run, rec));
    let value: unknown = null;
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
          rec.error = String((e as { message?: unknown } | null)?.message ?? e).slice(0, 500);
          if ((e as { terminal?: boolean } | null)?.terminal || attempt >= this.#retry.attempts) {
            rec.state = "failed"; rec.endedAt = this.#now();
            this.#log(`workflow ${run.id} agent ${rec.id} failed: ${rec.error}`);
            this.#changed(run, { kind: "agent", agent: rec });
            return null;
          }
          if ((e as { threadGone?: boolean } | null)?.threadGone) rec.threadId = null;
          rec.state = "retrying";
          this.#changed(run, { kind: "agent", agent: rec });
          await pause(this.#retry.delays[Math.min(attempt - 1, this.#retry.delays.length - 1)] as number, signal);
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
  #frame(run: Run, prompt: string, opts: AgentOptions) {
    const lines = [`You are an agent in the workflow "${run.name}". Your final message is returned to the workflow's script as data, not shown to a person: give the result itself.`];
    if (opts.isolation === "worktree") lines.push("You work in your own git worktree; commit nothing unless the task says so.");
    if (opts.schema) lines.push(`Answer with only a JSON object that matches this JSON Schema:\n${JSON.stringify(opts.schema)}`);
    return `${lines.join("\n")}\n\n${prompt}`;
  }

  // A structured answer is validated; a mismatch asks again in the same chat, and is final after its tries.
  async #ask(run: Run, rec: AgentRecord, text: string, schema: Schema | undefined, signal: AbortSignal) {
    for (let i = 1; ; i++) {
      const r = await this.#executor.turn({ threadId: rec.threadId as string, text, outputSchema: schema ? strictSchema(schema) : null, signal });
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

  #spend(run: Run, tokens: number) {
    if (!tokens) return;
    run.spent = (run.spent ?? 0) + tokens;
    const live = this.#processes.live.get(run.id);
    if (live) Atomics.store(new BigInt64Array(live.spent), 0, BigInt(run.spent));
  }

  // The reference's isolation: a fresh worktree on its own branch per agent, removed with the branch when the agent
  // changed nothing, kept with it otherwise. Where it started is saved beside it, so an agent resumed after a restart
  // keeps its worktree, and one that committed before the restart is not taken for unchanged.
  async #worktree(run: Run, rec: AgentRecord) {
    let repo;
    try { repo = await git(run.cwd, ["rev-parse", "--show-toplevel"]); }
    catch { throw Object.assign(new Error("isolation: 'worktree' needs the run's folder to be in a git repository"), { terminal: true }); }
    const top = path.join(run.dir, "worktrees", rec.id), file = `${top}.json`;
    let made = readJson<{ repo: string; branch: string; base: string }>(file);
    if (!made || !fs.existsSync(top)) {
      made ??= { repo, branch: `elpis-workflow/${run.id.slice(3, 11)}/${rec.id}`, base: await git(repo, ["rev-parse", "HEAD"]) };
      fs.mkdirSync(path.dirname(top), { recursive: true });
      writeAtomic(file, JSON.stringify(made));
      const exists = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${made.branch}`]).then(() => true, () => false);
      await git(repo, ["worktree", "add", ...(exists ? [top, made.branch] : ["-b", made.branch, top, made.base])]);
    }
    return { top, branch: made.branch, cwd: path.join(top, path.relative(repo, run.cwd)) };
  }

  async #dropWorktree(run: Run, rec: AgentRecord) {
    const file = `${rec.worktree}.json`;
    try {
      const made = readJson<{ repo: string; branch: string; base: string }>(file);
      const dirty = await git(rec.worktree as string, ["status", "--porcelain"]);
      const head = await git(rec.worktree as string, ["rev-parse", "HEAD"]);
      if (made && !dirty && head === made.base) {
        await git(made.repo, ["worktree", "remove", "--force", rec.worktree as string]);
        await git(made.repo, ["branch", "-D", made.branch]);
        fs.rmSync(file, { force: true });
        return null;
      }
      this.#note(run, `${rec.label}: changes kept in worktree ${rec.worktree} on branch ${rec.worktreeBranch}`);
      return rec.worktree;
    } catch (e) { this.#log(`workflow ${run.id}: worktree cleanup: ${(e as Error).message}`); return rec.worktree; }
  }

  #note(run: Run, message: string, group: string | null = null) {
    const line = { at: this.#now(), message, ...(group && { group }) };
    run.logs.push(line);
    if (run.logs.length > LOG_LINES) run.logs.splice(0, run.logs.length - LOG_LINES);
    this.#changed(run, { kind: "log", log: line });
  }
}
