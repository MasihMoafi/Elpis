// The workflow runner's agents as helper chats, started through the bridge exactly as the delegate tool starts
// them (its "elpis-agents" connection): any model the bridge serves, below the chat that started the run, in that
// chat's permissions (a Full Access chat's helpers get Full Access), never asking. Each agent has its own
// connection, so agents on one model run side by side; a connection that drops is a passing failure.
import { connectAppServer } from "./app-server-connection.mjs";

const bridged = (model) => /^(claude|agy)\//.test(model ?? "");
const message = (e) => e?.message ?? (typeof e === "string" ? e : JSON.stringify(e));
const failure = (why, extra = {}) => Object.assign(new Error(why), extra);

export function bridgeExecutor({ url, log = () => {}, provider = () => null }) {
  const open = new Map(); // thread id -> { conn, bridged }
  const connect = () => connectAppServer({ url, name: "elpis-agents" });

  async function attach(threadId) {
    const known = open.get(threadId);
    if (known && !known.conn.closed) return known;
    const conn = connect();
    try {
      await conn.ready;
      const r = await conn.call("thread/resume", { threadId });
      const entry = { conn, bridged: bridged(r?.model ?? r?.thread?.model) };
      open.set(threadId, entry);
      return entry;
    } catch (e) {
      conn.close();
      throw failure(`Could not reopen the agent's chat ${threadId}: ${message(e)}`, { threadGone: true });
    }
  }

  return {
    async open({ runId, agentId, label, model, effort, cwd, parentThreadId, providerName }) {
      const conn = connect();
      try { await conn.ready; } catch (e) { conn.close(); throw failure(`Elpis is not reachable: ${message(e)}`); }
      const isBridged = bridged(model);
      const modelProvider = isBridged ? null : providerName ?? provider(parentThreadId, model);
      let started;
      try {
        started = await conn.call("thread/start", {
          cwd, approvalPolicy: "never", sandbox: "danger-full-access",
          ...(model && { model }), ...(modelProvider && { modelProvider }),
          ...(effort && { config: { model_reasoning_effort: effort } }),
          ...(parentThreadId && { elpisParentThreadId: parentThreadId }),
          elpisWorkflow: { runId, agentId },
        });
      } catch (e) { conn.close(); throw failure(`The agent's chat did not start: ${message(e)}`); }
      const threadId = started.thread.id;
      await conn.call("thread/name/set", { threadId, name: label }).catch(() => {});
      open.set(threadId, { conn, bridged: isBridged });
      log(`workflow ${runId}: agent ${agentId} is chat ${threadId} (${model ?? "default model"})`);
      return { threadId, model: started.model ?? model ?? null };
    },

    async turn({ threadId, text, outputSchema, signal }) {
      const { conn, bridged: isBridged } = await attach(threadId);
      return new Promise((resolve, reject) => {
        let turnId = null, deltas = "", last = null, tokens = 0, done = false;
        const finish = (fn, value) => {
          if (done) return;
          done = true;
          conn.listeners.delete(listen);
          signal?.removeEventListener("abort", abort);
          fn(value);
        };
        const listen = (m) => {
          if (m.params?.threadId !== threadId) return;
          if (m.method === "turn/started") turnId ??= m.params.turn?.id ?? null;
          else if (m.method === "item/agentMessage/delta") deltas += m.params.delta ?? "";
          else if (m.method === "item/completed" && m.params.item?.type === "agentMessage") last = m.params.item.text ?? last;
          else if (m.method === "thread/tokenUsage/updated") tokens += m.params.tokenUsage?.last?.outputTokens ?? 0;
          else if (m.method === "turn/completed") {
            const turn = m.params.turn ?? {};
            if (turnId && turn.id && turn.id !== turnId) return;
            if (turn.status === "completed") finish(resolve, { text: last ?? deltas, outputTokens: tokens });
            else if (signal?.aborted) finish(reject, signal.reason);
            else finish(reject, failure(`The agent's turn ${turn.status ?? "ended"}: ${message(turn.error ?? "no reason given")}`));
          }
        };
        const abort = () => {
          if (turnId) conn.call("turn/interrupt", { threadId, turnId }).catch(() => {});
          setTimeout(() => { open.delete(threadId); conn.close(); }, 2000).unref?.();
          finish(reject, signal.reason);
        };
        conn.listeners.add(listen);
        conn.onClose((why) => { open.delete(threadId); finish(reject, failure(`The agent lost its connection: ${why}`, { threadGone: false })); });
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true });
        conn.call("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], ...(outputSchema && !isBridged && { outputSchema }) })
          .then((r) => { turnId ??= r?.turn?.id ?? null; }, (e) => finish(reject, failure(`The agent's turn did not start: ${message(e)}`, { threadGone: /not found|not loaded/i.test(message(e)) })));
      });
    },

    // Its private engine ends with its connection, once the agent is done.
    close(threadId) {
      const entry = open.get(threadId);
      if (!entry) return;
      open.delete(threadId);
      entry.conn.close();
    },
  };
}
