import { randomUUID } from "node:crypto";
import { BridgeError, object, text } from "./validate.mts";
import { elpisHome } from "./client-paths.mts";
import { planCanvas } from "./canvas-plan.mts";
import { workflowWorkspace } from "./folders.mts";
import { body, json } from "./server-http.mts";

const START_WAIT = 15 * 60_000;

export type ScheduledWorkflowJob = {
  taskId: string;
  title: string;
  request: string;
  cwd: string;
  workflow: { id: string; name: string; board: unknown };
};

/** A scheduled workflow runs in an open window (6 Nov, Masih chose the board replay): the service announces it, the
 * first window to claim it starts the saved board out of sight and reports the run's chat. */
export function createWorkflowDispatcher({
  event,
  claimWait = 60_000,
}: {
  event: (payload: { type: string; data: unknown }) => void;
  claimWait?: number;
}) {
  const workflowJobs = new Map<
    unknown,
    {
      taskId: string;
      claimed: boolean;
      settle: (error: string | null, threadId?: string) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  return {
    dispatch(job: ScheduledWorkflowJob): Promise<{ threadId: string }> {
      return new Promise((resolve, reject) => {
        const token = randomUUID();
        const settle = (error: string | null, threadId?: string) => {
          const pending = workflowJobs.get(token);
          if (!pending) return;
          clearTimeout(pending.timer);
          workflowJobs.delete(token);
          if (error) reject(new Error(error));
          else resolve({ threadId: threadId as string });
        };
        workflowJobs.set(token, {
          taskId: job.taskId,
          claimed: false,
          settle,
          timer: setTimeout(() => settle("No Elpis window was open to run it"), claimWait),
        });
        event({
          type: "automationWorkflow",
          data: {
            token,
            taskId: job.taskId,
            title: job.title,
            request: job.request,
            cwd: job.cwd,
            workflow: { id: job.workflow.id, name: job.workflow.name },
            board: job.workflow.board,
          },
        });
      });
    },
    handleAction(id: string, action: "claim" | "result", fields: Record<string, unknown>) {
      const job = workflowJobs.get(fields.token);
      if (!job || job.taskId !== id) return { granted: false };
      if (action === "claim") {
        object(fields, ["token"]);
        if (job.claimed) return { granted: false };
        job.claimed = true;
        clearTimeout(job.timer);
        job.timer = setTimeout(() => job.settle("The window did not report whether the workflow started"), START_WAIT);
        return { granted: true };
      }
      object(fields, ["token", "threadId", "error"]);
      if (typeof fields.threadId === "string") job.settle(null, text(fields.threadId, "chat", 200));
      else job.settle(text(fields.error ?? "The workflow did not start", "error", 2000));
      return { recorded: true };
    },
    close() {
      for (const job of workflowJobs.values()) job.settle("Elpis closed before the workflow started");
    },
  };
}

export async function handleWorkflowRoutes(
  state: import("./server-http.mts").ServerState,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  url: URL,
  method: string,
) {
  const { client, options, experimentLab, automations, workflowDispatcher } = state;
  if (url.pathname === "/api/canvas/plan" && method === "POST") {
    // Stop in the app closes this request, which ends the planner's background turn.
    const stop = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) stop.abort();
    });
    json(response, 200, await planCanvas(client, await body(request), { signal: stop.signal }));
    return true;
  }
  if (url.pathname === "/api/experiment-lab") {
    if (method === "GET") {
      json(response, 200, {
        record: await experimentLab.read(url.searchParams.get("id") || undefined),
        entries: await experimentLab.list(),
      });
      return true;
    }
    const input = await body(request);
    if (input?.action === "stop") {
      object(input, ["action"]);
      json(response, 200, { record: await experimentLab.stop(), entries: await experimentLab.list() });
      return true;
    }
    json(response, 200, { record: await experimentLab.start(input), entries: await experimentLab.list() });
    return true;
  }
  // GET lists them, POST creates one; POST to one task { action: 'update' | 'delete' | 'run', ...fields }.
  const automation = url.pathname.match(/^\/api\/automations(?:\/([a-f0-9-]{36}))?$/);
  if (automation) {
    if (!automations) throw new BridgeError("Automations are off in this window", 503);
    const id = automation[1];
    if (!id) {
      if (method === "GET") json(response, 200, { data: await automations.list() });
      else json(response, 201, await automations.create(await body(request)));
      return true;
    }
    if (method === "POST") {
      const { action, ...fields } = (await body(request)) ?? {};
      if (action === "run") {
        object(fields, []);
        json(response, 200, await automations.runNow(id));
        return true;
      }
      if (action === "delete") {
        object(fields, []);
        json(response, 200, await automations.remove(id));
        return true;
      }
      if (action === "update") {
        json(response, 200, await automations.update(id, fields));
        return true;
      }
      // The window's half of a scheduled workflow run: claim it (one window only), then report its chat or error.
      if (action === "claim" || action === "result") {
        json(response, 200, workflowDispatcher.handleAction(id, action, fields));
        return true;
      }
      throw new BridgeError("Action must be update, delete, run, claim or result");
    }
  }
  if (url.pathname === "/api/workflows/workspace" && method === "POST") {
    object(await body(request), []);
    json(response, 200, await workflowWorkspace(options.elpisHome ?? elpisHome()));
    return true;
  }
  if (url.pathname === "/api/workflows/history" && method === "GET") {
    if ([...url.searchParams.keys()].length) throw new BridgeError("Unexpected workflow history parameters");
    json(response, 200, await client.workflowHistory());
    return true;
  }
  if (url.pathname === "/api/workflows/history/undo" && method === "POST") {
    json(response, 200, await client.undoWorkflowHistory(await body(request)));
    return true;
  }
  const removeHistory = url.pathname.match(/^\/api\/workflows\/history\/([a-f0-9-]{36})\/remove$/i);
  if (removeHistory && method === "POST") {
    json(response, 200, await client.removeWorkflowHistory(removeHistory[1], await body(request)));
    return true;
  }
  if (url.pathname === "/api/workflows" && method === "GET") {
    if (
      [...url.searchParams.keys()].some(key => key !== "threadId") ||
      url.searchParams.getAll("threadId").length !== 1
    )
      throw new BridgeError("Choose one workflow conversation");
    json(response, 200, await client.workflows(url.searchParams.get("threadId")));
    return true;
  }
  // Workflows that run until they finish (SPEC WR7).
  if (url.pathname === "/api/workflow-runs" && method === "GET") {
    if ([...url.searchParams.keys()].some(key => key !== "threadId") || url.searchParams.getAll("threadId").length > 1)
      throw new BridgeError("Unexpected workflow run parameters");
    json(response, 200, await client.scriptRuns(url.searchParams.get("threadId") ?? undefined));
    return true;
  }
  if (url.pathname === "/api/workflow-runs" && method === "POST") {
    json(response, 200, await client.startScriptRun(await body(request)));
    return true;
  }
  const scriptRun = url.pathname.match(
    /^\/api\/workflow-runs\/(wf_[0-9a-f-]{36})(?:\/(stop|resume|agents\/(a[0-9a-f]{16})\/skip))?$/,
  );
  if (scriptRun && !scriptRun[2] && method === "GET") {
    json(response, 200, await client.scriptRun(scriptRun[1]));
    return true;
  }
  if (scriptRun?.[2] === "stop" && method === "POST") {
    json(response, 200, await client.stopScriptRun(scriptRun[1]));
    return true;
  }
  if (scriptRun?.[2] === "resume" && method === "POST") {
    json(response, 200, await client.resumeScriptRun(scriptRun[1]));
    return true;
  }
  if (scriptRun?.[3] && method === "POST") {
    json(response, 200, await client.skipScriptAgent(scriptRun[1], scriptRun[3]));
    return true;
  }
  if (url.pathname === "/api/workflows/run" && method === "POST") {
    json(response, 200, await client.runWorkflow(await body(request)));
    return true;
  }
  if (url.pathname === "/api/workflows/presets" && method === "GET") {
    json(response, 200, client.workflowPresets());
    return true;
  }
  if (url.pathname === "/api/workflows/presets" && method === "POST") {
    json(response, 200, await client.runWorkflowPreset(await body(request)));
    return true;
  }
  const workflowRun = url.pathname.match(/^\/api\/workflows\/([a-f0-9-]{36})$/i);
  if (workflowRun && method === "GET") {
    json(response, 200, await client.workflowRun(workflowRun[1]));
    return true;
  }
  const workflowOutput = url.pathname.match(
    /^\/api\/workflows\/([a-f0-9-]{36})\/nodes\/([A-Za-z0-9_-]{1,100})\/output$/i,
  );
  if (workflowOutput && method === "GET") {
    json(response, 200, await client.workflowAgentOutput(workflowOutput[1], workflowOutput[2]));
    return true;
  }
  const workflowMessage = url.pathname.match(
    /^\/api\/workflows\/([a-f0-9-]{36})\/nodes\/([A-Za-z0-9_-]{1,100})\/messages$/i,
  );
  if (workflowMessage && method === "POST") {
    json(response, 200, await client.steerWorkflow(workflowMessage[1], workflowMessage[2], await body(request)));
    return true;
  }
  const workflowMerge = url.pathname.match(/^\/api\/workflows\/([a-f0-9-]{36})\/merge$/i);
  if (workflowMerge && method === "POST") {
    json(response, 200, await client.mergeWorkflow(workflowMerge[1], await body(request)));
    return true;
  }
  const workflowResume = url.pathname.match(/^\/api\/workflows\/([a-f0-9-]{36})\/resume$/i);
  if (workflowResume && method === "POST") {
    json(response, 200, await client.resumeWorkflow(workflowResume[1], await body(request)));
    return true;
  }
  return false;
}
