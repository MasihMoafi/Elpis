import { personAskedForWorkflow } from "./workflow-runner.mts";
import type { WorkflowRunner } from "./workflow-runner.mts";
import type { EngineCall,BridgeClient,BridgeMessage,BridgeResponses,PromptInput,ProviderOwner,ProviderTurn,Store,GlobalRequest } from "./bridge-types.mts";

type Dependencies = {
  storeChain: () => Promise<void>; loadStore: () => Promise<Store>;
  providerOwners: Map<string, ProviderOwner>; claudeModel: Map<string, string>;
  isBridged: (model: unknown) => model is string; activeTurns: Map<string, ProviderTurn>;
  engineCall: EngineCall; textOf: (input: PromptInput[] | undefined) => string;
  log: (message: string) => void; toTui: (message: BridgeMessage) => void;
  workflowToolConns: WeakSet<BridgeClient>; ws: BridgeClient; claudeEffort: Map<string, string>;
  threadCwd: Map<string, string>; workflows: WorkflowRunner; HOME: string;
  engine: { stdin: { write: (data: string) => unknown } };
};

/** Route workflow requests and require the person's opt-in for tool-initiated runs. */
export function createWorkflowRequests({ storeChain, loadStore, providerOwners, claudeModel, isBridged, activeTurns, engineCall, textOf, log, toTui, workflowToolConns, ws, claudeEffort, threadCwd, workflows, HOME, engine }: Dependencies) {
  // WR6: a chat's workflow tool starts a run only inside a turn the person started whose own words asked for one.
  // A helper chat, a workflow's notice or Claude's reply to a background job never counts.
  async function personAskedIn(threadId: string) {
    const refuse = (why: string) => { throw Object.assign(new Error(why), { code: -32600 }); };
    await storeChain();
    const store = await loadStore();
    if (store._delegations?.[threadId] || store[threadId]?.parentThreadId) refuse("A helper chat cannot start a workflow; only a chat the person talks to can.");
    let texts = [], running = false;
    const provider = providerOwners.get(threadId)?.model() ?? claudeModel.get(threadId) ?? store[threadId]?.model;
    if (isBridged(provider)) {
      const active = store[threadId]?.active;
      running = Boolean(active) || activeTurns.has(threadId);
      texts = (active?.userItems ?? []).filter((item) => item.type === "userMessage").map((item) => textOf(item.content));
    } else {
      const turn = (await engineCall("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "full" }, 10_000))?.data?.[0];
      running = turn?.status === "inProgress";
      texts = (turn?.items ?? []).filter((item) => item.type === "userMessage").map((item) => textOf(item.content));
    }
    log(`workflow opt-in for ${threadId}: ${isBridged(provider) ? provider : "engine"} turn ${running ? "running" : "idle"}, ${texts.length} messages`);
    if (!running) refuse("Workflows start only during a message from the person.");
    if (!personAskedForWorkflow(texts)) refuse("The person did not ask for a workflow. Workflows run only when the person's own message asks for one (the keyword \"ultracode\", or words like \"use a workflow\"). Do the task without one, or ask them whether they want a workflow.");
    // Their "+500k"-style token target is the run's budget, as in the reference.
    const target = texts.join("\n").match(/(?:^|\s)\+(\d+(?:\.\d+)?)\s*([km])\b/i);
    return target ? Math.round(Number(target[1]) * ((target[2] as string).toLowerCase() === "m" ? 1e6 : 1e3)) : null;
  }
  // WR7: the protocol the app and the chats' workflow tool use.
  async function workflowRequest(msg: GlobalRequest) {
    const p = msg.params ?? {};
    const reply = (result: unknown) => toTui({ id: msg.id, result });
    const need = (key: string) => { const value = p[key]; if (typeof value !== "string" || !value) throw Object.assign(new Error(`${key} is required`), { code: -32602 }); return value; };
    switch (msg.method) {
      case "workflowRun/start": {
        const threadId = need("threadId");
        const fromTool = workflowToolConns.has(ws);
        const budget = fromTool ? await personAskedIn(threadId) : (Number.isFinite(p.budget) ? p.budget as number : null);
        // Its agents run on the chat's own model and provider, in its folder (WR2).
        await storeChain();
        const store = await loadStore();
        let model = providerOwners.get(threadId)?.model() ?? claudeModel.get(threadId) ?? store[threadId]?.model ?? null, provider = null, effort = null;
        let cwd = threadCwd.get(threadId) ?? store[threadId]?.active?.cwd ?? store[threadId]?.cwd ?? null;
        if (isBridged(model)) effort = claudeEffort.get(threadId) ?? store[threadId]?.effort ?? null;
        else {
          const thread = (await engineCall("thread/read", { threadId, includeTurns: false }, 10_000).catch(() => null))?.thread;
          if (!thread) throw Object.assign(new Error(`thread not found: ${threadId}`), { code: -32600 });
          model = thread.model ?? null; provider = thread.modelProvider ?? null; effort = thread.reasoningEffort ?? null; cwd ??= thread.cwd ?? null;
        }
        const started = await workflows.start({ script: p.script, scriptPath: p.scriptPath, args: p.args, resumeFromRunId: p.resumeFromRunId,
          parentThreadId: threadId, cwd: cwd ?? p.cwd ?? HOME, model, provider, effort, budget, origin: fromTool ? "chat" : "app" } as Parameters<WorkflowRunner["start"]>[0])
          .catch((e) => { throw Object.assign(e, { code: -32602 }); });
        log(`workflow ${started.runId} (${started.name}) started from ${fromTool ? "chat" : "the app"} ${threadId} on ${model ?? "the default model"}`);
        return reply(started);
      }
      case "workflowRun/list": return reply({ data: workflows.list(p.threadId === undefined ? {} : { parentThreadId: p.threadId }) });
      case "workflowRun/read": {
        const run = workflows.read(need("runId"));
        if (!run) throw Object.assign(new Error(`No workflow run ${p.runId}.`), { code: -32600 });
        return reply({ run });
      }
      case "workflowRun/stop": return reply({ run: await workflows.stop(need("runId")) });
      case "workflowRun/resume": return reply({ run: await workflows.resume(need("runId")) });
      case "workflowRun/skip": workflows.skip(need("runId"), need("agentId")); return reply({});
      default: throw Object.assign(new Error(`Unknown method ${msg.method}`), { code: -32601 });
    }
  }
  async function runWorkGraph(msg: GlobalRequest) {
    await storeChain();
    const tid = msg.params.rootThreadId;
    const model = tid === undefined ? undefined : providerOwners.get(tid)?.model() ?? claudeModel.get(tid) ?? (await loadStore())[tid]?.model;
    if (typeof model === "string" && /^(claude|agy)\//.test(model)) {
      toTui({ id: msg.id, error: { code: -32600, message: "Workflows cannot run in Claude or Gemini subscription chats yet. Choose a conversation on a native provider; the subscription model must not be replaced by the engine's model." } });
      return;
    }
    engine.stdin.write(JSON.stringify(msg) + "\n");
  }
  return { workflowRequest, runWorkGraph };
}
