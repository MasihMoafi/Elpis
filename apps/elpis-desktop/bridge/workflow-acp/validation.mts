import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from '../validate.mts';
import type { WorkflowTask } from './types.mts';
import { writer } from './status.mts';

/** A write scope as a folder inside `base`, made when missing (each agent's own folder is new on its first run). The
 * nearest folder that exists must already be inside `base`, so a link out of the project creates nothing. */
export async function projectFolder(base: string, scope: string) {
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
