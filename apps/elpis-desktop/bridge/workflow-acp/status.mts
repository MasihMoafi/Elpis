import type { WorkflowTask } from './types.mts';

export const ended = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);

export const writer = (task: WorkflowTask) => ['implement', 'fix'].includes(task.kind);

/** Done for the run: it succeeded, or the Mother cancelled it as no longer needed (its dependents go on without it). */
export const settled = (task: WorkflowTask) => task.status === 'succeeded' || task.status === 'cancelled' && task.cancelledBy === 'mother';
