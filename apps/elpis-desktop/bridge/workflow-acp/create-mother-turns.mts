import type { createNodeRouting } from './create-node-routing.mts';
import type { createRunProgress } from './create-run-progress.mts';
import { randomUUID } from 'node:crypto';
import type { WorkflowRecord, NodeInput, NodeOptions, RequestedRoute } from './types.mts';

export function createMotherTurns({ runNode, progress }: {
  runNode: ReturnType<typeof createNodeRouting>['runNode'];
  progress: ReturnType<typeof createRunProgress>['progress']
}) {

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
  return { motherRoute, motherOf, askMother };
}
