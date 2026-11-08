// The workflow runner's agents as helper chats, started through the bridge exactly as the delegate tool starts
// them (its "elpis-agents" connection): any model the bridge serves, below the chat that started the run, in that
// chat's permissions (a Full Access chat's helpers get Full Access; in a chat that asks first, the bridge puts their
// questions to that chat, and the agent waits for the answer). Each agent has its own
// connection, so agents on one model run side by side; a connection that drops is a passing failure.
import { connectAppServer } from "./app-server-connection.mts";

type Connection = ReturnType<typeof connectAppServer>;
type ConfigReader = { call(method: "config/read", params: object): Promise<{ config?: { mcp_servers?: Record<string, unknown> } }> };
type AgentConfig = { cwd?: string | undefined; mcpServers?: string[] | undefined };
type AgentOpen = AgentConfig & { runId: string; agentId: string; label: string; model?: string | null; effort?: string | null; parentThreadId?: string | null; providerName?: string | null };
type AgentTurn = { threadId: string; text: string; outputSchema?: unknown; signal?: AbortSignal };
type TurnResult = { text: string; outputTokens: number };
type Notification = { threadId?: string; delta?: string; turn?: { id?: string; status?: string; error?: unknown }; item?: { type?: string; text?: string }; tokenUsage?: { last?: { outputTokens?: number } } };
type ExecutorOptions = { url?: string | (() => string | undefined); log?: (message: string) => void; provider?: (parentThreadId: string | null | undefined, model: string | null | undefined) => string | null };

const bridged = (model: string | null | undefined) => /^(claude|agy)\//.test(model ?? "");
const message = (e: unknown) => (e as { message?: string } | null | undefined)?.message ?? (typeof e === "string" ? e : JSON.stringify(e));
const failure = (why: string, extra = {}) => Object.assign(new Error(why), extra);

// The person's own MCP servers stay off in an agent's chat, except those its definition names: every loaded chat runs
// its own copy of them (about 300 MB). One `mcp_servers = {}` override would merge, not replace, so each configured
// server is turned off by name. ELPIS_WORKFLOW_USER_MCP=1 keeps them all, as before. Also for the desktop's Workflows
// nodes (elpis-acp-agent.mts).
export async function withoutUserMcp(conn: ConfigReader, { cwd, mcpServers = [] }: AgentConfig = {}, log: (message: string) => void = () => {}) {
  if (process.env.ELPIS_WORKFLOW_USER_MCP === "1") return {};
  const read = await conn.call("config/read", { includeLayers: false, ...(cwd && { cwd }) })
    .catch((e) => { log(`workflow agent: its MCP servers stay on, the configuration could not be read: ${message(e)}`); return null; });
  const names = Object.keys(read?.config?.mcp_servers ?? {}).filter((name) => !mcpServers.includes(name));
  return Object.fromEntries(names.map((name) => [`mcp_servers.${name}.enabled`, false]));
}

export function bridgeExecutor({ url, log = () => {}, provider = () => null }: ExecutorOptions) {
  const open = new Map<string, { conn: Connection; bridged: boolean }>(); // thread id -> { conn, bridged }
  const startedWith = new Map<string, AgentConfig>(); // thread id -> { cwd, mcpServers }, to reopen it alike
  const connect = () => connectAppServer({ url, name: "elpis-agents" });

  async function attach(threadId: string) {
    const known = open.get(threadId);
    if (known && !known.conn.closed) return known;
    const conn = connect();
    try {
      await conn.ready;
      const config = await withoutUserMcp(conn, startedWith.get(threadId), log);
      const r = await conn.call("thread/resume", { threadId, ...(Object.keys(config).length && { config }) });
      const entry = { conn, bridged: bridged(r?.model ?? r?.thread?.model) };
      open.set(threadId, entry);
      return entry;
    } catch (e) {
      conn.close();
      throw failure(`Could not reopen the agent's chat ${threadId}: ${message(e)}`, { threadGone: true });
    }
  }

  return {
    async open({ runId, agentId, label, model, effort, cwd, parentThreadId, providerName, mcpServers }: AgentOpen) {
      const conn = connect();
      try { await conn.ready; } catch (e) { conn.close(); throw failure(`Elpis is not reachable: ${message(e)}`); }
      const isBridged = bridged(model);
      const modelProvider = isBridged ? null : providerName ?? provider(parentThreadId, model);
      let started;
      try {
        const config = { ...(effort && { model_reasoning_effort: effort }), ...await withoutUserMcp(conn, { cwd, mcpServers }, log) };
        started = await conn.call("thread/start", {
          cwd, approvalPolicy: "never", sandbox: "danger-full-access",
          ...(model && { model }), ...(modelProvider && { modelProvider }),
          ...(Object.keys(config).length && { config }),
          ...(parentThreadId && { elpisParentThreadId: parentThreadId }),
          elpisWorkflow: { runId, agentId },
        });
      } catch (e) { conn.close(); throw failure(`The agent's chat did not start: ${message(e)}`); }
      const threadId = started.thread.id;
      await conn.call("thread/name/set", { threadId, name: label }).catch(() => {});
      open.set(threadId, { conn, bridged: isBridged });
      startedWith.set(threadId, { cwd, mcpServers });
      log(`workflow ${runId}: agent ${agentId} is chat ${threadId} (${model ?? "default model"})`);
      return { threadId, model: started.model ?? model ?? null };
    },

    async turn({ threadId, text, outputSchema, signal }: AgentTurn) {
      const { conn, bridged: isBridged } = await attach(threadId);
      return new Promise<TurnResult>((resolve, reject) => {
        let turnId: string | null = null, deltas = "", last: string | null = null, tokens = 0, done = false;
        const finish = <T,>(fn: (value: T) => void, value: T) => {
          if (done) return;
          done = true;
          conn.listeners.delete(listen);
          signal?.removeEventListener("abort", abort);
          fn(value);
        };
        const listen: Parameters<Connection['listeners']['add']>[0] = (m) => {
          const params = m.params as Notification | undefined;
          if (params?.threadId !== threadId) return;
          if (m.method === "turn/started") turnId ??= params.turn?.id ?? null;
          else if (m.method === "item/agentMessage/delta") deltas += params.delta ?? "";
          else if (m.method === "item/completed" && params.item?.type === "agentMessage") last = params.item.text ?? last;
          else if (m.method === "thread/tokenUsage/updated") tokens += params.tokenUsage?.last?.outputTokens ?? 0;
          else if (m.method === "turn/completed") {
            const turn = params.turn ?? {};
            if (turnId && turn.id && turn.id !== turnId) return;
            if (turn.status === "completed") finish(resolve, { text: last ?? deltas, outputTokens: tokens });
            else if (signal?.aborted) finish(reject, signal.reason);
            else finish(reject, failure(`The agent's turn ${turn.status ?? "ended"}: ${message(turn.error ?? "no reason given")}`));
          }
        };
        const abort = () => {
          if (turnId) conn.call("turn/interrupt", { threadId, turnId }).catch(() => {});
          setTimeout(() => { open.delete(threadId); conn.close(); }, 2000).unref?.();
          finish(reject, (signal as AbortSignal).reason);
        };
        conn.listeners.add(listen);
        conn.onClose((why) => { open.delete(threadId); finish(reject, failure(`The agent lost its connection: ${why}`, { threadGone: false })); });
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true });
        conn.call("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], ...((outputSchema && !isBridged && { outputSchema }) as object) })
          .then((r) => { turnId ??= r?.turn?.id ?? null; }, (e) => finish(reject, failure(`The agent's turn did not start: ${message(e)}`, { threadGone: /not found|not loaded/i.test(message(e)) })));
      });
    },

    // Its private engine ends with its connection, once the agent is done.
    close(threadId: string) {
      const entry = open.get(threadId);
      startedWith.delete(threadId);
      if (!entry) return;
      open.delete(threadId);
      entry.conn.close();
    },
  };
}
