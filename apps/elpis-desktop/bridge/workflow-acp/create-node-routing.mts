import type { ModelRoute } from "./types.mts";
import type { createRunProgress } from "./create-run-progress.mts";
import type { createRunStorage } from "./create-run-storage.mts";
import { randomUUID } from "node:crypto";
import { BridgeError } from "../validate.mts";
import { runAcpNode } from "../acp-nodes.mts";
import { workflowRoute, quotaFailure, quotaStopLine } from "../workflow-models.mts";
import type {
  RouteAttempt,
  StoredTask,
  Mother,
  WorkflowRecord,
  NodeInput,
  NodeOptions,
  RequestedRoute,
  WorkflowOptions,
} from "./types.mts";

export function createNodeRouting({
  modelRoutes,
  routeSnapshots,
  exhaustedProviders,
  progress,
  save,
  nodeSpec,
  env,
  onSession,
}: {
  modelRoutes: WorkflowOptions["modelRoutes"];
  routeSnapshots: Map<string, Promise<ModelRoute[]>>;
  exhaustedProviders: Map<string, Set<string>>;
  progress: ReturnType<typeof createRunProgress>["progress"];
  save: ReturnType<typeof createRunStorage>["save"];
  nodeSpec: NonNullable<WorkflowOptions["nodeSpec"]>;
  env: NonNullable<WorkflowOptions["env"]>;
  onSession: WorkflowOptions["onSession"];
}) {
  const lowEffort = (route: { efforts?: string[] | undefined }) =>
    ["low", "minimal", "none"].find(effort => route.efforts?.includes(effort));

  const fullAccess = (spec: Parameters<typeof runAcpNode>[0]) => {
    // Keep the provider's checks active; the permission callback answers automatic agents.
    if (!spec.elpis && !spec.instructionsInPrompt) spec.mode = "default";
    return spec;
  };

  async function routesFor(record: WorkflowRecord) {
    if (!modelRoutes) return [];
    if (!routeSnapshots.has(record.id))
      routeSnapshots.set(
        record.id,
        Promise.resolve()
          .then(() => modelRoutes())
          .catch(() => []),
      );
    return routeSnapshots.get(record.id)!;
  }

  async function runNode(
    record: WorkflowRecord,
    owner: StoredTask | Mother,
    requested: RequestedRoute,
    instructions: string,
    input: NodeInput,
    options: NodeOptions,
  ) {
    const available = await routesFor(record),
      routes = options.lowEffort ? available.filter(lowEffort) : available,
      requestedRoute = workflowRoute(requested.model, requested.provider);
    // The requested route only, with what the snapshot knows of it (its quota, efforts). An agent never moves to another
    // subscription on its own (E17, 11 Nov, Masih: "I never permitted opus"): without quota it stops and says why.
    const route = {
      ...routes.find(route => route.provider === requestedRoute.provider),
      ...routes.find(route => route.model === requestedRoute.model && route.provider === requestedRoute.provider),
      ...requestedRoute,
    };
    // Routes ("provider:model") that answered with a quota error earlier in this run: later agents asking for one stop
    // without a call. Kept per model, so the Mother's Sonnet fallback on the same subscription is still tried.
    const unavailable = exhaustedProviders.get(record.id) ?? new Set();
    exhaustedProviders.set(record.id, unavailable);
    const key = `${route.provider}:${route.model}`;
    const routing = (owner.routing ??= { requested: requestedRoute, actual: null, attempts: [] });
    const attempt: RouteAttempt = {
      model: route.model,
      provider: route.provider,
      status: "running",
      startedAt: Date.now(),
    };
    routing.attempts.push(attempt);
    const stop = (during: boolean) => {
      const line = quotaStopLine(route, during, during ? null : route.resetsAt);
      progress(record, owner, {
        sessionUpdate: "agent_message_chunk",
        messageId: `route-${randomUUID()}`,
        content: { type: "text", text: line },
      });
      return Object.assign(new BridgeError(line, 409), { quotaStop: true });
    };
    if (route.exhausted || unavailable.has(key)) {
      attempt.status = "skipped";
      attempt.reason = route.reason || "This model reached its usage limit earlier in this run";
      attempt.endedAt = Date.now();
      throw stop(false);
    }
    routing.actual = { model: route.model, provider: route.provider };
    await save(record);
    let sessionEnded: (() => void) | undefined; // what onSession returned, called once this attempt's ACP agent has left
    try {
      const spec = fullAccess(
        nodeSpec({ name: owner.title, prompt: instructions, model: route.model, provider: route.provider }, env),
      );
      const effort = options.lowEffort
        ? lowEffort(route)
        : owner.reasoningEffort && Array.isArray(route.efforts) && !route.efforts.includes(owner.reasoningEffort)
          ? route.defaultEffort
          : owner.reasoningEffort;
      if (effort) spec.reasoningEffort = effort;
      spec.meta = {
        ...spec.meta,
        elpis: {
          ...spec.meta?.elpis,
          name: `Workflows · ${owner.title}`,
          workflow: {
            kind: owner.kind ?? "verify",
            writeScopes: owner.writeScopes ?? [],
            ...(effort ? { reasoningEffort: effort } : {}),
            ...(owner.serviceTier ? { serviceTier: owner.serviceTier } : {}),
          },
        },
      };
      const result = await runAcpNode(spec, input, {
        ...options,
        // Every chat a step or Mother opens is kept, not only the latest (28 Oct: earlier review and retry chats fell out of
        // their workflow and lay loose in the sidebar: "currently they are all merged").
        onSession: id => {
          owner.assignedThreadId = spec.elpis ? id : null;
          owner.sessionId = id;
          if (spec.elpis) owner.threads = [...new Set([...(owner.threads ?? []), id])];
          sessionEnded = onSession?.(record, owner, id) as (() => void) | undefined;
          void save(record).catch(() => {});
        },
      });
      attempt.status = "succeeded";
      attempt.endedAt = Date.now();
      return result;
    } catch (error) {
      attempt.status = "failed";
      attempt.reason = (error as Error).message;
      attempt.endedAt = Date.now();
      if (options.signal?.aborted || !quotaFailure(error)) throw error;
      unavailable.add(key);
      throw stop(true);
    } finally {
      sessionEnded?.();
    }
  }

  return { runNode };
}
