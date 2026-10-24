import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, text } from './client.mjs';
import { loveNodeSpec } from './love-agents.mjs';
import { runAcpNode } from './acp-nodes.mjs';
import { workflowWorktrees, mergeWorkflowReview, checkWorkflowReview, workflowCandidateChanged } from './workflow-worktrees.mjs';

const ended = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);
const writer = task => ['implement', 'fix'].includes(task.kind);
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

/** A write scope as a folder inside `base`, made when missing (each agent's own folder is new on its first run). The
 * nearest folder that exists must already be inside `base`, so a link out of the project creates nothing. */
async function projectFolder(base, scope) {
  const refused = () => new BridgeError('Write scopes must be project folders');
  if (typeof scope !== 'string' || path.isAbsolute(scope) || scope.split(/[\\/]/).includes('..')) throw refused();
  const real = await fs.realpath(base), target = path.join(real, scope), inside = at => at === real || at.startsWith(`${real}${path.sep}`);
  let existing = target;
  for (;;) {
    try { existing = await fs.realpath(existing); break; } catch (error) { if (error.code !== 'ENOENT') throw error; existing = path.dirname(existing); }
  }
  if (!inside(existing)) throw refused();
  await fs.mkdir(target, { recursive: true });
  const resolved = await fs.realpath(target);
  if (!inside(resolved) || !(await fs.stat(resolved)).isDirectory()) throw refused();
  return resolved;
}

/** Validate the complete graph before starting any ACP process. Feedback is from a previous bounded round. */
export function validateWorkflow(tasks, roundLimit) {
  const ids = new Set(tasks.map(t => t.id));
  if (ids.size !== tasks.length || tasks.some(t => !/^[A-Za-z0-9_-]{1,100}$/.test(t.id))) throw new BridgeError('Task IDs must be unique letters, digits, hyphens or underscores');
  if (roundLimit !== undefined && (!Number.isSafeInteger(roundLimit) || roundLimit < 1 || roundLimit > 100)) throw new BridgeError('Choose a round limit from 1 to 100');
  for (const task of tasks) {
    if ([...task.dependsOn, ...(task.feedbackFrom ?? [])].some(id => !ids.has(id))) throw new BridgeError('A task dependency is missing');
    if (task.feedbackFrom?.length && roundLimit === undefined) throw new BridgeError('Recursive feedback needs an explicit round limit');
    if (writer(task) && (!task.writeScopes.length || !tasks.some(check => check.kind === 'verify' && check.dependsOn.includes(task.id)))) throw new BridgeError('Every writer needs folders and a directly dependent check');
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
  onPermission, onSession, onEnd } = {}) {
  const records = new Map(), active = new Map();
  const controls = new Map(), progressTimers = new Map();
  const mergingSources = new Set(), mergeControllers = new Map();
  let loaded;
  const load = () => loaded ??= (async () => {
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(stateDir)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const record = JSON.parse(await fs.readFile(path.join(stateDir, name), 'utf8'));
      if (record.status === 'running' && !alive(record.ownerPid)) {
        record.status = 'cancelled'; record.error = 'The desktop stopped before this ACP run finished.';
        record.tasks.forEach(t => { if (!ended.has(t.status)) t.status = 'cancelled'; });
      }
      records.set(record.id, record);
    }
  })();
  let saving = Promise.resolve();
  const save = record => {
    const snapshot = JSON.stringify(record);
    const pending = saving.catch(() => {}).then(async () => {
      const file = path.join(stateDir, `${record.id}.json`), temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, snapshot, { mode: 0o600 }); await fs.rename(temp, file);
    });
    saving = pending; return pending;
  };
  const progress = (record, task, update) => {
    const entries = task.progress ??= [], at = Date.now();
    if (['agent_message_chunk', 'agent_thought_chunk'].includes(update?.sessionUpdate) && update.content?.type === 'text') {
      const last = entries.at(-1), kind = update.sessionUpdate === 'agent_thought_chunk' ? 'thinking' : 'text';
      if (last?.kind === kind && last.messageId === update.messageId) { last.text = (last.text + update.content.text).slice(-8000); last.at = at; }
      else entries.push({ kind, messageId: update.messageId, text: update.content.text.slice(-8000), at });
    } else if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
      let entry = entries.find(row => row.kind === 'tool' && row.id === update.toolCallId);
      if (!entry) entries.push(entry = { kind: 'tool', id: update.toolCallId });
      Object.assign(entry, { at, ...(update.title ? { title: String(update.title).slice(0, 1000) } : {}), ...(update.status ? { status: update.status } : {}) });
    } else return;
    let size = entries.reduce((total, entry) => total + (entry.text?.length ?? 0) + (entry.title?.length ?? 0), 0);
    while (entries.length > 1 && (entries.length > 80 || size > 32000)) { const removed = entries.shift(); size -= (removed.text?.length ?? 0) + (removed.title?.length ?? 0); }
    if (!progressTimers.has(record.id)) progressTimers.set(record.id, setTimeout(() => {
      progressTimers.delete(record.id); void save(record).catch(error => { record.persistenceError = error.message; });
    }, 200));
  };
  async function reviewAndMerge(record, signal) {
    if (await checkWorkflowReview(record.review, signal)) { record.review = await mergeWorkflowReview(record.review, signal); return; }
    const mother = record.mother = { id: 'mother', title: 'Mother', model: 'claude/opus', provider: 'claude', reasoningEffort: 'low', status: 'running', progress: [] };
    const permissionScope = new AbortController();
    record.review.status = 'reviewing'; await save(record);
    try {
      const instructions = 'You are Mother, the workflow coordinator. Review the children’s candidate commits and focused test evidence. Read and run checks only; do not change files, commit, merge, delegate or push. Approve only if the requested task is complete and the checks pass. Return only JSON: {"passed":true or false,"summary":"observed evidence and any remaining failure"}.';
      const spec = nodeSpec({ name: 'Mother', prompt: instructions, model: mother.model, provider: mother.provider }, env);
      spec.reasoningEffort = mother.reasoningEffort;
      spec.meta = { ...spec.meta, elpis: { ...spec.meta?.elpis, name: 'Workflows · Mother', workflow: { kind: 'verify', writeScopes: [], reasoningEffort: mother.reasoningEffort } } };
      const result = await runAcpNode(spec, { task: `Review candidate commit ${record.review.commit}. Workflow: ${record.name}.\n${record.goal ?? ''}\n\nChange summary:\n${record.review.stat}`, inputs: record.tasks.map(task => ({ name: task.title, answer: task.result?.summary ?? task.failureReason ?? task.status })) }, {
        cwd: record.review.path, signal, timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
        onUpdate: update => progress(record, mother, update),
        onControl: control => controls.set(`${record.id}:mother`, control),
        onSession: id => { mother.sessionId = id; onSession?.(record, mother, id); void save(record).catch(() => {}); },
        onPermission: request => onPermission?.(record, mother, request, permissionScope.signal),
      });
      let verdict;
      try { verdict = JSON.parse(result.answer.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* malformed review cannot authorize a merge */ }
      mother.result = { summary: result.answer, reviewedCommit: record.review.commit };
      if (verdict?.passed !== true || typeof verdict.summary !== 'string' || !verdict.summary.trim()) throw new BridgeError(`Mother did not approve: ${verdict?.summary || 'no passing review with evidence'}`, 409);
      if (await workflowCandidateChanged(record.review)) throw new BridgeError('Mother changed the candidate during review; nothing was merged', 409);
      record.review = await mergeWorkflowReview(record.review, signal); mother.status = 'succeeded';
    } catch (error) { mother.status = signal?.aborted ? 'cancelled' : 'failed'; mother.failureReason = error.message; record.review.status = 'ready'; record.review.error = error.message; throw error; }
    finally { permissionScope.abort(); controls.delete(`${record.id}:mother`); clearTimeout(progressTimers.get(record.id)); progressTimers.delete(record.id); await save(record); }
  }
  async function execute(record, root, controller) {
    let isolation;
    const inflight = new Set();
    try {
      isolation = record.isolation ? await workflowWorktrees(root.cwd, record.id) : null;
      let previous = new Map();
      for (let round = 1; round <= (record.roundLimit ?? 1); round++) {
        record.round = round;
        const answers = new Map(), running = new Map();
        record.tasks.forEach(task => { task.status = 'pending'; task.failureReason = null; task.assignedThreadId = null; task.result = null; });
        const byId = new Map(record.tasks.map(t => [t.id, t]));
        const run = async task => {
          const permissionScope = new AbortController();
          try {
            if (controller.signal.aborted) throw new BridgeError('Workflow cancelled', 409);
            task.status = 'running'; await save(record);
            const cwd = isolation ? await isolation.prepare(task, round, record.tasks) : root.cwd;
            task.cwd = cwd;
            if (isolation) task.worktree = isolation.paths().find(place => place.taskId === task.id && place.round === round);
            // An isolated task runs in its own worktree, where the agent folders are new again.
            for (const scope of task.writeScopes) await projectFolder(cwd, scope);
            const scopes = task.writeScopes;
            const instructions = [`Acceptance criteria:\n${task.acceptanceCriteria.map(c => `- ${c}`).join('\n')}`,
              scopes.length ? `Write only in: ${scopes.join(', ')}.` : 'Read only. Do not change files.',
              task.kind === 'verify' ? 'Return only JSON: {"passed": true or false, "summary": "criteria and observed evidence"}. Set passed false if any criterion fails or cannot be checked.' : 'Return your final answer with observed evidence.'].join('\n\n');
            const spec = nodeSpec({ name: task.title, prompt: instructions, model: task.model ?? root.model ?? '', provider: task.provider ?? root.modelProvider ?? '' }, env);
            if (task.reasoningEffort) spec.reasoningEffort = task.reasoningEffort;
            spec.meta = { ...spec.meta, elpis: { ...spec.meta?.elpis, name: `Workflows · ${task.title}`, workflow: { kind: task.kind, writeScopes: scopes, ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}) } } };
            const inputs = [...task.dependsOn.map(id => ({ name: byId.get(id).title, answer: answers.get(id) })),
              ...(round > 1 ? (task.feedbackFrom ?? []).map(id => ({ name: `${byId.get(id).title} · round ${round - 1}`, answer: previous.get(id) })) : [])];
            const result = await runAcpNode(spec, { task: record.roundLimit ? `Round ${round} of ${record.roundLimit}.\n${task.instruction}` : task.instruction, inputs }, {
              cwd, signal: controller.signal, timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
              onPermission: request => onPermission?.(record, task, request, permissionScope.signal),
              onSession: id => { task.assignedThreadId = spec.elpis ? id : null; task.sessionId = id; onSession?.(record, task, id); void save(record).catch(() => {}); },
              onUpdate: update => progress(record, task, update),
              onControl: control => { controls.set(`${record.id}:${task.id}`, control); },
            });
            if (task.kind === 'verify') {
              let verdict;
              try { verdict = JSON.parse(result.answer.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* invalid check cannot pass */ }
              if (verdict?.passed !== true || typeof verdict.summary !== 'string' || !verdict.summary.trim()) throw new BridgeError(`Check failed: ${verdict?.summary || 'the agent did not return a passing check with evidence'}`, 409);
            }
            const changes = isolation ? await isolation.complete(task, round) : {};
            answers.set(task.id, result.answer); task.result = { summary: result.answer, ...changes }; task.status = 'succeeded';
          } catch (error) {
            task.status = controller.signal.aborted ? 'cancelled' : 'failed'; task.failureReason = error.message;
          }
          permissionScope.abort();
          controls.delete(`${record.id}:${task.id}`);
          await save(record);
        };
        while (record.tasks.some(t => !ended.has(t.status))) {
          for (const task of record.tasks.filter(t => t.status === 'pending')) {
            if (controller.signal.aborted) { task.status = 'cancelled'; continue; }
            if (task.dependsOn.some(id => ['failed', 'blocked', 'cancelled'].includes(byId.get(id).status))) { task.status = 'blocked'; continue; }
            if (running.size >= (record.maxConcurrency ?? 3) || !task.dependsOn.every(id => byId.get(id).status === 'succeeded')) continue;
            if (!isolation && record.tasks.some(other => running.has(other.id) && task.writeScopes.some(a => other.writeScopes.some(b => a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))))) continue;
            const promise = run(task).finally(() => { running.delete(task.id); inflight.delete(promise); }); running.set(task.id, promise); inflight.add(promise);
          }
          if (running.size) await Promise.race(running.values());
        }
        await Promise.all(running.values());
        if (controller.signal.aborted || record.tasks.some(t => t.status !== 'succeeded')) break;
        previous = answers;
      }
      let status = controller.signal.aborted ? 'cancelled' : record.tasks.every(t => t.status === 'succeeded') ? 'succeeded' : 'failed';
      if (status === 'failed') record.error = record.tasks.find(task => task.failureReason)?.failureReason;
      if (status === 'succeeded' && isolation) {
        record.review = await isolation.review(controller.signal);
        if ((record.autoMerge || record.next) && record.review.status === 'ready') await reviewAndMerge(record, controller.signal);
      }
      record.status = status;
    } catch (error) {
      const cancelled = controller.signal.aborted; controller.abort(); await Promise.allSettled(inflight);
      record.status = cancelled ? 'cancelled' : 'failed'; record.error = error.message;
    }
    finally {
      record.tasks.forEach(task => { if (!ended.has(task.status)) task.status = record.status === 'cancelled' ? 'cancelled' : 'blocked'; });
      record.endedAt = Date.now();
      clearTimeout(progressTimers.get(record.id)); progressTimers.delete(record.id);
      if (isolation) record.worktrees = isolation.paths();
      const completed = { ...record }; record.status = 'running';
      try { await save(completed); }
      catch (error) { completed.status = 'failed'; completed.error = `Could not save the workflow result: ${error.message}`; }
      finally {
        active.delete(record.rootThreadId); await fs.unlink(path.join(stateDir, `${record.rootThreadId}.lock`)).catch(() => {}); records.set(record.id, completed);
        if (onEnd) void Promise.resolve().then(() => onEnd(structuredClone(completed))).catch(error => console.error('Workflow next stage:', error.message));
      }
    }
  }
  return {
    busy: () => active.size > 0 || mergingSources.size > 0,
    async list(rootThreadId) { await load(); return structuredClone([...records.values()].filter(r => rootThreadId === undefined || r.rootThreadId === rootThreadId)); },
    async start(params, root) {
      validateWorkflow(params.tasks, params.roundLimit); await load();
      if (mergeControllers.has(params.rootThreadId)) throw new BridgeError('Mother is reviewing this workflow', 409);
      if (!path.isAbsolute(root.cwd ?? '')) throw new BridgeError('Choose a project folder before running a workflow');
      root = { ...root, cwd: await fs.realpath(root.cwd) };
      for (const task of params.tasks) for (const scope of task.writeScopes) await projectFolder(root.cwd, scope);
      const lock = path.join(stateDir, `${params.rootThreadId}.lock`);
      try {
        const handle = await fs.open(lock, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close();
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(await fs.readFile(lock, 'utf8'));
        if (alive(pid)) throw new BridgeError('A workflow is already running in this conversation', 409);
        await fs.unlink(lock); return this.start(params, root);
      }
      const record = { ...structuredClone(params), id: randomUUID(), ownerPid: process.pid, status: 'running', startedAt: Date.now(), round: 1,
        tasks: params.tasks.map(task => ({ ...structuredClone(task), status: 'pending', assignedThreadId: null, result: null, failureReason: null })) };
      const controller = new AbortController(); active.set(params.rootThreadId, controller); records.set(record.id, record);
      try { await save(record); } catch (error) { record.status = 'failed'; record.error = error.message; active.delete(params.rootThreadId); await fs.unlink(lock); throw error; }
      void execute(record, root, controller).catch(error => console.error('Could not save ACP workflow state:', error.message));
      return { graphId: record.id, threadId: params.rootThreadId, turnId: record.id };
    },
    cancel(rootThreadId) { const controller = active.get(rootThreadId) ?? mergeControllers.get(rootThreadId); if (!controller) return false; controller.abort(); return true; },
    async merge(id) {
      await load(); const record = records.get(id);
      if (!record) throw new BridgeError('Workflow not found', 404);
      const retryMother = record.status === 'failed' && record.mother?.status === 'failed' && record.review?.status === 'ready' && record.tasks.every(task => task.status === 'succeeded');
      if (record.status !== 'succeeded' && !retryMother) throw new BridgeError('Only a successful workflow can be merged', 409);
      if (record.review?.status === 'merged') {
        if (record.review.error) { delete record.review.error; await save(record); }
        return { review: structuredClone(record.review) };
      }
      if (record.review?.status !== 'ready') throw new BridgeError('This workflow has no changes ready to merge', 409);
      const source = record.review.source;
      if (mergingSources.has(source)) throw new BridgeError('A workflow merge is already running for this project', 409);
      mergingSources.add(source);
      const controller = new AbortController(); mergeControllers.set(record.rootThreadId, controller);
      try {
        await reviewAndMerge(record, controller.signal); record.status = 'succeeded'; delete record.error; await save(record);
        return { review: structuredClone(record.review) };
      } catch (error) { record.review.error = error.message; await save(record); throw error; }
      finally { mergingSources.delete(source); mergeControllers.delete(record.rootThreadId); }
    },
    async steer(id, taskId, input) {
      await load();
      const record = records.get(id);
      if (!record) throw new BridgeError('Workflow not found', 404);
      const task = taskId === 'mother' ? record.mother : record.tasks.find(task => task.id === taskId);
      if (!task) throw new BridgeError('Workflow node not found', 404);
      const message = { id: input.id === undefined ? randomUUID() : text(input.id, 'message ID', 100), text: text(input.text, 'message', 16000), status: 'pending', at: Date.now(), round: record.round };
      const previous = task.messages?.find(entry => entry.id === message.id);
      if (previous) { if (previous.text !== message.text) throw new BridgeError('Message ID already used', 409); return { message: structuredClone(previous) }; }
      const control = controls.get(`${record.id}:${task.id}`);
      if ((record.status !== 'running' && record.review?.status !== 'reviewing') || task.status !== 'running' || !control) throw new BridgeError('This workflow node is not running or is still starting', 409);
      if ((task.messages?.length ?? 0) >= 100) throw new BridgeError('This node has reached its message limit', 409);
      (task.messages ??= []).push(message); await save(record);
      void control.steer(message.text).then(result => { message.status = 'delivered'; message.delivery = result.delivery; }, error => { message.status = 'failed'; message.error = error.message; }).then(() => save(records.get(id))).catch(error => { record.persistenceError = error.message; });
      return { message: structuredClone(message) };
    },
    /** Records how a run's next stage goes (`next`: its chat, run, status, whether its report was delivered). */
    async note(id, patch) {
      await load(); const record = records.get(id);
      if (!record?.next) return;
      record.next = { ...record.next, ...patch }; await save(record);
    },
    close() { for (const controller of [...active.values(), ...mergeControllers.values()]) controller.abort(); },
  };
}
