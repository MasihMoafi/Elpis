import { BridgeError, object, text, threadId } from "./validate.mts";
import path from "node:path";
import { internal_rpc } from "./client-rpc.mts";
import type { DesktopClient } from "./client.mts";
import type { ClientState } from "./client-state.mts";

// Native refusals the person can act on (a fork still referencing a chat, a busy agent) are shown as Elpis wrote them.
export const scriptRunId = (value: unknown) => {
  if (typeof value !== "string" || !/^wf_[0-9a-f-]{36}$/.test(value)) throw new BridgeError("Invalid workflow run ID");
  return value;
};

// Workflows that run until they finish (SPEC WR7): the runtime's script runs, started from a chat or from here.
export async function impl_scriptRuns(this: DesktopClient, clientState: ClientState, threadIdValue?: unknown) {
  if (threadIdValue !== undefined) threadId(threadIdValue);
  return internal_rpc(this, clientState, "workflowRun/list", threadIdValue ? { threadId: threadIdValue } : {});
}

export async function impl_scriptRun(this: DesktopClient, clientState: ClientState, runId: unknown) {
  return internal_rpc(this, clientState, "workflowRun/read", { runId: scriptRunId(runId) });
}

export async function impl_startScriptRun(this: DesktopClient, clientState: ClientState, raw: unknown) {
  const body = object(raw, ["threadId", "script", "scriptPath", "args", "resumeFromRunId", "budget"]) as Record<
    string,
    unknown
  >;
  threadId(body.threadId);
  if (body.script === undefined && body.scriptPath === undefined)
    throw new BridgeError("Give the workflow script or its saved path");
  if (body.script !== undefined) text(body.script, "workflow script", 1_000_000);
  if (body.scriptPath !== undefined && !path.isAbsolute(text(body.scriptPath, "script path", 4096)))
    throw new BridgeError("Give an absolute script path");
  if (body.resumeFromRunId !== undefined) scriptRunId(body.resumeFromRunId);
  return internal_rpc(this, clientState, "workflowRun/start", body);
}

export async function impl_stopScriptRun(this: DesktopClient, clientState: ClientState, runId: unknown) {
  return internal_rpc(this, clientState, "workflowRun/stop", { runId: scriptRunId(runId) });
}

export async function impl_resumeScriptRun(this: DesktopClient, clientState: ClientState, runId: unknown) {
  return internal_rpc(this, clientState, "workflowRun/resume", { runId: scriptRunId(runId) });
}

export async function impl_skipScriptAgent(
  this: DesktopClient,
  clientState: ClientState,
  runId: unknown,
  agentId: unknown,
) {
  if (typeof agentId !== "string" || !/^a[0-9a-f]{16}$/.test(agentId)) throw new BridgeError("Invalid agent ID");
  return internal_rpc(this, clientState, "workflowRun/skip", { runId: scriptRunId(runId), agentId });
}
