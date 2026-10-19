import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './client.mjs';
import { loveNodeSpec } from './love-agents.mjs';
import { runAcpNode } from './acp-nodes.mjs';
import { workflowWorktrees } from './workflow-worktrees.mjs';

const ended = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);
const writer = task => ['implement', 'fix'].includes(task.kind);
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

/** Validate the complete graph before starting any ACP process. Feedback is from a previous bounded round. */
export function validateWorkflow(tasks, roundLimit) {
  const ids = new Set(tasks.map(t => t.id));
  if (ids.size !== tasks.length || tasks.some(t => !/^[A-Za-z0-9_-]{1,100}$/.test(t.id))) throw new BridgeError('Task IDs must be unique letters, digits, hyphens or underscores');
  if (roundLimit !== undefined && (!Number.isSafeInteger(roundLimit) || roundLimit < 1 || roundLimit > 100)) throw new BridgeError('Choose a round limit from 1 to 100');
  for (const task of tasks) {
    if ([...task.dependsOn, ...(task.feedbackFrom ?? [])].some(id => !ids.has(id))) throw new BridgeError('A task dependency is missing');
    if (task.feedbackFrom?.length && roundLimit === undefined) throw new BridgeError('Recursive feedback needs an explicit round limit');
    if (writer(task) && (!task.writeScopes.length || !tasks.some(check => check.kind === 'verify' && check.dependsOn.includes(task.id)))) throw new BridgeError('Every writer needs folders and a directly dependent read-only check');
    if (!writer(task) && task.writeScopes.length) throw new BridgeError('Read-only tasks cannot have write scopes');
  }
  const done = new Set();
  while (done.size < tasks.length) {
    const next = tasks.filter(t => !done.has(t.id) && t.dependsOn.every(id => done.has(id)));
    if (!next.length) throw new BridgeError('The workflow has a loop. Use previous-round feedback with a round limit.');
    next.forEach(t => done.add(t.id));
  }
}

/** ACP owns node execution. This scheduler owns Kahn dependencies, bounded rounds, concurrency and failure state. */
export function createWorkflowRuns({ stateDir, nodeSpec = loveNodeSpec, env = process.env, timeoutMs,
  onPermission, onSession } = {}) {
  const records = new Map(), active = new Map();
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
            const scopes = [];
            for (const scope of task.writeScopes) {
              if (path.isAbsolute(scope) || scope.split(/[\\/]/).includes('..')) throw new BridgeError('Write scopes must stay inside the project');
              const resolved = await fs.realpath(path.join(cwd, scope));
              if (resolved !== cwd && !resolved.startsWith(`${await fs.realpath(cwd)}${path.sep}`)) throw new BridgeError('A write scope points outside the project');
              if (!(await fs.stat(resolved)).isDirectory()) throw new BridgeError('A write scope must be a folder');
              scopes.push(scope);
            }
            const instructions = [`Acceptance criteria:\n${task.acceptanceCriteria.map(c => `- ${c}`).join('\n')}`,
              writer(task) ? `Write only in: ${scopes.join(', ')}.` : 'Read only. Do not change files.',
              task.kind === 'verify' ? 'Return only JSON: {"passed": true or false, "summary": "criteria and observed evidence"}. Set passed false if any criterion fails or cannot be checked.' : 'Return your final answer with observed evidence.'].join('\n\n');
            const spec = nodeSpec({ name: task.title, prompt: instructions, model: task.model ?? root.model ?? '', provider: task.provider ?? root.modelProvider ?? '' }, env);
            spec.meta = { ...spec.meta, elpis: { ...spec.meta?.elpis, name: `Workflows · ${task.title}`, workflow: { kind: task.kind, writeScopes: scopes, ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}) } } };
            const inputs = [...task.dependsOn.map(id => ({ name: byId.get(id).title, answer: answers.get(id) })),
              ...(round > 1 ? (task.feedbackFrom ?? []).map(id => ({ name: `${byId.get(id).title} · round ${round - 1}`, answer: previous.get(id) })) : [])];
            const result = await runAcpNode(spec, { task: record.roundLimit ? `Round ${round} of ${record.roundLimit}.\n${task.instruction}` : task.instruction, inputs }, {
              cwd, signal: controller.signal, timeoutMs: Math.min(timeoutMs ?? Infinity, (record.maxRuntimeSeconds ?? 1800) * 1000),
              onPermission: request => onPermission?.(record, task, request, permissionScope.signal),
              onSession: id => { task.assignedThreadId = spec.elpis ? id : null; task.sessionId = id; onSession?.(record, task, id); void save(record).catch(() => {}); },
            });
            if (task.kind === 'verify') {
              let verdict;
              try { verdict = JSON.parse(result.answer.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* invalid check cannot pass */ }
              if (verdict?.passed !== true || typeof verdict.summary !== 'string' || !verdict.summary.trim()) throw new BridgeError(`Check failed: ${verdict?.summary || 'the agent did not return a passing check with evidence'}`, 409);
            }
            if (isolation) await isolation.complete(task, round);
            answers.set(task.id, result.answer); task.result = { summary: result.answer }; task.status = 'succeeded';
          } catch (error) {
            task.status = controller.signal.aborted ? 'cancelled' : 'failed'; task.failureReason = error.message;
          }
          permissionScope.abort();
          await save(record);
        };
        while (record.tasks.some(t => !ended.has(t.status))) {
          for (const task of record.tasks.filter(t => t.status === 'pending')) {
            if (controller.signal.aborted) { task.status = 'cancelled'; continue; }
            if (task.dependsOn.some(id => ['failed', 'blocked', 'cancelled'].includes(byId.get(id).status))) { task.status = 'blocked'; continue; }
            if (running.size >= (record.maxConcurrency ?? 3) || !task.dependsOn.every(id => byId.get(id).status === 'succeeded')) continue;
            if (writer(task) && record.tasks.some(other => running.has(other.id) && writer(other) && task.writeScopes.some(a => other.writeScopes.some(b => a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))))) continue;
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
      if (status === 'succeeded' && isolation) await isolation.integrate(controller.signal);
      record.status = status;
    } catch (error) {
      const cancelled = controller.signal.aborted; controller.abort(); await Promise.allSettled(inflight);
      record.status = cancelled ? 'cancelled' : 'failed'; record.error = error.message;
    }
    finally {
      record.tasks.forEach(task => { if (!ended.has(task.status)) task.status = record.status === 'cancelled' ? 'cancelled' : 'blocked'; });
      record.endedAt = Date.now();
      if (isolation) record.worktrees = isolation.paths();
      const completed = { ...record }; record.status = 'running';
      try { await save(completed); }
      catch (error) { completed.status = 'failed'; completed.error = `Could not save the workflow result: ${error.message}`; }
      finally { active.delete(record.rootThreadId); await fs.unlink(path.join(stateDir, `${record.rootThreadId}.lock`)).catch(() => {}); records.set(record.id, completed); }
    }
  }
  return {
    busy: () => active.size > 0,
    async list(rootThreadId) { await load(); return structuredClone([...records.values()].filter(r => r.rootThreadId === rootThreadId)); },
    async start(params, root) {
      validateWorkflow(params.tasks, params.roundLimit); await load();
      if (!path.isAbsolute(root.cwd ?? '')) throw new BridgeError('Choose a project folder before running a workflow');
      root = { ...root, cwd: await fs.realpath(root.cwd) };
      for (const task of params.tasks) for (const scope of task.writeScopes) {
        if (path.isAbsolute(scope) || scope.split(/[\\/]/).includes('..')) throw new BridgeError('Invalid write scope');
        const resolved = await fs.realpath(path.join(root.cwd, scope));
        if (resolved !== root.cwd && !resolved.startsWith(`${root.cwd}${path.sep}`) || !(await fs.stat(resolved)).isDirectory()) throw new BridgeError('Write scopes must be project folders');
      }
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
    cancel(rootThreadId) { const controller = active.get(rootThreadId); if (!controller) return false; controller.abort(); return true; },
    close() { for (const controller of active.values()) controller.abort(); },
  };
}
