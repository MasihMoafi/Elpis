import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, text } from './client.mts';
import { loveNodeSpec } from './love-agents.mjs';
import { runAcpNode, handoffText } from './acp-nodes.mts';
import { workflowRoute, quotaFailure, type workflowModelRoutes, type workflowDefaults } from './workflow-models.mts';
import { checkPlan } from './canvas-plan.mts';
import { agentParentId } from '../lib/agent-runs.mts';
import { workflowWorktrees, mergeWorkflowReview, checkWorkflowReview, workflowCandidateChanged, removeWorkflowWorkspace } from './workflow-worktrees.mts';
import { workerBudget } from './memory-budget.mts';

const ended = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);
type WorkflowTask = { id: string; kind: string; dependsOn: string[]; feedbackFrom?: string[]; writeScopes: string[]; unchecked?: boolean; status?: string; cancelledBy?: string };
type ProgressEntry = { kind: 'thinking' | 'text'; messageId?: string | null | undefined; text: string; at: number; title?: never } | { kind: 'tool'; id?: string | undefined; at?: number; title?: string; status?: string; text?: never; messageId?: never };
type ProgressUpdate = { sessionUpdate?: string; messageId?: string | null | undefined; content?: { type?: string; text: string }; toolCallId?: string; title?: string; status?: string };
type HistoryRun = { id: string; status: string; next?: { status: string }; tasks?: { status: string }[]; mother?: { status?: string }; review?: { status: string } };
type RouteAttempt = { model: string; provider: string; runsOn?: string; status: string; startedAt: number; endedAt?: number; reason?: string };
type SteerMessage = { id: string; text: string; status: string; at: number; round: number; delivery?: string; error?: string };
type TaskResult = { summary: string; file?: string; candidateCommit?: string; reviewedCommit?: string };
type StoredTask = WorkflowTask & {
  title: string; instruction: string; acceptanceCriteria: string[]; status: string;
  model?: string; provider?: string; reasoningEffort?: string; serviceTier?: string;
  assignedThreadId?: string | null; sessionId?: string | null; threads?: string[];
  result?: TaskResult | null; failureReason?: string | null; progress?: ProgressEntry[];
  permissions?: { at: number; round: number; sessionId?: string | undefined; toolCallId?: string | undefined; title: string; optionId: string | null }[];
  messages?: (SteerMessage & { source?: string })[]; manualRevision?: number;
  cwd?: string; worktree?: ReturnType<Awaited<ReturnType<typeof workflowWorktrees>>['paths']>[number] | undefined;
  parts?: string[]; output?: string; flow?: boolean; fixed?: boolean; scopeFixed?: boolean;
  supervisedRound?: number; supervisorInstruction?: string;
  activeReview?: { status: string };
  routing?: { requested: { model: string; provider: string }; actual: { model: string; provider: string } | null; attempts: RouteAttempt[] };
};
type ReadyReview = Parameters<typeof checkWorkflowReview>[0] & { status: string; stat?: string; error?: string | undefined };
type WorkflowReview = (Awaited<ReturnType<Awaited<ReturnType<typeof workflowWorktrees>>['review']>> | ReadyReview) & { error?: string | undefined };
type Mother = Partial<StoredTask> & { id: string; title: string; decisions: (Record<string, unknown> & { status?: string; kind?: string; reasons?: string })[]; replans?: number; replanLimitNoted?: boolean };
type WorkflowRecord = {
  id: string; rootThreadId: string; name: string; status: string; ownerPid: number; startedAt: number; createdAt?: number; round: number; tasks: StoredTask[];
  goal?: string; roundLimit?: number; maxConcurrency?: number; maxRuntimeSeconds?: number; runLimitSeconds?: number;
  isolation?: string; runsOn?: string; replan?: boolean; autoMerge?: boolean; projectCwd?: string;
  defaults?: ReturnType<typeof workflowDefaults>; motherModel?: { model: string; provider: string; reasoningEffort?: string };
  mother?: Mother; review?: WorkflowReview; next?: { status: string; threadId?: string; tasks?: StoredTask[]; [key: string]: unknown };
  worktreeBase?: string; worktrees?: ReturnType<Awaited<ReturnType<typeof workflowWorktrees>>['paths']>;
  cleanup?: { status: string; at: number; error?: string }; recovery?: { model: string; provider?: string; at: number };
  endedAt?: number; resumedAt?: number; error?: string | null | undefined; persistenceError?: string; log?: { at: number; text: string }[];
};
type WorkflowParams = Omit<WorkflowRecord, 'id' | 'status' | 'ownerPid' | 'startedAt' | 'round' | 'tasks'> & { tasks: Omit<StoredTask, 'status'>[] };
type StartedRun = { graphId: string; threadId: string; turnId: string };
type AcpOptions = NonNullable<Parameters<typeof runAcpNode>[2]>;
type AcpControl = Parameters<NonNullable<AcpOptions['onControl']>>[0];
type NodeInput = { task: string; inputs?: { name: string; answer: string; file?: string }[] };
type NodeOptions = AcpOptions & { lowEffort?: boolean };
type RequestedRoute = { model: string; provider: string };
type Root = { cwd: string; model?: string; modelProvider?: string };
type PermissionRequest = { sessionId?: string; toolCall?: { toolCallId?: string; title?: string }; options?: { kind: string; optionId: string; name?: string }[] };
type CheckpointContext = { record: object; task: object; reason?: string; timer: ReturnType<typeof setTimeout>; controller: AbortController; queued: boolean; checkpoint: { status: string; reason?: string }; unlink: () => void };
type ModelRoute = ReturnType<typeof workflowModelRoutes>[number];
type WorkflowOptions = {
  stateDir: string;
  nodeSpec?: (node: { name: string; prompt: string; model: string; provider: string }, env: NodeJS.ProcessEnv) => Parameters<typeof runAcpNode>[0];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onSession?: (record: unknown, owner: unknown, id: string) => void | (() => void);
  onEnd?: (record: unknown) => unknown;
  modelRoutes?: () => ModelRoute[] | Promise<ModelRoute[]>;
  modelDefaults?: () => ReturnType<typeof workflowDefaults> | Promise<ReturnType<typeof workflowDefaults>>;
  observeThread?: (id: string) => Promise<{ status?: { type?: string } | null } | null>;
  listThreadDescendants?: (options: { ancestorThreadId: string; limit: number; cursor?: string }) => Promise<{ data?: { id: string; parentThreadId?: string | null; source?: unknown }[]; nextCursor?: string | null }>;
  budget?: typeof workerBudget;
  cloudroom?: { ready: () => unknown; runAgent: (options: { localDir: string | undefined; key: string; provider: string; model: string; effort: string | undefined; prompt: string; signal: AbortSignal | undefined; timeoutMs: number | undefined; onStatus: (text: string) => void }) => Promise<{ answer: string; changed: number; deleted: number }> };
};

const writer = (task: WorkflowTask) => ['implement', 'fix'].includes(task.kind);
/** Done for the run: it succeeded, or the Mother cancelled it as no longer needed (its dependents go on without it). */
const settled = (task: WorkflowTask) => task.status === 'succeeded' || task.status === 'cancelled' && task.cancelledBy === 'mother';
/** The Mother re-plans at most this many times a run, and adds at most this many agents in one decision (1 Nov). */
export const REPLAN_LIMIT = 5, ADD_LIMIT = 4;
/** Inline and spill (1 Nov): a later agent and the Mother get a child's summary and the file with its whole answer. */
const SUMMARY = 1500;
export const summarize = (answer: unknown) => String((answer ?? '') as string).length <= SUMMARY ? String((answer ?? '') as string) : `${String(answer).slice(0, SUMMARY).replace(/\s+\S*$/, '')} … (the whole answer is in the file)`;
const slug = (text: unknown) => String(text).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
const alive = (pid: number) => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

async function acquireLock(lock: string) {
  try {
    const handle = await fs.open(lock, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(await fs.readFile(lock, 'utf8'));
    if (alive(pid)) throw new BridgeError('A workflow is already running in this conversation', 409);
    await fs.unlink(lock); return false;
  }
}

/** History visibility. Run files, chats and execution are never changed here; Undo survives an app restart. The client
 * then frees the removed run's worktrees (`free` below), so Undo brings back the record only. */
export function createWorkflowHistory(file: string) {
  let removed: string[] = [], loading: Promise<void> | null = null, changing: Promise<unknown> = Promise.resolve();
  const terminal = new Set([...ended, 'completed', 'stopped']);
  const finished = (run: HistoryRun) => terminal.has(run.status)
    && (!run.next || terminal.has(run.next.status))
    && !run.tasks?.some(task => task.status === 'running')
    && !['running', 'reviewing'].some(status => status === run.mother?.status) && run.review?.status !== 'reviewing';
  const load = () => loading ??= fs.readFile(file, 'utf8').then(raw => {
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Array.isArray(saved.removed) || saved.removed.some((id: unknown) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) throw Error('Invalid workflow history');
    removed = [...new Set<string>(saved.removed)];
  }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { removed = []; return; }
    loading = null; throw new BridgeError('Could not read workflow history. Nothing was removed.', 503);
  });
  const change = <T extends object>(action: (next: string[]) => T | Promise<T>) => {
    const pending = changing.catch(() => {}).then(async () => {
      await load();
      const next = [...removed], result = await action(next);
      const temp = `${file}.${process.pid}.tmp`;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(temp, JSON.stringify({ version: 1, removed: next }), { mode: 0o600 });
        await fs.rename(temp, file);
      } catch {
        await fs.unlink(temp).catch(() => {});
        throw new BridgeError('Could not save workflow history. Nothing was removed or restored.', 503);
      }
      removed = next;
      return { ...result, canUndo: removed.length > 0 };
    });
    changing = pending; return pending;
  };
  return {
    async list<T extends HistoryRun>(runs: T[]) {
      await changing.catch(() => {}); await load();
      return { data: runs.filter(run => !removed.includes(run.id) || !finished(run)).map(run => ({ ...run, removable: finished(run),
        ...(!finished(run) ? { removalReason: 'Finish this workflow before removing it from history.' } : {}) })), canUndo: removed.length > 0 };
    },
    remove(id: string, readRuns: () => Promise<HistoryRun[]>) {
      return change(async next => {
        const runs = await readRuns();
        const run = runs.find(run => run.id === id);
        if (!run) throw new BridgeError('Workflow not found', 404);
        if (!finished(run)) throw new BridgeError('Finish this workflow before removing it from history. Running work stays visible.', 409);
        if (!next.includes(id)) next.push(id);
        return { removed: id };
      });
    },
    undo() { return change(next => ({ restored: next.pop() ?? null })); },
  };
}

/** A write scope as a folder inside `base`, made when missing (each agent's own folder is new on its first run). The
 * nearest folder that exists must already be inside `base`, so a link out of the project creates nothing. */
async function projectFolder(base: string, scope: string) {
  const refused = () => new BridgeError('Write scopes must be project folders');
  if (typeof scope !== 'string' || path.isAbsolute(scope) || scope.split(/[\\/]/).includes('..')) throw refused();
  const real = await fs.realpath(base), target = path.join(real, scope), inside = (at: string) => at === real || at.startsWith(`${real}${path.sep}`);
  let existing = target;
  for (;;) {
    try { existing = await fs.realpath(existing); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; existing = path.dirname(existing); }
  }
  if (!inside(existing)) throw refused();
  await fs.mkdir(target, { recursive: true });
  const resolved = await fs.realpath(target);
  if (!inside(resolved) || !(await fs.stat(resolved)).isDirectory()) throw refused();
  return resolved;
}

/** Validate the complete graph before starting any ACP process. Feedback is from a previous bounded round. */
export function validateWorkflow(tasks: WorkflowTask[], roundLimit?: number) {
  const ids = new Set(tasks.map(t => t.id));
  if (ids.size !== tasks.length || tasks.some(t => !/^[A-Za-z0-9_-]{1,100}$/.test(t.id))) throw new BridgeError('Task IDs must be unique letters, digits, hyphens or underscores');
  if (roundLimit !== undefined && (!Number.isSafeInteger(roundLimit) || roundLimit < 1 || roundLimit > 100)) throw new BridgeError('Choose a round limit from 1 to 100');
  for (const task of tasks) {
    if ([...task.dependsOn, ...(task.feedbackFrom ?? [])].some(id => !ids.has(id))) throw new BridgeError('A task dependency is missing');
    if (task.feedbackFrom?.length && roundLimit === undefined) throw new BridgeError('Recursive feedback needs an explicit round limit');
    // `unchecked`: the person judges the result (29 Oct, Logo: one agent and its image tool, no check agent).
    if (writer(task) && (!task.writeScopes.length || task.unchecked !== true && !tasks.some(check => check.kind === 'verify' && check.dependsOn.includes(task.id)))) throw new BridgeError('Every writer needs folders and a directly dependent check');
  }
  const done = new Set();
  while (done.size < tasks.length) {
    const next = tasks.filter(t => !done.has(t.id) && t.dependsOn.every(id => done.has(id)));
    if (!next.length) throw new BridgeError('The workflow has a loop. Use previous-round feedback with a round limit.');
    next.forEach(t => done.add(t.id));
  }
}

/** ACP owns node execution. This scheduler owns Kahn dependencies, bounded rounds, concurrency and failure state. */
/** `onEnd(record)` hears each run's final record once it is saved: the bridge starts a run's next stage from it. */
export function createWorkflowRuns({ stateDir, nodeSpec = loveNodeSpec, env = process.env, timeoutMs,
  onSession, onEnd, modelRoutes, modelDefaults, observeThread, listThreadDescendants, budget = workerBudget, cloudroom }: WorkflowOptions = {} as WorkflowOptions) {
  const records = new Map<string, WorkflowRecord>(), active = new Map<string, AbortController>();
  const controls = new Map<string, AcpControl>(), progressTimers = new Map<string, ReturnType<typeof setTimeout>>(), supervision = new Map<string, Promise<unknown>>(), routeSnapshots = new Map<string, Promise<ModelRoute[]>>(), exhaustedProviders = new Map<string, Set<string>>();
  const mergingSources = new Set<string>(), mergeControllers = new Map<string, AbortController>(), checkpoints = new Map<string, CheckpointContext>();
  const lowEffort = (route: { efforts?: string[] | undefined }) => ['low', 'minimal', 'none'].find(effort => route.efforts?.includes(effort));
  let loaded: Promise<void> | undefined;
  const load = () => loaded ??= (async () => {
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(stateDir)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const record = JSON.parse(await fs.readFile(path.join(stateDir, name), 'utf8')) as WorkflowRecord;
      if (record.status === 'running' && !alive(record.ownerPid)) {
        record.status = 'cancelled'; record.error = 'The desktop stopped before this ACP run finished.';
        record.tasks.forEach(t => {
          if (!ended.has(t.status)) t.status = 'cancelled';
          if (['queued', 'reviewing'].includes(t.activeReview?.status as string)) t.activeReview!.status = 'expired';
        });
        for (const decision of record.mother?.decisions ?? []) if (decision.kind === 'checkpoint' && ['queued', 'reviewing'].includes(decision.status as string)) {
          decision.status = 'not_delivered'; decision.reasons = 'The desktop stopped before Mother agent’s guidance could be delivered.';
        }
      }
      if (ended.has(record.status) && !alive(record.ownerPid) && ['running', 'reviewing'].includes(record.mother?.status as string)) {
        record.mother!.status = 'cancelled';
      }
      records.set(record.id, record);
    }
  })();
  let saving = Promise.resolve();
  const save = (record: { id: string }) => {
    const snapshot = JSON.stringify(record);
    const pending = saving.catch(() => {}).then(async () => {
      const file = path.join(stateDir, `${record.id}.json`), temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, snapshot, { mode: 0o600 }); await fs.rename(temp, file);
    });
    saving = pending; return pending;
  };
  /** A run's worktrees and branches end with it: once its work reached the project, or when it leaves History. A Git
   * failure never fails the run or the History action; it is kept on the record and the next `free` retries it. */
  const freeRun = async (record: WorkflowRecord) => {
    if (!record.isolation && !record.worktrees) return;
    try { await removeWorkflowWorkspace(record as Parameters<typeof removeWorkflowWorkspace>[0]); record.cleanup = { status: 'done', at: Date.now() }; }
    catch (error) { record.cleanup = { status: 'failed', at: Date.now(), error: (error as Error).message }; }
  };
  const gone = 'This run left History and its worktrees were removed, so it cannot resume. Start the workflow again.';
  const logLine = (record: { id: string; log?: { at: number; text: string }[]; persistenceError?: string }, text: string) => { (record.log ??= []).push({ at: Date.now(), text }); void save(record).catch(error => { record.persistenceError = (error as Error).message; }); };
  const progress = (record: { id: string; persistenceError?: string }, task: { progress?: ProgressEntry[] }, update: ProgressUpdate) => {
    const entries = task.progress ??= [], at = Date.now();
    if ((update?.sessionUpdate === 'agent_message_chunk' || update?.sessionUpdate === 'agent_thought_chunk') && update.content?.type === 'text') {
      const last = entries.at(-1), kind = update.sessionUpdate === 'agent_thought_chunk' ? 'thinking' : 'text';
      if (last?.kind === kind && last.messageId === update.messageId) { last.text = (last.text + update.content.text).slice(-8000); last.at = at; }
      else entries.push({ kind, messageId: update.messageId, text: update.content.text.slice(-8000), at });
    } else if ((update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update')) {
      let entry = entries.find(row => row.kind === 'tool' && row.id === update.toolCallId);
      if (!entry) entries.push(entry = { kind: 'tool', id: update.toolCallId });
      Object.assign(entry, { at, ...(update.title ? { title: String(update.title).slice(0, 1000) } : {}), ...(update.status ? { status: update.status } : {}) });
    } else return;
    let size = entries.reduce((total, entry) => total + (entry.text?.length ?? 0) + (entry.title?.length ?? 0), 0);
    while (entries.length > 1 && (entries.length > 80 || size > 32000)) { const removed = entries.shift()!; size -= (removed.text?.length ?? 0) + (removed.title?.length ?? 0); }
    if (!progressTimers.has(record.id)) progressTimers.set(record.id, setTimeout(() => {
      progressTimers.delete(record.id); void save(record).catch(error => { record.persistenceError = (error as Error).message; });
    }, 200));
  };
  const permission = async (record: { id: string; round: number }, task: { title: string; progress?: ProgressEntry[]; permissions?: { at: number; round: number; sessionId?: string | undefined; toolCallId?: string | undefined; title: string; optionId: string | null }[] }, request: PermissionRequest) => {
    const options = request.options ?? [];
    const option = options.find(option => option.kind === 'allow_once') ?? options.find(option => option.kind === 'allow_always');
    const entry = { at: Date.now(), round: record.round, sessionId: request.sessionId, toolCallId: request.toolCall?.toolCallId, title: String(request.toolCall?.title || task.title).slice(0, 1000), optionId: option?.optionId ?? null };
    const log = task.permissions ??= []; log.push(entry); if (log.length > 100) log.shift();
    progress(record, task, { sessionUpdate: 'agent_message_chunk', messageId: `permission-${randomUUID()}`, content: { type: 'text', text: `${option ? 'Allowed' : 'Refused'} automatically: ${entry.title}${option ? ` (${option.name || option.optionId})` : ' (no allow option offered)'}` } });
    await save(record); return entry.optionId;
  };
  const fullAccess = (spec: Parameters<typeof runAcpNode>[0]) => {
    // Keep the provider's checks active; the permission callback answers automatic agents.
    if (!spec.elpis && !spec.instructionsInPrompt) spec.mode = 'default';
    return spec;
  };
  async function routesFor(record: WorkflowRecord) {
    if (!modelRoutes) return [];
    if (!routeSnapshots.has(record.id)) routeSnapshots.set(record.id, Promise.resolve().then(() => modelRoutes()).catch(() => []));
    return routeSnapshots.get(record.id)!;
  }
  async function runNode(record: WorkflowRecord, owner: StoredTask | Mother, requested: RequestedRoute, instructions: string, input: NodeInput, options: NodeOptions) {
    const available = await routesFor(record), routes = options.lowEffort ? available.filter(lowEffort) : available, requestedRoute = workflowRoute(requested.model, requested.provider);
    const desired = { ...routes.find(route => route.provider === requestedRoute.provider), ...routes.find(route => route.model === requestedRoute.model && route.provider === requestedRoute.provider), ...requestedRoute };
    const candidates = [desired, ...routes.filter(route => route.provider !== desired.provider)], seen = new Set();
    const unavailable = exhaustedProviders.get(record.id) ?? new Set(); exhaustedProviders.set(record.id, unavailable);
    const routing = owner.routing ??= { requested: requestedRoute, actual: null, attempts: [] };
    let previousError: unknown;
    for (const route of candidates) {
      if (seen.has(route.provider)) continue; seen.add(route.provider);
      const attempt: RouteAttempt = { model: route.model, provider: route.provider, status: 'running', startedAt: Date.now() };
      routing.attempts.push(attempt);
      if (route.exhausted || unavailable.has(route.provider)) {
        attempt.status = 'skipped'; attempt.reason = route.reason || 'This subscription reached its usage limit'; attempt.endedAt = Date.now();
        progress(record, owner, { sessionUpdate: 'agent_message_chunk', messageId: `route-${randomUUID()}`, content: { type: 'text', text: `Skipped ${route.model || route.provider}: ${attempt.reason}` } });
        continue;
      }
      routing.actual = { model: route.model, provider: route.provider };
      if (route.model !== requestedRoute.model || route.provider !== requestedRoute.provider) {
        attempt.reason = (previousError as { message?: string } | undefined)?.message || 'The requested subscription is unavailable';
        progress(record, owner, { sessionUpdate: 'agent_message_chunk', messageId: `route-${randomUUID()}`, content: { type: 'text', text: `Continuing with ${route.model} (${route.provider}). ${attempt.reason}` } });
      }
      await save(record);
      let sessionEnded: (() => void) | undefined; // what onSession returned, called once this attempt's ACP agent has left
      try {
        const recovery = previousError ? '\n\nA previous attempt reached its subscription limit. Continue in this same workspace. Inspect existing files before acting; preserve completed work and do not repeat actions already evidenced there. Previous progress:\n' + (owner.progress ?? []).filter(entry => entry.kind === 'text').slice(-3).map(entry => entry.text).join('\n').slice(-3000) : '';
        const spec = fullAccess(nodeSpec({ name: owner.title, prompt: instructions, model: route.model, provider: route.provider }, env));
        const effort = options.lowEffort ? lowEffort(route) : owner.reasoningEffort && Array.isArray(route.efforts) && !route.efforts.includes(owner.reasoningEffort) ? route.defaultEffort : owner.reasoningEffort;
        if (effort) spec.reasoningEffort = effort;
        spec.meta = { ...spec.meta, elpis: { ...spec.meta?.elpis, name: `Workflows · ${owner.title}`, workflow: { kind: owner.kind ?? 'verify', writeScopes: owner.writeScopes ?? [], ...(effort ? { reasoningEffort: effort } : {}), ...(owner.serviceTier ? { serviceTier: owner.serviceTier } : {}) } } };
        const result = await runAcpNode(spec, { ...input, task: input.task + recovery }, { ...options,
          // Every chat a step or Mother opens is kept, not only the latest (28 Oct: earlier review and retry chats fell out of
          // their workflow and lay loose in the sidebar: "currently they are all merged").
          onSession: id => { owner.assignedThreadId = spec.elpis ? id : null; owner.sessionId = id; if (spec.elpis) owner.threads = [...new Set([...(owner.threads ?? []), id])]; sessionEnded = onSession?.(record, owner, id) as (() => void) | undefined; void save(record).catch(() => {}); } });
        attempt.status = 'succeeded'; attempt.endedAt = Date.now(); return result;
      } catch (error) {
        attempt.status = 'failed'; attempt.reason = (error as Error).message; attempt.endedAt = Date.now();
        if (options.signal?.aborted || !quotaFailure(error)) throw error;
        unavailable.add(route.provider); previousError = error; await save(record);
      } finally { sessionEnded?.(); }
    }
    throw (previousError ?? new BridgeError('No connected subscription has available quota. Choose another connected model and resume this workflow; completed work is preserved.', 409)) as Error;
  }
  /** "Runs on: CloudRoom VM" (1 Nov, Masih: "I asked if we can use cloud room's vms for our agents"): the agent's worktree
   * is copied to his CloudRoom VM, the CLI its provider needs (Claude Code or Codex) runs there, and its changes come back
   * into the worktree. The Mother's review and merge stay on this computer. Answers the same shape as runAcpNode. */
  async function runOnCloudroom(record: WorkflowRecord, owner: StoredTask | Mother, requested: RequestedRoute, instructions: string, input: NodeInput, options: NodeOptions) {
    const route = workflowRoute(requested.model, requested.provider);
    const attempt: RouteAttempt = { model: route.model, provider: route.provider, runsOn: 'cloudroom', status: 'running', startedAt: Date.now() };
    const routing = owner.routing ??= { requested: route, actual: null, attempts: [] };
    routing.actual = { model: route.model, provider: route.provider }; routing.attempts.push(attempt); await save(record);
    const say = (text: string) => progress(record, owner, { sessionUpdate: 'agent_message_chunk', messageId: `cloudroom-${randomUUID()}`, content: { type: 'text', text } });
    // A connected agent's whole answer is in a file on this computer, which the VM cannot read: it gets the summary.
    const prompt = handoffText(input.task, (input.inputs ?? []).map(({ name, answer }) => ({ name, answer })), instructions);
    try {
      const result = await cloudroom!.runAgent({ localDir: options.cwd, key: `${record.id}-${owner.id}-r${record.round}`, provider: route.provider, model: route.model,
        effort: owner.reasoningEffort, prompt, signal: options.signal, timeoutMs: options.timeoutMs, onStatus: say });
      say(`CloudRoom VM: ${result.changed} changed and ${result.deleted} deleted ${result.changed + result.deleted === 1 ? 'file' : 'files'} copied back.`);
      attempt.status = 'succeeded'; attempt.endedAt = Date.now(); return { answer: result.answer };
    } catch (error) { attempt.status = 'failed'; attempt.reason = (error as Error).message; attempt.endedAt = Date.now(); throw error; }
  }
  /** The Mother's model: one he chose for her on the board, else the default (workflow-models.mts MOTHER_ROUTE), else
   * `fallback` (her chat's model, as before the defaults). */
  const motherRoute = (record: WorkflowRecord, fallback: RequestedRoute) => record.motherModel ?? record.defaults?.mother ?? fallback;
  const motherOf = (record: WorkflowRecord, route: RequestedRoute & { reasoningEffort?: string }) => {
    const mother = record.mother ??= { id: 'mother', title: 'Mother agent', progress: [], decisions: [] };
    mother.decisions ??= []; mother.progress ??= [];
    return Object.assign(mother, { model: route.model, provider: route.provider ?? '', reasoningEffort: route.reasoningEffort ?? 'low' });
  };
  /** One Mother turn. When her default model fails, she continues once on the default fallback (Opus at medium). */
  async function askMother(record: WorkflowRecord, route: RequestedRoute & { reasoningEffort?: string }, instructions: string, input: NodeInput, options: NodeOptions) {
    const mother = motherOf(record, route);
    try { return await runNode(record, mother, { model: route.model, provider: route.provider }, instructions, input, options); }
    catch (error) {
      const fallback = record.defaults?.motherFallback;
      if (options.signal?.aborted || !fallback || record.motherModel || route.model !== record.defaults?.mother?.model || fallback.model === route.model) throw error;
      motherOf(record, fallback);
      progress(record, mother, { sessionUpdate: 'agent_message_chunk', messageId: `route-${randomUUID()}`, content: { type: 'text', text: `Continuing with ${fallback.model} (${fallback.provider}). ${(error as Error).message}` } });
      return runNode(record, mother, { model: fallback.model, provider: fallback.provider }, instructions, input, options);
    }
  }
  /** Writes a child's whole answer to the run's folder and returns what later agents get: its summary and that file. */
  async function spill(record: { id: string }, task: { id: string }, round: number, answer: string) {
    try {
      const dir = path.join(stateDir, 'outputs', record.id), file = path.join(dir, `${task.id}${round > 1 ? `-round-${round}` : ''}.md`);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.writeFile(file, answer, { mode: 0o600 });
      return { answer: summarize(answer), file };
    } catch { return { answer }; }
  }
  const handed = (task: { result?: TaskResult | null }) => ({ answer: summarize(task.result?.summary), ...(task.result?.file ? { file: task.result.file } : {}) });
  function queueSupervision<T>(record: { id: string }, work: () => Promise<T>) {
    const pending = (supervision.get(record.id) ?? Promise.resolve()).catch(() => {}).then(work);
    supervision.set(record.id, pending); return pending;
  }
  function cancelCheckpoints(record: object, task: object | null, reason: string) {
    for (const [key, context] of checkpoints) {
      if (context.record !== record || task && context.task !== task) continue;
      context.reason = reason; clearTimeout(context.timer); context.controller.abort();
      if (!context.queued) {
        context.checkpoint.status = 'expired'; context.checkpoint.reason = reason;
        context.unlink(); checkpoints.delete(key);
      }
    }
  }
  async function finishCheckpoints(record: { id: string }, reason: string) {
    cancelCheckpoints(record, null, reason);
    await supervision.get(record.id)?.catch(() => {});
  }
  // Mother reviews a step only when it fails (supervise, below); she no longer looks in during every run, which spent the
  // person's Claude quota on Opus for every step (28 Oct, Masih: no check-ins).
  function supervise(record: WorkflowRecord, task: StoredTask, error: unknown, root: Root, controller: AbortController) {
    cancelCheckpoints(record, null, 'A failed node needs Mother agent’s recovery decision first.');
    return queueSupervision(record, () => superviseNode(record, task, error, root, controller));
  }
  async function superviseNode(record: WorkflowRecord, task: StoredTask, error: unknown, root: Root, controller: AbortController) {
    if (controller.signal.aborted || task.supervisedRound === record.round) return false;
    task.supervisedRound = record.round;
    // She runs on the model chosen for her chat (the run's root), not on a fixed Opus that spent his Claude subscription.
    const route = motherRoute(record, root.model ? { model: root.model, provider: root.modelProvider ?? '' } : { model: 'claude/opus', provider: 'claude' });
    const mother = motherOf(record, route); mother.status = 'running'; await save(record);
    try {
      const instructions = 'You are the Mother agent, the active workflow supervisor. Inspect the failed node and current evidence. Read only; do not edit files, run agents, merge, install or change permissions. Return only JSON: {"action":"retry","taskId":"the failed node","instruction":"specific corrective guidance","reason":"evidence"}, {"action":"steer","taskId":"one currently running node","message":"specific guidance","reason":"evidence"}, or {"action":"stop","reason":"actionable recovery needed"}. Retry only when specific new guidance can address the failure. Never repeat an unchanged failing tool, alter scope, or claim success without checks.';
      const result = await askMother(record, route, instructions, { task: `Workflow: ${record.name}. Goal: ${record.goal ?? ''}. Failed node: ${task.id}. Failure: ${(error as Error).message}.\nCurrent nodes:\n${JSON.stringify(record.tasks.map(node => ({ id: node.id, status: node.status, instruction: node.instruction, evidence: node.result ? handed(node) : undefined, failure: node.failureReason, recentProgress: node.progress?.slice(-3) }))).slice(0, 22000)}` }, {
        cwd: root.cwd, signal: controller.signal, timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
        onUpdate: update => progress(record, mother, update), onControl: control => controls.set(`${record.id}:mother`, control), onPermission: request => permission(record, mother, request),
      });
      let decision; try { decision = JSON.parse(result.answer.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new BridgeError('Mother agent could not give a valid recovery decision. Choose a model and resume the failed nodes.', 409); }
      if (!['retry', 'steer', 'stop'].includes(decision?.action) || typeof decision.reason !== 'string' || !decision.reason.trim()) throw new BridgeError('Mother agent did not give an actionable recovery decision. Choose a model and resume the failed nodes.', 409);
      const entry: { at: number; taskId: string; decision: string; reasons: string; delivery?: string } = { at: Date.now(), taskId: decision.taskId ?? task.id, decision: decision.action, reasons: decision.reason.slice(0, 2000) }; mother.decisions.push(entry);
      if (decision.action === 'retry') {
        if (decision.taskId !== task.id || typeof decision.instruction !== 'string' || !decision.instruction.trim() || decision.instruction.length > 4000) throw new BridgeError('Mother agent requested an invalid retry. Completed work was preserved.', 409);
        task.supervisorInstruction = decision.instruction.trim(); mother.status = 'succeeded'; await save(record); return true;
      }
      if (decision.action === 'steer') {
        const target = record.tasks.find(node => node.id === decision.taskId && node.id !== task.id && node.status === 'running'), control = target && controls.get(`${record.id}:${target.id}`);
        if (!control || typeof decision.message !== 'string' || !decision.message.trim() || decision.message.length > 4000) throw new BridgeError('Mother agent could not reach that running node. Resume the failed work after choosing a model.', 409);
        const delivered = await control.steer(decision.message.trim()); entry.delivery = delivered.delivery;
        (target.messages ??= []).push({ id: randomUUID(), text: decision.message.trim(), status: 'delivered', delivery: delivered.delivery, at: Date.now(), round: record.round, source: 'mother' });
      }
      mother.status = 'succeeded'; await save(record); return false;
    } catch (failure) {
      mother.status = controller.signal.aborted ? 'cancelled' : 'failed'; mother.failureReason = (failure as Error).message;
      mother.decisions.push({ at: Date.now(), taskId: task.id, decision: 'stop', reasons: (failure as Error).message }); await save(record); return false;
    } finally { controls.delete(`${record.id}:mother`); }
  }
  /** The Mother's re-plan after children succeeded (`finished`: their ids). She answers with one decision: continue, add
   * agents, cancel pending ones or steer a running one. Her answer passes the planner's checks (canvas-plan.mts) and the
   * graph's (validateWorkflow) before it changes anything; an invalid one is ignored and logged. */
  async function decide(record: WorkflowRecord, finished: string[], root: Root, controller: AbortController, byId: Map<string, StoredTask>) {
    if (!record.tasks.some(task => !ended.has(task.status))) return; // nothing left to run: plain code finishes the run
    const route = motherRoute(record, root.model ? { model: root.model, provider: root.modelProvider ?? '' } : { model: 'claude/opus', provider: 'claude' });
    const mother = motherOf(record, route);
    if ((mother.replans ?? 0) >= REPLAN_LIMIT) {
      if (!mother.replanLimitNoted) { mother.replanLimitNoted = true; logLine(record, `Mother agent reached her ${REPLAN_LIMIT} re-plans for this run; the plan stays as it is.`); }
      return;
    }
    mother.replans = (mother.replans ?? 0) + 1; mother.status = 'running'; await save(record);
    const title = (id: string) => byId.get(id)?.title ?? id;
    const note = (decision: string, line: string, extra = {}) => {
      mother.decisions.push({ at: Date.now(), kind: 'replan', decision, summary: line.slice(0, 300), ...extra });
      logLine(record, `Mother agent · ${line}`.slice(0, 400));
    };
    try {
      const done = record.tasks.filter(task => task.status === 'succeeded').map(task => ({ id: task.id, title: task.title, kind: task.kind, justFinished: finished.includes(task.id), ...handed(task) }));
      const left = record.tasks.filter(task => task.status !== 'succeeded').map(task => ({ id: task.id, title: task.title, kind: task.kind, status: task.status, dependsOn: task.dependsOn, folders: task.writeScopes, instruction: task.instruction.slice(0, 600) }));
      const folders = [...new Set(record.tasks.flatMap(task => task.writeScopes))];
      const instructions = `You are the Mother agent, the workflow coordinator. A child agent has just finished. Decide whether the remaining plan still reaches the goal. Read only: you may read the files listed; do not edit files, run agents, merge or install. Return only JSON, one of:
{"decision":"continue","why":"one short line"}
{"decision":"add","why":"one short line","agents":[{"key":"short-lowercase-key","title":"plain name","prompt":"what to do and where","folders":[],"doneWhen":["a check anyone can verify"],"waitsFor":["ids it builds on"]}]} (1 to ${ADD_LIMIT} agents; folders copied from the project folder list, or empty; each also gets its own folder)
{"decision":"cancel","why":"one short line","taskIds":["ids of pending agents"]}
{"decision":"steer","why":"one short line","taskId":"one running agent","message":"specific guidance"}
Prefer continue. Add only for a part the plan misses; cancel only work that is no longer needed; steer only with specific new guidance.`;
      const result = await askMother(record, route, instructions, { task: `Workflow: ${record.name}. Goal: ${record.goal ?? ''}.\nJust finished: ${finished.map(title).join(', ')}.\nFinished agents (summary and the file with the whole answer):\n${JSON.stringify(done).slice(0, 14000)}\nRemaining plan:\n${JSON.stringify(left).slice(0, 8000)}\nProject folders: ${JSON.stringify(folders)}` }, {
        cwd: root.cwd, signal: controller.signal, timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
        onUpdate: update => progress(record, mother, update), onControl: control => controls.set(`${record.id}:mother`, control), onPermission: request => permission(record, mother, request),
      }).finally(() => controls.delete(`${record.id}:mother`));
      let answer; try { answer = JSON.parse(result.answer.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new BridgeError('her answer was not JSON'); }
      const why = typeof answer?.why === 'string' ? answer.why.trim().slice(0, 300) : '';
      if (!why) throw new BridgeError('her answer gave no reason');
      if (answer.decision === 'continue') note('continue', `Continued — ${why}`);
      else if (answer.decision === 'add') {
        if (!Array.isArray(answer.agents) || !answer.agents.length || answer.agents.length > ADD_LIMIT) throw new BridgeError(`add needs 1 to ${ADD_LIMIT} agents`);
        // The run as a plan, with her agents added: the planner's own check of keys, folders, wiring and loops.
        const board = record.tasks.map(task => ({ key: task.id, title: task.title, prompt: '', folders: task.writeScopes, doneWhen: [], waitsFor: task.dependsOn }));
        let plan;
        try { plan = checkPlan(JSON.stringify({ name: record.name, mode: 'team', why, agents: [...board.map(agent => ({ ...agent, title: '' })), ...answer.agents] }), { folders, agents: board, maxAgents: board.length + ADD_LIMIT }); }
        catch (error) { throw new BridgeError((error as Error).message.replace(/^Elpis returned a plan that cannot be used: /, '')); }
        const known = new Set(record.tasks.map(task => task.id)), taken = new Set(record.tasks.flatMap(task => task.writeScopes));
        const fresh = plan.agents.filter(agent => !known.has(agent.key)), checks = new Set([...known, ...fresh.map(agent => `${agent.key}-check`)]);
        const added = fresh.flatMap(agent => {
          let own = `agents/${slug(agent.title) || agent.key}`;
          for (let n = 2; taken.has(own); n++) own = `agents/${slug(agent.title) || agent.key}-${n}`;
          taken.add(own);
          const criteria = agent.doneWhen.length ? agent.doneWhen : ['Its result is saved in its folder, with evidence'];
          const base = { status: 'pending', assignedThreadId: null, result: null, failureReason: null, addedBy: 'mother' };
          return [
            { ...base, id: agent.key, kind: 'implement', title: agent.title,
              instruction: [record.goal && `Goal of the whole run: ${record.goal}`, agent.prompt, `Save your result as files inside your allowed folders. Write your report to ${own}/report.md. Include the answer and file paths in your final answer so the next agent can use them.`].filter(Boolean).join('\n\n'),
              dependsOn: agent.waitsFor.flatMap(id => checks.has(`${id}-check`) && !agent.waitsFor.includes(`${id}-check`) ? [id, `${id}-check`] : [id]),
              writeScopes: [...agent.folders.filter(folder => folder !== own), own], acceptanceCriteria: criteria },
            { ...base, id: `${agent.key}-check`, kind: 'verify', title: `Check: ${agent.title}`.slice(0, 256),
              instruction: `Check the work of “${agent.title}”. Its prompt was:\n${agent.prompt}\n\nRead what it wrote and say plainly whether each of these holds: ${criteria.join('; ')}\n\nChange nothing of its work. Write your report to ${own}/check/report.md.`,
              dependsOn: [agent.key], writeScopes: [`${own}/check`], acceptanceCriteria: [`Each of “${agent.title}”'s criteria is shown to hold or not, with evidence`] },
          ];
        });
        if (!added.length) throw new BridgeError('add named no new agent');
        try { validateWorkflow([...record.tasks, ...added], record.roundLimit); } catch (error) { throw new BridgeError((error as Error).message); }
        record.tasks.push(...added); for (const task of added) byId.set(task.id, task);
        note('add', `Added: ${fresh.map(agent => agent.title).join(', ')} — ${why}`, { taskIds: fresh.map(agent => agent.key) });
      } else if (answer.decision === 'cancel') {
        const ids = Array.isArray(answer.taskIds) ? [...new Set<string>(answer.taskIds)] : [];
        const targets = ids.map(id => byId.get(id)!);
        if (!ids.length || targets.some(task => task?.status !== 'pending')) throw new BridgeError('cancel names only pending agents');
        // An agent's own check goes with it.
        const cancelled = [...targets, ...record.tasks.filter(task => task.kind === 'verify' && task.status === 'pending' && task.dependsOn.length && task.dependsOn.every(id => ids.includes(id)))];
        for (const task of new Set(cancelled)) Object.assign(task, { status: 'cancelled', cancelledBy: 'mother', failureReason: `Cancelled by Mother agent: ${why}` });
        note('cancel', `Cancelled: ${targets.map(task => task.title).join(', ')} — ${why}`, { taskIds: ids });
      } else if (answer.decision === 'steer') {
        const target = byId.get(answer.taskId), control = target?.status === 'running' && controls.get(`${record.id}:${target.id}`);
        const message = typeof answer.message === 'string' ? answer.message.trim() : '';
        if (!control || !message || message.length > 4000) throw new BridgeError('steer needs a running agent and a message');
        const delivered = await control.steer(message);
        (target.messages ??= []).push({ id: randomUUID(), text: message, status: 'delivered', delivery: delivered.delivery, at: Date.now(), round: record.round, source: 'mother' });
        note('steer', `Steered: ${target.title} — ${why}`, { taskId: target.id, delivery: delivered.delivery });
      } else throw new BridgeError('her answer was not one of continue, add, cancel or steer');
      mother.status = 'succeeded';
    } catch (error) {
      if (controller.signal.aborted) { mother.status = 'cancelled'; return; }
      mother.status = 'succeeded';
      note('invalid', `Ignored her answer — ${(error as Error).message}`.slice(0, 300));
    } finally { await save(record); }
  }
  async function reviewAndMerge(record: WorkflowRecord, signal: AbortSignal) {
    const ready = record as WorkflowRecord & { review: ReadyReview };
    if (await checkWorkflowReview(ready.review, signal)) { ready.review = await mergeWorkflowReview(ready.review, signal); return; }
    const route = record.recovery?.model ? { model: record.recovery.model, provider: record.recovery.provider as string } : motherRoute(record, { model: 'claude/opus', provider: 'claude' });
    const mother = motherOf(record, route); mother.status = 'running';
    ready.review.status = 'reviewing'; await save(record);
    try {
      const instructions = 'You are the Mother agent, the workflow coordinator. Review the children’s candidate commits and focused test evidence. Read and run checks only; do not change files, commit, merge, delegate or push. Approve only if the requested task is complete and the checks pass. Return only JSON: {"passed":true or false,"summary":"observed evidence and any remaining failure"}.';
      const result = await askMother(record, route, instructions, { task: `Review candidate commit ${ready.review.commit}. Workflow: ${record.name}.\n${record.goal ?? ''}\n\nChange summary:\n${ready.review.stat}`, inputs: record.tasks.map(task => ({ name: task.title, ...(task.result ? handed(task) : { answer: task.failureReason ?? task.status }) })) }, {
        cwd: ready.review.path, signal, timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
        onUpdate: update => progress(record, mother, update), onControl: control => controls.set(`${record.id}:mother`, control), onPermission: request => permission(record, mother, request),
      });
      let verdict;
      try { verdict = JSON.parse(result.answer.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* malformed review cannot authorize a merge */ }
      mother.result = { summary: result.answer, reviewedCommit: ready.review.commit };
      if (verdict?.passed !== true || typeof verdict.summary !== 'string' || !verdict.summary.trim()) throw new BridgeError(`Mother agent did not approve: ${verdict?.summary || 'no passing review with evidence'}`, 409);
      if (await workflowCandidateChanged(ready.review)) throw new BridgeError('Mother agent changed the candidate during review; nothing was merged', 409);
      ready.review = await mergeWorkflowReview(ready.review, signal); mother.status = 'succeeded';
    } catch (error) { mother.status = signal?.aborted ? 'cancelled' : 'failed'; mother.failureReason = (error as Error).message; ready.review.status = 'ready'; ready.review.error = (error as Error).message; throw error; }
    finally { controls.delete(`${record.id}:mother`); clearTimeout(progressTimers.get(record.id)); progressTimers.delete(record.id); await save(record); }
  }
  async function execute(record: WorkflowRecord, root: Root, controller: AbortController, resuming = false) {
    let isolation: Awaited<ReturnType<typeof workflowWorktrees>> | null = null;
    const inflight = new Set<Promise<void>>();
    // The whole run's time limit (Masih, 29 Oct: "set a time limit for these workflows"): past it, every agent stops and the
    // run ends as stopped, saying why. Each agent also keeps its own maxRuntimeSeconds.
    let overTime = false;
    const endsAt = record.runLimitSeconds ? (resuming ? Date.now() : record.startedAt) + record.runLimitSeconds * 1000 : null;
    const deadline = endsAt ? setTimeout(() => { overTime = true; controller.abort(); }, Math.max(0, endsAt - Date.now())) : null;
    // Agents are told the time left, so they finish inside the limit instead of being cut off by it (29 Oct: "agents are,
    // should be, forced to finish in that designated time").
    const minutesLeft = () => { const n = Math.max(1, Math.floor((endsAt! - Date.now()) / 60000)); return `${n} minute${n === 1 ? '' : 's'}`; };
    const timeLeft = () => endsAt ? `Time left for the whole run: about ${minutesLeft()}. Finish well inside it; if time is short, return your best complete result now rather than start long work.` : null;
    try {
      isolation = record.isolation ? await workflowWorktrees(root.cwd, record.id, resuming ? record as Parameters<typeof workflowWorktrees>[2] : undefined) : null;
      if (isolation) record.worktreeBase = isolation.base;
      let previous = new Map<string, { answer: string; file?: string }>();
      for (let round = resuming ? record.round : 1; round <= (record.roundLimit ?? 1); round++) {
        record.round = round;
        const answers = new Map<string, { answer: string; file?: string }>(), running = new Map<string, Promise<void>>();
        record.tasks.forEach(task => {
          if (task.cancelledBy === 'mother') return;
          if (resuming && round === record.round && task.status === 'succeeded') { answers.set(task.id, handed(task)); return; }
          task.status = 'pending'; task.failureReason = null; task.assignedThreadId = null; task.result = null;
        });
        // Rebuilt for each round; the Mother's additions join it as they come (decide, below).
        const byId = new Map(record.tasks.map(t => [t.id, t]));
        /** The one finished step a failed check sends back, once per check. */
        const fixable = (task: StoredTask, error: unknown) => task.kind === 'verify' && !task.fixed && /^Check failed:/.test((error as { message?: string } | null)?.message ?? '')
          && task.dependsOn.map(id => byId.get(id)).find(step => step?.kind !== 'verify' && step!.status === 'succeeded');
        const run = async (task: StoredTask) => {
          try {
            if (controller.signal.aborted) throw new BridgeError('Workflow cancelled', 409);
            task.status = 'running'; await save(record);
            const cwd = isolation ? await isolation.prepare(task, round) : root.cwd;
            task.cwd = cwd;
            if (isolation) task.worktree = isolation.paths().find(place => place.taskId === task.id && place.round === round);
            // An isolated task runs in its own worktree, where the agent folders are new again.
            for (const scope of task.writeScopes) await projectFolder(cwd, scope);
            const scopes = task.writeScopes;
            // A check looks for the files its criteria name where the checked agents could write (27 Oct: a correct file in
            // the agent's own folder failed a check that looked only at the workspace root).
            const checked = task.kind === 'verify' ? [...new Set(task.dependsOn.flatMap(id => byId.get(id)?.writeScopes ?? []))] : [];
            const instructions = [`Acceptance criteria:\n${task.acceptanceCriteria.map(c => `- ${c}`).join('\n')}`,
              scopes.length ? `Write only in: ${scopes.join(', ')}.` : 'Read only. Do not change files.',
              ...endsAt ? [timeLeft()] : [],
              ...checked.length ? [`The agents you check could write only in: ${checked.join(', ')}. Look for a file the criteria name there as well as at the path given.`] : [],
              task.kind === 'verify' ? 'Return only JSON: {"passed": true or false, "summary": "criteria and observed evidence"}. Set passed false if any criterion fails or cannot be checked.' : 'Return your final answer with observed evidence.'].join('\n\n');
            // A dependency the Mother cancelled has no answer; the agent goes on without it.
            const inputs = [...task.dependsOn.filter(id => answers.has(id)).map(id => ({ name: byId.get(id)!.title, ...answers.get(id)! })),
              ...(round > 1 ? (task.feedbackFrom ?? []).filter(id => previous.has(id)).map(id => ({ name: `${byId.get(id)!.title} · round ${round - 1}`, ...previous.get(id)! })) : [])];
            // A model he set on the agent wins; else the run's default for children (workflow-models.mts), else the chat's.
            const requested = record.recovery?.model ? { model: record.recovery.model, provider: record.recovery.provider ?? root.modelProvider ?? '' }
              : task.model ? { model: task.model, provider: task.provider ?? root.modelProvider ?? '' }
              : record.defaults?.child ? { ...record.defaults.child } : { model: root.model ?? '', provider: root.modelProvider ?? '' };
            const attempt = async () => {
              if (task.kind === 'join') {
                const inside = (rel: string) => { const full = path.resolve(cwd, rel); if (full !== cwd && !full.startsWith(`${cwd}${path.sep}`)) throw new BridgeError(`${rel} is outside the project`, 409); return full; };
                const texts = await Promise.all(task.parts!.map(async part => (await fs.readFile(inside(part), 'utf8')).trim()));
                const out = inside(task.output!); await fs.mkdir(path.dirname(out), { recursive: true }); await fs.writeFile(out, `${texts.reduce((all, part) => !all ? part : `${all}${task.flow && !/[.!?:;"”’)\]]$/.test(all) ? ' ' : '\n\n'}${part}`, '')}\n`);
                return { result: { answer: `Joined ${task.parts!.length} parts into ${task.output}.` }, changes: {} };
              }
              const result = await (record.runsOn === 'cloudroom' ? runOnCloudroom : runNode)(record, task, requested, instructions, { task: (record.roundLimit ? `Round ${round} of ${record.roundLimit}.\n` : '') + task.instruction + (task.supervisorInstruction ? `\n\nMother agent's corrective guidance:\n${task.supervisorInstruction}` : ''), inputs }, {
                cwd, signal: controller.signal, timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
                onPermission: request => permission(record, task, request), onUpdate: update => progress(record, task, update), onControl: control => { controls.set(`${record.id}:${task.id}`, control); },
              });
              cancelCheckpoints(record, task, 'The child turn ended before guidance could be delivered.');
              controls.delete(`${record.id}:${task.id}`);
              if (task.kind === 'verify') {
                let verdict;
                try { verdict = JSON.parse(result.answer.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* invalid check cannot pass */ }
                if (verdict?.passed !== true || typeof verdict.summary !== 'string' || !verdict.summary.trim()) throw new BridgeError(`Check failed: ${verdict?.summary || 'the agent did not return a passing check with evidence'}`, 409);
              }
              const changes = isolation ? await isolation.complete(task, round) : {};
              return { result, changes };
            };
            let completed;
            try { completed = await attempt(); }
            catch (error) {
              task.failureReason = (error as Error).message;
              // A failed check goes back to its step first (below); Mother is asked only once that fix is spent.
              if (fixable(task, error)) throw error;
              if (!await supervise(record, task, error, root, controller)) {
                // When the Mother cannot decide, a file saved outside the agent's folders still gets one plain correction
                // (1 Nov live run: Haiku saved answer-1.md at the project root, she gave up, and the whole Voting run failed).
                const misplaced = /changed files outside its write scopes: (.+?)\. Kept at /.exec((error as Error).message)?.[1];
                if (!misplaced || task.scopeFixed || controller.signal.aborted) throw error;
                task.scopeFixed = true;
                task.supervisorInstruction = `You saved ${misplaced} outside your allowed folders (${task.writeScopes.join(', ')}). Move ${misplaced.includes(',') ? 'them' : 'it'} into ${task.writeScopes[0]} with the same name, leave nothing outside your allowed folders, and change nothing else.`;
              }
              completed = await attempt();
            }
            const { result, changes } = completed;
            const passed = await spill(record, task, round, result.answer);
            answers.set(task.id, passed); task.result = { summary: result.answer, ...(passed.file ? { file: passed.file } : {}), ...changes }; task.status = 'succeeded'; task.failureReason = null;
            if (!['verify', 'join'].includes(task.kind)) afterSuccess(task);
          } catch (error) {
            const step = !controller.signal.aborted && fixable(task, error);
            if (step) {
              // 28 Oct: a check found a dropped clause and the run stopped, since Mother may only retry the failed node, the
              // check itself. Its step runs once more with the findings, then the check runs again; a second failure stops.
              task.fixed = true; task.status = 'pending'; task.failureReason = null;
              step.status = 'pending'; step.supervisorInstruction = `Your check found a problem: ${(error as Error).message.replace(/^Check failed: /, '')}\nFix exactly that in your files and change nothing else.`;
            } else { task.status = controller.signal.aborted ? 'cancelled' : 'failed'; task.failureReason = (error as Error).message; }
          }
          cancelCheckpoints(record, task, 'The child finished before guidance could be delivered.');
          controls.delete(`${record.id}:${task.id}`);
          await save(record);
        };
        // The Mother re-plans when a child succeeds (1 Nov, Masih approved "1) yes"): one call at a time, and children that
        // finish meanwhile reach her together in the next. Plain code first: with nothing left to run she is not asked.
        const replan: { waiting: string[]; pending: Promise<void> | null } = { waiting: [], pending: null };
        const afterSuccess = (task: StoredTask) => {
          if (!record.replan || controller.signal.aborted) return;
          replan.waiting.push(task.id);
          const kick = () => {
            if (replan.pending || !replan.waiting.length) return;
            replan.pending = queueSupervision(record, async () => {
              while (replan.waiting.length && !controller.signal.aborted) await decide(record, replan.waiting.splice(0), root, controller, byId);
            }).catch(error => logLine(record, `Mother agent could not re-plan: ${(error as Error).message}`)).finally(() => { replan.pending = null; kick(); });
          };
          kick();
        };
        while (record.tasks.some(t => !ended.has(t.status)) || replan.pending) {
          for (const task of record.tasks.filter(t => t.status === 'pending')) {
            if (controller.signal.aborted) { task.status = 'cancelled'; continue; }
            if (task.dependsOn.some(id => ['failed', 'blocked', 'cancelled'].includes(byId.get(id)!.status) && !settled(byId.get(id)!))) { task.status = 'blocked'; continue; }
            if (running.size >= (record.maxConcurrency ?? Infinity) || !task.dependsOn.every(id => settled(byId.get(id)!))) continue;
            if (!isolation && record.tasks.some(other => running.has(other.id) && task.writeScopes.some(a => other.writeScopes.some(b => a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))))) continue;
            // One budget for every workflow in this process: a node slot and enough memory (bridge/memory-budget.mjs).
            const release = await budget.acquire(controller.signal, text => logLine(record, text)).catch(error => { if (controller.signal.aborted) return null; throw error; });
            if (!release) continue;
            // A check that failed during the wait sent its step back; that step finishes again first.
            if (task.status !== 'pending' || !task.dependsOn.every(id => settled(byId.get(id)!))) { release(); continue; }
            const promise = run(task).finally(() => { release(); running.delete(task.id); inflight.delete(promise); }); running.set(task.id, promise); inflight.add(promise);
          }
          if (running.size || replan.pending) await Promise.race([...running.values(), ...(replan.pending ? [replan.pending] : [])]);
        }
        await Promise.all(running.values());
        if (controller.signal.aborted || record.tasks.some(t => !settled(t))) break;
        previous = answers; resuming = false;
      }
      await finishCheckpoints(record, 'The children finished before guidance could be delivered.');
      const status = controller.signal.aborted ? 'cancelled' : record.tasks.every(settled) ? 'succeeded' : 'failed';
      if (status === 'failed') record.error = record.tasks.find(task => task.failureReason)?.failureReason;
      if (status === 'succeeded' && isolation) {
        record.review = await isolation.review(controller.signal);
        if ((record.autoMerge || record.next) && record.review.status === 'ready') await reviewAndMerge(record, controller.signal);
        // Freed before the run shows as ended, so nothing it made outlives it.
        if (['merged', 'empty'].includes(record.review.status)) { record.worktrees = isolation.paths(); await freeRun(record); }
      }
      record.status = status;
      if (overTime) record.error = `Stopped at its ${Math.round(record.runLimitSeconds! / 60)}-minute time limit.`;
    } catch (error) {
      const cancelled = controller.signal.aborted; controller.abort(); await Promise.allSettled(inflight);
      record.status = cancelled ? 'cancelled' : 'failed'; record.error = overTime ? `Stopped at its ${Math.round(record.runLimitSeconds! / 60)}-minute time limit.` : (error as Error).message;
    }
    finally {
      clearTimeout(deadline as ReturnType<typeof setTimeout> | undefined);
      await finishCheckpoints(record, 'The workflow ended before guidance could be delivered.');
      record.tasks.forEach(task => { if (!ended.has(task.status)) task.status = record.status === 'cancelled' ? 'cancelled' : 'blocked'; });
      record.endedAt = Date.now();
      clearTimeout(progressTimers.get(record.id)); progressTimers.delete(record.id);
      if (isolation) record.worktrees = isolation.paths();
      const completed = { ...record }; record.status = 'running';
      try { await save(completed); }
      catch (error) { completed.status = 'failed'; completed.error = `Could not save the workflow result: ${(error as Error).message}`; }
      finally {
        supervision.delete(record.id); routeSnapshots.delete(record.id); exhaustedProviders.delete(record.id); active.delete(record.rootThreadId); await fs.unlink(path.join(stateDir, `${record.rootThreadId}.lock`)).catch(() => {}); records.set(record.id, completed);
        if (onEnd) void Promise.resolve().then(() => onEnd(structuredClone(completed))).catch(error => console.error('Workflow next stage:', (error as Error).message));
      }
    }
  }
  return {
    busy: () => active.size > 0 || mergingSources.size > 0,
    async list(rootThreadId?: string) { await load(); return structuredClone([...records.values()].filter(r => rootThreadId === undefined || r.rootThreadId === rootThreadId)); },
    async start(params: WorkflowParams, root: Root): Promise<StartedRun> {
      validateWorkflow(params.tasks, params.roundLimit); await load();
      if (params.runsOn === 'cloudroom') {
        if (!cloudroom) throw new BridgeError('CloudRoom is not available in this Elpis.', 503);
        cloudroom.ready();
      }
      if (mergeControllers.has(params.rootThreadId)) throw new BridgeError('Mother agent is reviewing this workflow', 409);
      if (!path.isAbsolute(root.cwd ?? '')) throw new BridgeError('Choose a project folder before running a workflow');
      root = { ...root, cwd: await fs.realpath(root.cwd) };
      for (const task of params.tasks) for (const scope of task.writeScopes) await projectFolder(root.cwd, scope);
      const lock = path.join(stateDir, `${params.rootThreadId}.lock`);
      if (!await acquireLock(lock)) return this.start(params, root);
      // The run's default models, read once from the real catalogues (workflow-models.mts workflowDefaults).
      const defaults = modelDefaults ? await Promise.resolve().then(modelDefaults).catch(() => null) : null;
      const record: WorkflowRecord = { ...structuredClone(params), ...(defaults ? { defaults } : {}), projectCwd: root.cwd, id: randomUUID(), ownerPid: process.pid, status: 'running', startedAt: Date.now(), round: 1,
        tasks: params.tasks.map(task => ({ ...structuredClone(task), status: 'pending', assignedThreadId: null, result: null, failureReason: null })) };
      const controller = new AbortController(); active.set(params.rootThreadId, controller); records.set(record.id, record);
      try { await save(record); } catch (error) { record.status = 'failed'; record.error = (error as Error).message; active.delete(params.rootThreadId); await fs.unlink(lock); throw error; }
      void execute(record, root, controller).catch(error => console.error('Could not save ACP workflow state:', (error as Error).message));
      return { graphId: record.id, threadId: params.rootThreadId, turnId: record.id };
    },
    async resume(id: string, root: Root, overrides: { model?: string; provider?: string } = {}): Promise<StartedRun> {
      await load(); const record = records.get(id);
      if (!record) throw new BridgeError('Workflow not found', 404);
      if (!['failed', 'blocked', 'cancelled'].includes(record.status)) throw new BridgeError('Only failed or stopped workflow nodes need recovery', 409);
      if (active.has(record.rootThreadId) || mergeControllers.has(record.rootThreadId)) throw new BridgeError('This workflow is already running', 409);
      if (record.cleanup) throw new BridgeError(gone, 409);
      if (observeThread) {
        const memberIds = new Set([record.mother?.assignedThreadId, record.mother?.sessionId, record.next?.threadId,
          ...[...record.tasks, ...record.next?.tasks ?? []].map(task => task.assignedThreadId)].filter((id): id is string => Boolean(id && id !== record.rootThreadId)));
        if (listThreadDescendants) {
          try {
            const listed = [], cursors = new Set(); let cursor;
            do {
              const page = await listThreadDescendants({ ancestorThreadId: record.rootThreadId, limit: 100, ...(cursor ? { cursor } : {}) });
              if (!Array.isArray(page?.data)) throw new Error('Invalid live team list');
              listed.push(...page.data); cursor = page.nextCursor;
              if (cursor && cursors.has(cursor)) throw new Error('Repeated live team page');
              if (cursor) cursors.add(cursor);
            } while (cursor);
            for (let changed = true; changed;) {
              changed = false;
              for (const thread of listed) if (!memberIds.has(thread.id) && memberIds.has(agentParentId(thread) as string)) {
                memberIds.add(thread.id); changed = true;
              }
            }
          } catch { throw new BridgeError('Could not check the workflow’s current agents. Refresh live progress or open their chats before retrying recovery.', 409); }
        }
        const ids = [...new Set([record.rootThreadId, ...memberIds])];
        for (let offset = 0; offset < ids.length; offset += 3) {
          let observed;
          try { observed = await Promise.all(ids.slice(offset, offset + 3).map(id => observeThread(id))); }
          catch { throw new BridgeError('Could not check the workflow’s current agents. Refresh live progress or open their chats before retrying recovery.', 409); }
          if (observed.some(thread => ['active', 'running', 'inProgress'].includes(thread?.status?.type as string))) {
            throw new BridgeError('A workflow agent is already working. Open its chat to follow or steer it; recovery has not started another copy.', 409);
          }
        }
      }
      if (record.tasks.some(task => task.status === 'succeeded' && typeof task.result?.summary !== 'string')) throw new BridgeError('Completed workflow evidence is incomplete. Saved work was preserved; inspect the run before recovery.', 409);
      if ((record.round ?? 1) > 1) throw new BridgeError('This multi-round run lacks retained earlier-round evidence for recovery. Start a new workflow using its saved results; existing work was preserved.', 409);
      if (overrides.model) record.recovery = { model: overrides.model, ...(overrides.provider ? { provider: overrides.provider } : {}), at: Date.now() };
      if (record.tasks.every(task => task.status === 'succeeded') && record.review?.status === 'ready') { await this.merge(id); return { graphId: record.id, threadId: record.rootThreadId, turnId: record.id }; }
      if (!path.isAbsolute(root.cwd ?? '')) throw new BridgeError('Choose the workflow project before recovery');
      root = { ...root, cwd: await fs.realpath(root.cwd) };
      const originalCwd = record.projectCwd ?? (!record.isolation ? record.tasks.find(task => task.cwd)?.cwd : undefined);
      if (originalCwd && root.cwd !== originalCwd) throw new BridgeError('Recover this workflow in its original project. Its work and results have been preserved.', 409);
      record.projectCwd ??= root.cwd;
      const lock = path.join(stateDir, `${record.rootThreadId}.lock`);
      if (!await acquireLock(lock)) return this.resume(id, root, overrides);
      record.status = 'running'; record.ownerPid = process.pid; record.resumedAt = Date.now(); delete record.endedAt; delete record.error;
      if (overrides.model) record.recovery = { model: overrides.model, ...(overrides.provider ? { provider: overrides.provider } : {}), at: Date.now() };
      for (const task of record.tasks) if (task.status !== 'succeeded') delete task.supervisedRound;
      routeSnapshots.delete(id); exhaustedProviders.delete(id);
      const controller = new AbortController(); active.set(record.rootThreadId, controller);
      try { await save(record); } catch (error) { active.delete(record.rootThreadId); record.status = 'failed'; await fs.unlink(lock); throw error; }
      void execute(record, root, controller, true).catch(error => console.error('Could not save recovered workflow state:', (error as Error).message));
      return { graphId: record.id, threadId: record.rootThreadId, turnId: record.id };
    },
    /** Frees a run removed from History, whatever its status, and retries any earlier removal that failed. Never throws. */
    async free(id: string) {
      await load();
      const busy = (record: WorkflowRecord) => active.has(record.rootThreadId) || mergeControllers.has(record.rootThreadId);
      for (const record of records.values()) {
        if ((record.id !== id && record.cleanup?.status !== 'failed') || busy(record)) continue;
        await freeRun(record); await save(record).catch(error => { record.persistenceError = (error as Error).message; });
      }
      return records.get(id)?.cleanup ?? null;
    },
    cancel(rootThreadId: string) { const controller = active.get(rootThreadId) ?? mergeControllers.get(rootThreadId); if (!controller) return false; controller.abort(); return true; },
    async merge(id: string) {
      await load(); const record = records.get(id);
      if (!record) throw new BridgeError('Workflow not found', 404);
      const retryMother = record.status === 'failed' && record.mother?.status === 'failed' && record.review?.status === 'ready' && record.tasks.every(task => task.status === 'succeeded');
      if (record.status !== 'succeeded' && !retryMother) throw new BridgeError('Only a successful workflow can be merged', 409);
      if (record.review?.status === 'merged') {
        if (record.review.error) { delete record.review.error; await save(record); }
        return { review: structuredClone(record.review) };
      }
      if (record.review?.status !== 'ready') throw new BridgeError('This workflow has no changes ready to merge', 409);
      if (record.cleanup) throw new BridgeError(gone.replace('resume', 'merge'), 409);
      const source = record.review.source;
      if (mergingSources.has(source)) throw new BridgeError('A workflow merge is already running for this project', 409);
      mergingSources.add(source);
      const controller = new AbortController(); mergeControllers.set(record.rootThreadId, controller);
      try {
        await reviewAndMerge(record, controller.signal); record.status = 'succeeded'; delete record.error; await freeRun(record); await save(record);
        return { review: structuredClone(record.review) };
      } catch (error) { record.review.error = (error as Error).message; await save(record); throw error; }
      finally { mergingSources.delete(source); mergeControllers.delete(record.rootThreadId); }
    },
    async noteManualSteer(threadId: string) {
      for (const record of records.values()) {
        if (record.status !== 'running') continue;
        const tasks = record.tasks.filter(task => task.status === 'running' && [task.assignedThreadId, task.sessionId].includes(threadId));
        if (!tasks.length) continue;
        for (const task of tasks) task.manualRevision = (task.manualRevision ?? 0) + 1;
        await save(record);
      }
    },
    async steer(id: string, taskId: string, input: { id?: unknown; text?: unknown }) {
      await load();
      const record = records.get(id);
      if (!record) throw new BridgeError('Workflow not found', 404);
      const task = taskId === 'mother' ? record.mother : record.tasks.find(task => task.id === taskId);
      if (!task) throw new BridgeError('Workflow node not found', 404);
      const message: SteerMessage = { id: input.id === undefined ? randomUUID() : text(input.id, 'message ID', 100), text: text(input.text, 'message', 16000), status: 'pending', at: Date.now(), round: record.round };
      const previous = task.messages?.find(entry => entry.id === message.id);
      if (previous) { if (previous.text !== message.text) throw new BridgeError('Message ID already used', 409); return { message: structuredClone(previous) }; }
      const control = controls.get(`${record.id}:${task.id}`);
      if ((record.status !== 'running' && record.review?.status !== 'reviewing') || task.status !== 'running' || !control) throw new BridgeError('This workflow node is not running or is still starting', 409);
      if ((task.messages?.length ?? 0) >= 100) throw new BridgeError('This node has reached its message limit', 409);
      task.manualRevision = (task.manualRevision ?? 0) + 1;
      (task.messages ??= []).push(message); await save(record);
      void control.steer(message.text).then(result => { message.status = 'delivered'; message.delivery = result.delivery; }, error => { message.status = 'failed'; message.error = (error as Error).message; }).then(() => save(records.get(id)!)).catch(error => { record.persistenceError = (error as Error).message; });
      return { message: structuredClone(message) };
    },
    /** Records how a run's next stage goes (`next`: its chat, run, status, whether its report was delivered). */
    async note(id: string, patch: Record<string, unknown>) {
      await load(); const record = records.get(id);
      if (!record?.next) return;
      record.next = { ...record.next, ...patch }; await save(record);
    },
    close() { for (const controller of [...active.values(), ...mergeControllers.values()]) controller.abort(); },
  };
}
