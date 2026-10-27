import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, text } from './client.mjs';
import { loveNodeSpec } from './love-agents.mjs';
import { runAcpNode } from './acp-nodes.mjs';
import { workflowRoute, quotaFailure } from './workflow-models.mjs';
import { workflowWorktrees, mergeWorkflowReview, checkWorkflowReview, workflowCandidateChanged } from './workflow-worktrees.mjs';

const ended = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);
const writer = task => ['implement', 'fix'].includes(task.kind);
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

/** History visibility only. Run files, chats and execution are never changed; Undo survives an app restart. */
export function createWorkflowHistory(file) {
  let removed, loading, changing = Promise.resolve();
  const terminal = new Set([...ended, 'completed', 'stopped']);
  const finished = run => terminal.has(run.status)
    && (!run.next || terminal.has(run.next.status))
    && !run.tasks?.some(task => task.status === 'running')
    && !['running', 'reviewing'].includes(run.mother?.status) && run.review?.status !== 'reviewing';
  const load = () => loading ??= fs.readFile(file, 'utf8').then(raw => {
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Array.isArray(saved.removed) || saved.removed.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) throw Error('Invalid workflow history');
    removed = [...new Set(saved.removed)];
  }).catch(error => {
    if (error.code === 'ENOENT') { removed = []; return; }
    loading = null; throw new BridgeError('Could not read workflow history. Nothing was removed.', 503);
  });
  const change = action => {
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
    async list(runs) {
      await changing.catch(() => {}); await load();
      return { data: runs.filter(run => !removed.includes(run.id) || !finished(run)).map(run => ({ ...run, removable: finished(run),
        ...(!finished(run) ? { removalReason: 'Finish this workflow before removing it from history.' } : {}) })), canUndo: removed.length > 0 };
    },
    remove(id, readRuns) {
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
  onSession, onEnd, modelRoutes } = {}) {
  const records = new Map(), active = new Map();
  const controls = new Map(), progressTimers = new Map(), supervision = new Map(), routeSnapshots = new Map(), exhaustedProviders = new Map();
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
  const permission = async (record, task, request) => {
    const options = request.options ?? [];
    const option = options.find(option => option.kind === 'allow_once') ?? options.find(option => option.kind === 'allow_always');
    const entry = { at: Date.now(), round: record.round, sessionId: request.sessionId, toolCallId: request.toolCall?.toolCallId, title: String(request.toolCall?.title || task.title).slice(0, 1000), optionId: option?.optionId ?? null };
    const log = task.permissions ??= []; log.push(entry); if (log.length > 100) log.shift();
    progress(record, task, { sessionUpdate: 'agent_message_chunk', messageId: `permission-${randomUUID()}`, content: { type: 'text', text: `${option ? 'Allowed' : 'Refused'} automatically: ${entry.title}${option ? ` (${option.name || option.optionId})` : ' (no allow option offered)'}` } });
    await save(record); return entry.optionId;
  };
  const fullAccess = spec => {
    // Keep the provider's checks active; the permission callback answers automatic agents.
    if (!spec.elpis && !spec.instructionsInPrompt) spec.mode = 'default';
    return spec;
  };
  async function routesFor(record) {
    if (!modelRoutes) return [];
    if (!routeSnapshots.has(record.id)) routeSnapshots.set(record.id, Promise.resolve().then(() => modelRoutes()).catch(() => []));
    return routeSnapshots.get(record.id);
  }
  async function runNode(record, owner, requested, instructions, input, options) {
    const routes = await routesFor(record), requestedRoute = workflowRoute(requested.model, requested.provider);
    const desired = { ...routes.find(route => route.provider === requestedRoute.provider), ...routes.find(route => route.model === requestedRoute.model && route.provider === requestedRoute.provider), ...requestedRoute };
    const candidates = [desired, ...routes.filter(route => route.provider !== desired.provider)], seen = new Set();
    const unavailable = exhaustedProviders.get(record.id) ?? new Set(); exhaustedProviders.set(record.id, unavailable);
    const routing = owner.routing ??= { requested: requestedRoute, actual: null, attempts: [] };
    let previousError;
    for (const route of candidates) {
      if (seen.has(route.provider)) continue; seen.add(route.provider);
      const attempt = { model: route.model, provider: route.provider, status: 'running', startedAt: Date.now() };
      routing.attempts.push(attempt);
      if (route.exhausted || unavailable.has(route.provider)) {
        attempt.status = 'skipped'; attempt.reason = route.reason || 'This subscription reached its usage limit'; attempt.endedAt = Date.now();
        progress(record, owner, { sessionUpdate: 'agent_message_chunk', messageId: `route-${randomUUID()}`, content: { type: 'text', text: `Skipped ${route.model || route.provider}: ${attempt.reason}` } });
        continue;
      }
      routing.actual = { model: route.model, provider: route.provider };
      if (route.model !== requestedRoute.model || route.provider !== requestedRoute.provider) {
        attempt.reason = previousError?.message || 'The requested subscription is unavailable';
        progress(record, owner, { sessionUpdate: 'agent_message_chunk', messageId: `route-${randomUUID()}`, content: { type: 'text', text: `Continuing with ${route.model} (${route.provider}). ${attempt.reason}` } });
      }
      await save(record);
      try {
        const recovery = previousError ? '\n\nA previous attempt reached its subscription limit. Continue in this same workspace. Inspect existing files before acting; preserve completed work and do not repeat actions already evidenced there. Previous progress:\n' + (owner.progress ?? []).filter(entry => entry.kind === 'text').slice(-3).map(entry => entry.text).join('\n').slice(-3000) : '';
        const spec = fullAccess(nodeSpec({ name: owner.title, prompt: instructions, model: route.model, provider: route.provider }, env));
        const effort = owner.reasoningEffort && Array.isArray(route.efforts) && !route.efforts.includes(owner.reasoningEffort) ? route.defaultEffort : owner.reasoningEffort;
        if (effort) spec.reasoningEffort = effort;
        spec.meta = { ...spec.meta, elpis: { ...spec.meta?.elpis, name: `Workflows · ${owner.title}`, workflow: { kind: owner.kind ?? 'verify', writeScopes: owner.writeScopes ?? [], ...(effort ? { reasoningEffort: effort } : {}) } } };
        const result = await runAcpNode(spec, { ...input, task: input.task + recovery }, { ...options,
          onSession: id => { owner.assignedThreadId = spec.elpis ? id : null; owner.sessionId = id; onSession?.(record, owner, id); void save(record).catch(() => {}); } });
        attempt.status = 'succeeded'; attempt.endedAt = Date.now(); return result;
      } catch (error) {
        attempt.status = 'failed'; attempt.reason = error.message; attempt.endedAt = Date.now();
        if (options.signal?.aborted || !quotaFailure(error)) throw error;
        unavailable.add(route.provider); previousError = error; await save(record);
      }
    }
    throw previousError ?? new BridgeError('No connected subscription has available quota. Choose another connected model and resume this workflow; completed work is preserved.', 409);
  }
  function supervise(record, task, error, root, controller) {
    const previous = supervision.get(record.id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => superviseNode(record, task, error, root, controller));
    supervision.set(record.id, pending); return pending;
  }
  async function superviseNode(record, task, error, root, controller) {
    if (controller.signal.aborted || task.supervisedRound === record.round) return false;
    task.supervisedRound = record.round;
    const mother = record.mother ??= { id: 'mother', title: 'Mother', model: 'claude/opus', provider: 'claude', reasoningEffort: 'low', progress: [], decisions: [] };
    mother.decisions ??= []; mother.status = 'running'; await save(record);
    try {
      const instructions = 'You are Mother, the active workflow supervisor. Inspect the failed node and current evidence. Read only; do not edit files, run agents, merge, install or change permissions. Return only JSON: {"action":"retry","taskId":"the failed node","instruction":"specific corrective guidance","reason":"evidence"}, {"action":"steer","taskId":"one currently running node","message":"specific guidance","reason":"evidence"}, or {"action":"stop","reason":"actionable recovery needed"}. Retry only when specific new guidance can address the failure. Never repeat an unchanged failing tool, alter scope, or claim success without checks.';
      const result = await runNode(record, mother, { model: 'claude/opus', provider: 'claude' }, instructions, { task: `Workflow: ${record.name}. Goal: ${record.goal ?? ''}. Failed node: ${task.id}. Failure: ${error.message}.\nCurrent nodes:\n${JSON.stringify(record.tasks.map(node => ({ id: node.id, status: node.status, instruction: node.instruction, evidence: node.result?.summary?.slice(0, 2000), failure: node.failureReason, recentProgress: node.progress?.slice(-3) }))).slice(0, 22000)}` }, {
        cwd: root.cwd, signal: controller.signal, timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
        onUpdate: update => progress(record, mother, update), onControl: control => controls.set(`${record.id}:mother`, control), onPermission: request => permission(record, mother, request),
      });
      let decision; try { decision = JSON.parse(result.answer.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new BridgeError('Mother could not give a valid recovery decision. Choose a model and resume the failed nodes.', 409); }
      if (!['retry', 'steer', 'stop'].includes(decision?.action) || typeof decision.reason !== 'string' || !decision.reason.trim()) throw new BridgeError('Mother did not give an actionable recovery decision. Choose a model and resume the failed nodes.', 409);
      const entry = { at: Date.now(), taskId: decision.taskId ?? task.id, decision: decision.action, reasons: decision.reason.slice(0, 2000) }; mother.decisions.push(entry);
      if (decision.action === 'retry') {
        if (decision.taskId !== task.id || typeof decision.instruction !== 'string' || !decision.instruction.trim() || decision.instruction.length > 4000) throw new BridgeError('Mother requested an invalid retry. Completed work was preserved.', 409);
        task.supervisorInstruction = decision.instruction.trim(); mother.status = 'succeeded'; await save(record); return true;
      }
      if (decision.action === 'steer') {
        const target = record.tasks.find(node => node.id === decision.taskId && node.id !== task.id && node.status === 'running'), control = target && controls.get(`${record.id}:${target.id}`);
        if (!control || typeof decision.message !== 'string' || !decision.message.trim() || decision.message.length > 4000) throw new BridgeError('Mother could not reach that running node. Resume the failed work after choosing a model.', 409);
        const delivered = await control.steer(decision.message.trim()); entry.delivery = delivered.delivery;
        (target.messages ??= []).push({ id: randomUUID(), text: decision.message.trim(), status: 'delivered', delivery: delivered.delivery, at: Date.now(), round: record.round, source: 'mother' });
      }
      mother.status = 'succeeded'; await save(record); return false;
    } catch (failure) {
      mother.status = controller.signal.aborted ? 'cancelled' : 'failed'; mother.failureReason = failure.message;
      mother.decisions.push({ at: Date.now(), taskId: task.id, decision: 'stop', reasons: failure.message }); await save(record); return false;
    } finally { controls.delete(`${record.id}:mother`); }
  }
  async function reviewAndMerge(record, signal) {
    if (await checkWorkflowReview(record.review, signal)) { record.review = await mergeWorkflowReview(record.review, signal); return; }
    const mother = record.mother = { ...record.mother, id: 'mother', title: 'Mother', model: 'claude/opus', provider: 'claude', reasoningEffort: 'low', status: 'running', progress: record.mother?.progress ?? [], decisions: record.mother?.decisions ?? [] };
    record.review.status = 'reviewing'; await save(record);
    try {
      const instructions = 'You are Mother, the workflow coordinator. Review the children’s candidate commits and focused test evidence. Read and run checks only; do not change files, commit, merge, delegate or push. Approve only if the requested task is complete and the checks pass. Return only JSON: {"passed":true or false,"summary":"observed evidence and any remaining failure"}.';
      const result = await runNode(record, mother, record.recovery?.model ? record.recovery : { model: mother.model, provider: mother.provider }, instructions, { task: `Review candidate commit ${record.review.commit}. Workflow: ${record.name}.\n${record.goal ?? ''}\n\nChange summary:\n${record.review.stat}`, inputs: record.tasks.map(task => ({ name: task.title, answer: task.result?.summary ?? task.failureReason ?? task.status })) }, {
        cwd: record.review.path, signal, timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
        onUpdate: update => progress(record, mother, update), onControl: control => controls.set(`${record.id}:mother`, control), onPermission: request => permission(record, mother, request),
      });
      let verdict;
      try { verdict = JSON.parse(result.answer.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* malformed review cannot authorize a merge */ }
      mother.result = { summary: result.answer, reviewedCommit: record.review.commit };
      if (verdict?.passed !== true || typeof verdict.summary !== 'string' || !verdict.summary.trim()) throw new BridgeError(`Mother did not approve: ${verdict?.summary || 'no passing review with evidence'}`, 409);
      if (await workflowCandidateChanged(record.review)) throw new BridgeError('Mother changed the candidate during review; nothing was merged', 409);
      record.review = await mergeWorkflowReview(record.review, signal); mother.status = 'succeeded';
    } catch (error) { mother.status = signal?.aborted ? 'cancelled' : 'failed'; mother.failureReason = error.message; record.review.status = 'ready'; record.review.error = error.message; throw error; }
    finally { controls.delete(`${record.id}:mother`); clearTimeout(progressTimers.get(record.id)); progressTimers.delete(record.id); await save(record); }
  }
  async function execute(record, root, controller, resuming = false) {
    let isolation;
    const inflight = new Set();
    try {
      isolation = record.isolation ? await workflowWorktrees(root.cwd, record.id, resuming ? record : undefined) : null;
      if (isolation) record.worktreeBase = isolation.base;
      let previous = new Map();
      for (let round = resuming ? record.round : 1; round <= (record.roundLimit ?? 1); round++) {
        record.round = round;
        const answers = new Map(), running = new Map();
        record.tasks.forEach(task => { if (resuming && round === record.round && task.status === 'succeeded') { answers.set(task.id, task.result.summary); return; } task.status = 'pending'; task.failureReason = null; task.assignedThreadId = null; task.result = null; });
        const byId = new Map(record.tasks.map(t => [t.id, t]));
        const run = async task => {
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
            const inputs = [...task.dependsOn.map(id => ({ name: byId.get(id).title, answer: answers.get(id) })),
              ...(round > 1 ? (task.feedbackFrom ?? []).map(id => ({ name: `${byId.get(id).title} · round ${round - 1}`, answer: previous.get(id) })) : [])];
            const requested = record.recovery?.model ? { model: record.recovery.model, provider: record.recovery.provider ?? root.modelProvider ?? '' } : { model: task.model ?? root.model ?? '', provider: task.provider ?? root.modelProvider ?? '' };
            const attempt = () => runNode(record, task, requested, instructions, { task: (record.roundLimit ? `Round ${round} of ${record.roundLimit}.\n` : '') + task.instruction + (task.supervisorInstruction ? `\n\nMother's corrective guidance:\n${task.supervisorInstruction}` : ''), inputs }, {
              cwd, signal: controller.signal, timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
              onPermission: request => permission(record, task, request), onUpdate: update => progress(record, task, update), onControl: control => { controls.set(`${record.id}:${task.id}`, control); },
            });
            let result;
            try { result = await attempt(); }
            catch (error) {
              task.failureReason = error.message;
              if (!await supervise(record, task, error, root, controller)) throw error;
              result = await attempt();
            }
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
        previous = answers; resuming = false;
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
        supervision.delete(record.id); routeSnapshots.delete(record.id); exhaustedProviders.delete(record.id); active.delete(record.rootThreadId); await fs.unlink(path.join(stateDir, `${record.rootThreadId}.lock`)).catch(() => {}); records.set(record.id, completed);
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
      const record = { ...structuredClone(params), projectCwd: root.cwd, id: randomUUID(), ownerPid: process.pid, status: 'running', startedAt: Date.now(), round: 1,
        tasks: params.tasks.map(task => ({ ...structuredClone(task), status: 'pending', assignedThreadId: null, result: null, failureReason: null })) };
      const controller = new AbortController(); active.set(params.rootThreadId, controller); records.set(record.id, record);
      try { await save(record); } catch (error) { record.status = 'failed'; record.error = error.message; active.delete(params.rootThreadId); await fs.unlink(lock); throw error; }
      void execute(record, root, controller).catch(error => console.error('Could not save ACP workflow state:', error.message));
      return { graphId: record.id, threadId: params.rootThreadId, turnId: record.id };
    },
    async resume(id, root, overrides = {}) {
      await load(); const record = records.get(id);
      if (!record) throw new BridgeError('Workflow not found', 404);
      if (!['failed', 'blocked', 'cancelled'].includes(record.status)) throw new BridgeError('Only failed or stopped workflow nodes need recovery', 409);
      if (active.has(record.rootThreadId) || mergeControllers.has(record.rootThreadId)) throw new BridgeError('This workflow is already running', 409);
      if (record.tasks.some(task => task.status === 'succeeded' && typeof task.result?.summary !== 'string')) throw new BridgeError('Completed workflow evidence is incomplete. Saved work was preserved; inspect the run before recovery.', 409);
      if (overrides.model) record.recovery = { model: overrides.model, ...(overrides.provider ? { provider: overrides.provider } : {}), at: Date.now() };
      if (record.tasks.every(task => task.status === 'succeeded') && record.review?.status === 'ready') { await this.merge(id); return { graphId: record.id, threadId: record.rootThreadId, turnId: record.id }; }
      if (!path.isAbsolute(root.cwd ?? '')) throw new BridgeError('Choose the workflow project before recovery');
      root = { ...root, cwd: await fs.realpath(root.cwd) };
      const originalCwd = record.projectCwd ?? (!record.isolation ? record.tasks.find(task => task.cwd)?.cwd : undefined);
      if (originalCwd && root.cwd !== originalCwd) throw new BridgeError('Recover this workflow in its original project. Its work and results have been preserved.', 409);
      record.projectCwd ??= root.cwd;
      const lock = path.join(stateDir, `${record.rootThreadId}.lock`);
      try { const handle = await fs.open(lock, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close(); }
      catch (error) { if (error.code !== 'EEXIST') throw error; const pid = Number(await fs.readFile(lock, 'utf8')); if (alive(pid)) throw new BridgeError('A workflow is already running in this conversation', 409); await fs.unlink(lock); return this.resume(id, root, overrides); }
      record.status = 'running'; record.ownerPid = process.pid; record.resumedAt = Date.now(); delete record.endedAt; delete record.error;
      if (overrides.model) record.recovery = { model: overrides.model, ...(overrides.provider ? { provider: overrides.provider } : {}), at: Date.now() };
      for (const task of record.tasks) if (task.status !== 'succeeded') delete task.supervisedRound;
      routeSnapshots.delete(id); exhaustedProviders.delete(id);
      const controller = new AbortController(); active.set(record.rootThreadId, controller);
      try { await save(record); } catch (error) { active.delete(record.rootThreadId); record.status = 'failed'; await fs.unlink(lock); throw error; }
      void execute(record, root, controller, true).catch(error => console.error('Could not save recovered workflow state:', error.message));
      return { graphId: record.id, threadId: record.rootThreadId, turnId: record.id };
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
