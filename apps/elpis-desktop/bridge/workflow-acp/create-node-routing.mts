import type { ModelRoute } from "./types.mts";
import type { createRunProgress } from "./create-run-progress.mts";
import type { createRunStorage } from "./create-run-storage.mts";
import { randomUUID } from "node:crypto";
import { BridgeError } from "../validate.mts";
import { runAcpNode, handoffText } from "../acp-nodes.mts";
import { workflowRoute, quotaFailure } from "../workflow-models.mts";
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
  cloudroom,
}: {
  modelRoutes: WorkflowOptions["modelRoutes"];
  routeSnapshots: Map<string, Promise<ModelRoute[]>>;
  exhaustedProviders: Map<string, Set<string>>;
  progress: ReturnType<typeof createRunProgress>["progress"];
  save: ReturnType<typeof createRunStorage>["save"];
  nodeSpec: NonNullable<WorkflowOptions["nodeSpec"]>;
  env: NonNullable<WorkflowOptions["env"]>;
  onSession: WorkflowOptions["onSession"];
  cloudroom: WorkflowOptions["cloudroom"];
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
    const desired = {
      ...routes.find(route => route.provider === requestedRoute.provider),
      ...routes.find(route => route.model === requestedRoute.model && route.provider === requestedRoute.provider),
      ...requestedRoute,
    };
    const candidates = [desired, ...routes.filter(route => route.provider !== desired.provider)],
      seen = new Set();
    const unavailable = exhaustedProviders.get(record.id) ?? new Set();
    exhaustedProviders.set(record.id, unavailable);
    const routing = (owner.routing ??= { requested: requestedRoute, actual: null, attempts: [] });
    let previousError: unknown;
    for (const route of candidates) {
      if (seen.has(route.provider)) continue;
      seen.add(route.provider);
      const attempt: RouteAttempt = {
        model: route.model,
        provider: route.provider,
        status: "running",
        startedAt: Date.now(),
      };
      routing.attempts.push(attempt);
      if (route.exhausted || unavailable.has(route.provider)) {
        attempt.status = "skipped";
        attempt.reason = route.reason || "This subscription reached its usage limit";
        attempt.endedAt = Date.now();
        progress(record, owner, {
          sessionUpdate: "agent_message_chunk",
          messageId: `route-${randomUUID()}`,
          content: { type: "text", text: `Skipped ${route.model || route.provider}: ${attempt.reason}` },
        });
        continue;
      }
      routing.actual = { model: route.model, provider: route.provider };
      if (route.model !== requestedRoute.model || route.provider !== requestedRoute.provider) {
        attempt.reason =
          (previousError as { message?: string } | undefined)?.message || "The requested subscription is unavailable";
        progress(record, owner, {
          sessionUpdate: "agent_message_chunk",
          messageId: `route-${randomUUID()}`,
          content: { type: "text", text: `Continuing with ${route.model} (${route.provider}). ${attempt.reason}` },
        });
      }
      await save(record);
      let sessionEnded: (() => void) | undefined; // what onSession returned, called once this attempt's ACP agent has left
      try {
        const recovery = previousError
          ? "\n\nA previous attempt reached its subscription limit. Continue in this same workspace. Inspect existing files before acting; preserve completed work and do not repeat actions already evidenced there. Previous progress:\n" +
            (owner.progress ?? [])
              .filter(entry => entry.kind === "text")
              .slice(-3)
              .map(entry => entry.text)
              .join("\n")
              .slice(-3000)
          : "";
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
        const result = await runAcpNode(
          spec,
          { ...input, task: input.task + recovery },
          {
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
          },
        );
        attempt.status = "succeeded";
        attempt.endedAt = Date.now();
        return result;
      } catch (error) {
        attempt.status = "failed";
        attempt.reason = (error as Error).message;
        attempt.endedAt = Date.now();
        if (options.signal?.aborted || !quotaFailure(error)) throw error;
        unavailable.add(route.provider);
        previousError = error;
        await save(record);
      } finally {
        sessionEnded?.();
      }
    }
    throw (previousError ??
      new BridgeError(
        "No connected subscription has available quota. Choose another connected model and resume this workflow; completed work is preserved.",
        409,
      )) as Error;
  }

  /** "Runs on: CloudRoom VM" (1 Nov, Masih: "I asked if we can use cloud room's vms for our agents"): the agent's worktree
   * is copied to his CloudRoom VM, the CLI its provider needs (Claude Code or Codex) runs there, and its changes come back
   * into the worktree. The Mother's review and merge stay on this computer. Answers the same shape as runAcpNode. */
  async function runOnCloudroom(
    record: WorkflowRecord,
    owner: StoredTask | Mother,
    requested: RequestedRoute,
    instructions: string,
    input: NodeInput,
    options: NodeOptions,
  ) {
    const route = workflowRoute(requested.model, requested.provider);
    const attempt: RouteAttempt = {
      model: route.model,
      provider: route.provider,
      runsOn: "cloudroom",
      status: "running",
      startedAt: Date.now(),
    };
    const routing = (owner.routing ??= { requested: route, actual: null, attempts: [] });
    routing.actual = { model: route.model, provider: route.provider };
    routing.attempts.push(attempt);
    await save(record);
    const say = (text: string) =>
      progress(record, owner, {
        sessionUpdate: "agent_message_chunk",
        messageId: `cloudroom-${randomUUID()}`,
        content: { type: "text", text },
      });
    // A connected agent's whole answer is in a file on this computer, which the VM cannot read: it gets the summary.
    const prompt = handoffText(
      input.task,
      (input.inputs ?? []).map(({ name, answer }) => ({ name, answer })),
      instructions,
    );
    try {
      const result = await cloudroom!.runAgent({
        localDir: options.cwd,
        key: `${record.id}-${owner.id}-r${record.round}`,
        provider: route.provider,
        model: route.model,
        effort: owner.reasoningEffort,
        prompt,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        onStatus: say,
      });
      say(
        `CloudRoom VM: ${result.changed} changed and ${result.deleted} deleted ${result.changed + result.deleted === 1 ? "file" : "files"} copied back.`,
      );
      attempt.status = "succeeded";
      attempt.endedAt = Date.now();
      return { answer: result.answer };
    } catch (error) {
      attempt.status = "failed";
      attempt.reason = (error as Error).message;
      attempt.endedAt = Date.now();
      throw error;
    }
  }
  return { runNode, runOnCloudroom };
}
