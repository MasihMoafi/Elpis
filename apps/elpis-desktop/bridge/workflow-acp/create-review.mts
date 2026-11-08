import type { MotherRuntime } from './mother-runtime.mts';

import { BridgeError } from '../validate.mts';
import { mergeWorkflowReview, checkWorkflowReview, workflowCandidateChanged } from '../workflow-worktrees.mts';
import type { ReadyReview, WorkflowRecord } from './types.mts';

export function createReview({ motherRoute, motherOf, save, askMother, handed, timeoutMs, progress, controls, permission, progressTimers }: MotherRuntime & {
  progressTimers: Map<string, NodeJS.Timeout>
}) {

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
  return { reviewAndMerge };
}
