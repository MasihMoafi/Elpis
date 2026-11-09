import type { DesktopClient } from "./client.mts";
import type { DesktopClientOptions } from "./client-options.mts";
import { createWorkflowRuns } from "./workflow-acp.mts";
import path from "node:path";
import { workflowDefaults, workflowModelRoutes } from "./workflow-models.mts";
import { ClientState } from "./client-state.mts";
import { internal_rpc } from "./client-rpc.mts";
import { internal_releaseNode } from "./client-rewind.mts";
import { internal_workflowEnded } from "./client-workflows.mts";
import type { FinishedWorkflow } from "./client-workflows.mts";

type WorkflowRunSetup = {
  profileHome: string;
  cloudroom: unknown;
  workflowOptions: DesktopClientOptions["workflowOptions"];
  workflowEnv: NodeJS.ProcessEnv;
};

/** The client's workflow engine: its store, its sessions and the model routes it may use. */
export function createClientWorkflowRuns(
  client: DesktopClient,
  state: () => ClientState,
  { profileHome, cloudroom, workflowOptions, workflowEnv }: WorkflowRunSetup,
) {
  return (createWorkflowRuns as (options: Record<string, unknown>) => ReturnType<typeof createWorkflowRuns>)({
    stateDir: path.join(profileHome, "desktop-workflows"),
    cloudroom,
    onSession: (_record: unknown, _task: unknown, id: string) => {
      state().known.add(id);
      return () => void internal_releaseNode.call(client, state(), id);
    },
    onEnd: (record: FinishedWorkflow) => internal_workflowEnded.call(client, state(), record),
    observeThread: (id: unknown) => client.readThreadMetadata(id),
    listThreadDescendants: (options: Parameters<DesktopClient["listThreads"]>[0]) => client.listThreads(options),
    modelRoutes: async () => {
      const [catalog, providers, policy] = await Promise.all([
        client.models(),
        client.providers(),
        internal_rpc(client, state(), "configRequirements/read", {}).catch(() => null),
      ]);
      // Unknown managed policy cannot authorize a different connection.
      return policy === null
        ? []
        : workflowModelRoutes(
            catalog.data ?? [],
            providers,
            policy.requirements as Parameters<typeof workflowModelRoutes>[2],
          );
    },
    // Default models for a run's agents, from the real catalogue: Antigravity's and Claude's in the main list.
    // A list that cannot be read in time leaves its default empty, so the run keeps its earlier choice.
    modelDefaults: async () => {
      // The fallback timer is cleared once the list arrives, so a closed client never waits 15 s to exit.
      const within = <T,>(promise: Promise<T>): Promise<T | null> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          promise,
          new Promise<null>(resolve => {
            timer = setTimeout(resolve, 15000, null);
          }),
        ])
          .catch(() => null)
          .finally(() => clearTimeout(timer));
      };
      return workflowDefaults((await within(client.models()))?.data ?? []);
    },
    ...workflowOptions,
    env: workflowEnv,
  });
}
