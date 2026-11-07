import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from '../client.mts';
import type { HistoryRun } from './types.mts';
import { ended } from './status.mts';

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
