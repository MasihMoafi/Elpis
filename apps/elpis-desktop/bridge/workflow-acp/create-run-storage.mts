import fs from 'node:fs/promises';
import path from 'node:path';
import { removeWorkflowWorkspace } from '../workflow-worktrees.mts';
import type { WorkflowRecord, WorkflowOptions } from './types.mts';
import { ended } from './status.mts';
import { alive } from './locks.mts';

export function createRunStorage({ stateDir, records }: {
  stateDir: NonNullable<WorkflowOptions['stateDir']>;
  records: Map<string, WorkflowRecord>
}) {

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
  return { save, freeRun, load, gone };
}
