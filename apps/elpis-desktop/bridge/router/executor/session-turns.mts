import { object, runtimeOf, type OpenOptions, type ToolBinding, type WorkerSession } from "./adapters.mts";
import { initializeRoleModel } from "./role-models.mts";
import { liveTicket } from "../core/index.mts";
import type { Sessions, Mode } from "./sessions.mts";

import { z } from "zod";

import type { Agent } from "./runtime.mts";
import { RoleModelSchema } from "./settings.mts";

export async function runOpen(
  this: Sessions,
  id: string,
  cwd: string,
  title: string,
  role: "worker" | "orchestrator",
): Promise<WorkerAgent> {
  const stored = this.options.store.session(id);
  const model =
    role === "worker" ? this.options.store.settings().executor.model : this.options.store.settings().eval.model;
  const record: SessionRecord =
    stored === undefined
      ? ({ runtime: runtimeOf(model), threadId: null, creating: false, model, messages: [] } satisfies SessionRecord)
      : RecordSchema.parse(stored);
  // The router follows the model setting. Its durable state is the ticket store, so a new session loses nothing.
  if (
    role === "orchestrator" &&
    record.threadId &&
    !record.creating &&
    JSON.stringify(record.model) !== JSON.stringify(model)
  )
    await resetSession.call(this, record);
  // An Elpis session made with dynamic tools cannot be served: the shared engine bridge sends its tool calls to whichever
  // window owns the chat, never back to the router (10 Nov: every router and worker tool call failed or timed out).
  if (record.runtime === "elpis" && record.threadId && !record.creating && record.tools !== "mcp" && this.options.tools)
    await resetSession.call(this, record);
  if (!record.threadId && !record.creating) {
    record.model = model;
    record.runtime = runtimeOf(model);
  }
  const adapter = this.adapter(record.runtime);
  const tools = this.options.tools?.(id);
  const mcp =
    tools && (record.runtime === "claude" || record.runtime === "gemini" || record.runtime === "elpis")
      ? await this.toolRuntime?.transport(id, tools, role)
      : undefined;
  let remote: WorkerSession;
  if (record.threadId) {
    if (mcp) await adapter.configure?.(record.threadId, mcp, this.options.environment?.(id));
    remote = await adapter.read(record.threadId);
  } else {
    // A start with an unknown outcome may have created a paid worker. Never start another automatically.
    if (record.creating)
      throw new Error("Session creation outcome is unknown; bind the existing runtime session before retrying");
    record.creating = true;
    this.options.store.saveSession(id, record);
    const instructions = this.options.instructions?.(id);
    const options: OpenOptions = {
      cwd,
      name: title,
      model: record.model,
      role,
      ...(mcp ? { mcp } : {}),
      ...(this.options.environment ? { environment: this.options.environment(id) } : {}),
      ...(this.options.parentThreadId ? { parentThreadId: this.options.parentThreadId } : {}),
      ...(instructions ? { instructions } : {}),
      ...(tools ? { tools } : {}),
    };
    try {
      remote = await initializeRoleModel(adapter, options, record.model);
    } catch (error) {
      if (object(error).creationUnknown === false) {
        record.creating = false;
        this.options.store.saveSession(id, record);
      }
      throw error;
    }
    record.threadId = remote.threadId;
    record.creating = false;
    if (mcp) record.tools = "mcp";
    this.options.store.saveSession(id, record);
  }
  if (this.disposed) throw new Error("The session manager stopped while attaching a worker");
  const agent = new WorkerAgent(id, record, this);
  this.agents.set(id, agent);
  if (this.options.tools) {
    if (!adapter.bind) throw new Error("This runtime cannot serve Elpis tools");
    const binding: ToolBinding = {
      tools: () => this.options.tools!(id),
      instructions: () => this.instructions(id),
      mcp: async () => {
        if (!this.toolRuntime) throw new Error("This session cannot reconnect Elpis tools");
        const config = await this.toolRuntime.transport(id, binding.tools(), role);
        this.toolRuntime.bind(id, binding);
        return config;
      },
      ...(this.options.environment ? { environment: () => this.options.environment!(id) } : {}),
      signal: this.lifetime.signal,
      authorize: () => {
        if (this.disposed) throw new Error("Elpis is stopping");
        const ticketId = id.startsWith("worker-") ? id.slice("worker-".length) : undefined;
        const ticket = ticketId ? this.options.store.tickets.get(ticketId) : undefined;
        if (ticketId && (!ticket || !liveTicket(ticket))) throw new Error("Ticket ended; its tools are unavailable");
      },
    };
    this.toolRuntime?.bind(id, binding);
    adapter.bind(remote.threadId, binding);
  }
  this.reconcile(agent, remote);
  this.subscriptions.set(
    id,
    adapter.subscribe(remote.threadId, message => this.receive(agent, message)),
  );
  return agent;
}

/** Queue before sending; the effect and its receipt share the same durable store as the Assignment. */
export async function runPrompt(
  this: Sessions,
  sessionId: string,
  id: string,
  text: string,
  mode: Mode,
  authorize?: () => void,
  accepted?: () => void,
): Promise<void> {
  const agent = this.agents.get(sessionId);
  if (!agent) throw new Error(`Session ${sessionId} is not attached`);
  await agent.cancellation;
  if (this.disposed) throw new Error("The session manager is stopped");
  authorize?.();
  const messageId = this.promptedId(id);
  let message = agent.record.messages.find(item => item.id === messageId);
  if (!message) {
    message = {
      id: messageId,
      text,
      mode: typeof mode === "object" ? "inject" : mode,
      state: "queued",
      read: false,
      accepted: false,
    };
    agent.record.messages.push(message);
    this.save(agent);
  }
  // A rejected first turn must leave its Assignment pending so the launch effect can retry it.
  let acknowledged = false;
  const accept = () => {
    if (!acknowledged) {
      acknowledged = true;
      accepted?.();
    }
  };
  await this.flush(agent, authorize, accept, messageId);
  // A message queued behind a running turn is durably accepted, but it has not been read.
  message.accepted = true;
  this.save(agent);
  accept();
}

export async function runFlush(
  this: Sessions,
  agent: WorkerAgent,
  authorize?: () => void,
  accepted?: () => void,
  requestedId?: string,
): Promise<void> {
  const previous = this.sending.get(agent.id) ?? Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(async () => {
      if (this.disposed) return;
      await agent.cancellation;
      const threadId = agent.record.threadId;
      if (!threadId) throw new Error("The runtime session is not bound");
      const adapter = this.adapter(agent.record.runtime);
      for (const message of agent.record.messages.filter(
        item => item.state !== "sent" && (item.accepted || item.id === requestedId),
      )) {
        authorize?.();
        this.reconcile(agent, await adapter.read(threadId));
        if (message.state === "sent") continue;
        if (message.state === "sending")
          throw new Error(`Delivery ${message.id} has an unknown outcome; inspect runtime history before retrying`);
        if (message.mode === "inject") continue;
        if (message.mode === "queue" && agent.activeTurn) return;
        authorize?.();
        message.state = "sending";
        this.save(agent);
        try {
          const injected = agent.record.messages.filter(item => item.mode === "inject" && item.state === "queued");
          const text = [...injected.map(item => item.text), message.text].join("\n");
          const turn = await adapter.send(
            threadId,
            message.id,
            text,
            agent.activeTurn,
            injected.map(item => item.id),
          );
          for (const item of injected) item.state = "sent";
          message.state = "sent";
          message.accepted = true;
          this.save(agent);
          if (message.id === requestedId) accepted?.();
          agent.state(turn);
          // The engine's acknowledged turn carries the message in history; read it back rather than inferring consumption.
          this.reconcile(agent, await adapter.read(threadId));
        } catch (error) {
          // A protocol rejection is safe to retry. Transport loss leaves 'sending' until history resolves it.
          if (typeof object(error).code === "number" && !object(error).connectionClosed) {
            message.state = "queued";
            this.save(agent);
          }
          throw error;
        }
      }
    })
    .finally(() => {
      if (this.sending.get(agent.id) === work) this.sending.delete(agent.id);
    });
  this.sending.set(agent.id, work);
  await work;
}

export function runReceive(this: Sessions, agent: WorkerAgent, raw: unknown): void {
  const message = object(raw),
    params = object(message.params),
    turn = object(params.turn);
  if (message.method === "turn/started" && typeof turn.id === "string") {
    const previous = this.retryTurns.get(agent.id);
    if (previous?.id !== turn.id)
      this.retryTurns.set(agent.id, { id: turn.id, ordinal: (previous?.ordinal ?? 0) + 1, attempts: 0 });
  }
  const retry = this.retryTurns.get(agent.id);
  if (message.method === "error" && params.willRetry === true && retry) {
    this.retries.observe(agent.id, {
      type: "llm/retry",
      seq: ++this.retrySeq,
      time: Date.now(),
      data: {
        turn: retry.ordinal,
        step: 0,
        retryId: retry.id,
        provider: agent.record.model?.provider ?? "",
        retry: ++retry.attempts,
        failure: params.error,
      },
    });
  }
  if (
    message.method === "turn/completed" ||
    (message.method === "item/completed" && object(params.item).type === "agentMessage")
  )
    this.retries.clear(agent.id);
  this.updateModelHealth();
  if (message.method === "turn/started" && typeof turn.id === "string") {
    agent.lastText = "";
    agent.state(turn.id);
  } else if (message.method === "item/completed") {
    const item = object(params.item);
    if (item.type === "agentMessage" && typeof item.text === "string") agent.lastText = item.text;
    if (item.type === "userMessage" && agent.record.threadId) {
      const text = Array.isArray(item.content)
        ? item.content
            .map(block => object(block).text)
            .filter(value => typeof value === "string")
            .join("\n")
        : "";
      if (!text.startsWith('<elpis-router-message id="'))
        this.emit("agent/inbox/claimed", { agent, message: { source: { kind: "user" } } });
      this.background(
        this.adapter(agent.record.runtime)
          .read(agent.record.threadId)
          .then(remote => this.reconcile(agent, remote)),
      );
    }
  } else if (message.method === "turn/completed") {
    if (agent.activeTurn && turn.id !== agent.activeTurn) return;
    if (turn.status === "failed")
      this.emit("agent/error", {
        agent,
        error: new Error(
          typeof object(turn.error).message === "string"
            ? String(object(turn.error).message)
            : "The worker turn failed",
        ),
      });
    if (turn.status === "completed" && typeof turn.id === "string" && agent.lastText)
      this.result(agent, turn.id, agent.lastText);
    agent.state(null);
    this.background(this.flush(agent));
  } else if (message.method === "error") {
    if (params.willRetry === true) return;
    const error = params.error;
    this.emit("agent/error", {
      agent,
      error: Object.assign(
        new Error(
          typeof object(error).message === "string" ? String(object(error).message) : "The runtime disconnected",
        ),
        object(error),
      ),
    });
    agent.state(null);
  }
}

export const MessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  mode: z.enum(["queue", "steer", "inject"]),
  state: z.enum(["queued", "sending", "sent"]),
  read: z.boolean().default(false),
  accepted: z.boolean().default(false),
});

/** A new session on the next open: the old one is archived, and the ticket store keeps what matters. */
async function resetSession(this: Sessions, record: SessionRecord): Promise<void> {
  await this.adapter(record.runtime)
    .archive?.(record.threadId!)
    .catch(() => {});
  record.threadId = null;
  record.messages = [];
  delete record.tools;
}

export const RecordSchema = z.object({
  runtime: z.enum(["elpis", "codex", "claude", "gemini"]),
  threadId: z.string().nullable(),
  creating: z.boolean().default(false),
  model: RoleModelSchema.nullable(),
  messages: z.array(MessageSchema).default([]),
  resultId: z.string().optional(),
  /** How the session reaches Elpis tools: "mcp" through the tool server; absent for older sessions made with dynamic tools. */
  tools: z.enum(["mcp"]).optional(),
});

export type SessionRecord = z.infer<typeof RecordSchema>;

export class WorkerAgent implements Agent {
  readonly id: string;
  status: Agent["status"] = "idle";
  activeTurn: string | null = null;
  lastText = "";
  readonly record: SessionRecord;
  private readonly owner: Sessions;
  private readonly idle = new Set<() => void>();
  cancellation: Promise<void> = Promise.resolve();
  readonly inbox: Agent["inbox"];
  readonly session: Agent["session"];
  constructor(id: string, record: SessionRecord, owner: Sessions) {
    this.id = id;
    this.record = record;
    this.owner = owner;
    this.inbox = {
      remove: id => {
        record.messages = record.messages.filter(message => message.id !== id || message.state === "sent");
        owner.save(this);
      },
    };
    this.session = {
      snapshotEvents: () =>
        this.lastText
          ? [{ type: "assistant/message", data: { message: { content: [{ type: "text", text: this.lastText }] } } }]
          : [],
    };
  }
  state(turn: string | null): void {
    const old = this.status;
    this.activeTurn = turn;
    this.status = turn ? "running" : "idle";
    if (!turn) {
      for (const resolve of this.idle) resolve();
      this.idle.clear();
    }
    if (old !== this.status) this.owner.emit("agent/status", { agent: this, status: this.status });
  }
  cancel(_reason: { kind: "user" }, options: { keepInbox: boolean }): void {
    this.cancellation = this.cancellation.catch(() => {}).then(() => this.owner.cancel(this, options.keepInbox));
    // Event listeners report the failure; consume the fire-and-forget cancellation rejection here too.
    void this.cancellation.catch(error => this.owner.emit("agent/error", { agent: this, error }));
  }
  async whenIdle(): Promise<void> {
    await this.cancellation;
    if (this.status !== "idle") await new Promise<void>(resolve => this.idle.add(resolve));
  }
}
