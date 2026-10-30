import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const WORKFLOW_CONCURRENCY_CHOICES = Object.freeze([1, 2, 3, 4]);
export const DEFAULT_WORKFLOW_CONCURRENCY = 4;
const fileFor = home => path.join(home, 'workflow-concurrency.json');

export function readWorkflowConcurrency(home) {
  try {
    const value = JSON.parse(fs.readFileSync(fileFor(home), 'utf8'));
    if (value?.version !== 1 || !WORKFLOW_CONCURRENCY_CHOICES.includes(value.concurrency)) throw new Error('Invalid value');
    return value.concurrency;
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_WORKFLOW_CONCURRENCY;
    throw new Error('Could not read workflow concurrency.');
  }
}

/** A damaged setting must never raise the number of workers. */
export function safeWorkflowConcurrency(home) {
  try { return readWorkflowConcurrency(home); } catch { return 1; }
}

export async function saveWorkflowConcurrency(home, value) {
  if (!WORKFLOW_CONCURRENCY_CHOICES.includes(value)) throw new Error('Choose a workflow concurrency from the list.');
  await fs.promises.mkdir(home, { recursive: true, mode: 0o700 });
  const file = fileFor(home), temporary = `${file}.${randomUUID()}.pending`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify({ version: 1, concurrency: value }), { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temporary, file);
  } finally { await fs.promises.unlink(temporary).catch(() => {}); }
  return value;
}
