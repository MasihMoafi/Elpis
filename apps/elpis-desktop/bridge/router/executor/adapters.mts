import { runRead } from "./adapter-read.mts";
import { object, shellConfig, string, managedInstructions, roleConfig, marker } from "./adapter-config.mts";
import type { Runtime, Connection, WorkerSession, ToolBinding, OpenOptions, RuntimeAdapter } from "./adapter-config.mts";
export { object, runtimeOf } from "./adapter-config.mts";
export type { Runtime, Connection, WorkerSession, ToolBinding, OpenOptions, RuntimeAdapter } from "./adapter-config.mts";
import type { RoleModel } from "./settings.mts";
import { z } from "zod";

import type { McpRuntime } from "./tool-runtime.mts";
/** The ACP bridge exposes the same app-server protocol as the native engine; it owns provider sign-in and processes. */
export class AppServerAdapter implements RuntimeAdapter {
  readonly runtime: Runtime;
  private readonly connections = new Map<string, Connection>();
  private readonly owned = new Set<Connection>();
  private closed = false;
  private readonly disposers = new Set<() => void>();
  private readonly watchers = new Map<string, Set<(message: unknown) => void>>();
  private readonly connect: () => Connection;
  private readonly bindings = new Map<string, ToolBinding>();
  private readonly toolCalls = new Set<Promise<void>>();
  constructor(runtime: Runtime, connect: () => Connection) {
    this.runtime = runtime;
    this.connect = connect;
  }
  private createConnection(): Connection {
    if (this.closed) throw new Error("The runtime adapter is stopped");
    const conn = this.connect();
    this.owned.add(conn);
    return conn;
  }
  private attaching(conn: Connection): void {
    if (this.closed || conn.closed) throw new Error("The runtime adapter stopped while attaching the session");
  }
  async connection(threadId: string): Promise<Connection> {
    const old = this.connections.get(threadId);
    if (old && !old.closed) return old;
    const conn = this.createConnection();
    try {
      await conn.ready;
      this.attaching(conn);
      await conn.call("thread/resume", { threadId });
      this.attaching(conn);
      this.connections.set(threadId, conn);
      this.watch(conn, threadId);
      return conn;
    } catch (error) {
      conn.close();
      this.owned.delete(conn);
      throw error;
    }
  }
  protected route(model: RoleModel | null): {
    model?: string;
    modelProvider?: string;
    config?: Record<string, string>;
  } {
    return model
      ? {
          model: model.model,
          modelProvider: model.provider,
          ...(model.reasoningEffort ? { config: { model_reasoning_effort: model.reasoningEffort } } : {}),
        }
      : {};
  }
  async open(options: OpenOptions): Promise<WorkerSession> {
    if (this.runtime === "gemini" && options.tools?.length)
      throw Object.assign(
        new Error(
          "The Antigravity adapter does not expose session MCP tools. Choose Elpis, Codex or Claude for a Elpis role.",
        ),
        { creationUnknown: false },
      );
    const conn = this.createConnection();
    let creating = false;
    try {
      await conn.ready;
      this.attaching(conn);
      // Match workflow agents: turn off user MCP servers individually; never replace the global configuration.
      const configured = object(
        object(await conn.call("config/read", { includeLayers: false, cwd: options.cwd })).config,
      ).mcp_servers;
      const config = Object.fromEntries(
        Object.keys(object(configured)).map(name => [`mcp_servers.${name}.enabled`, false]),
      );
      const route = this.route(options.model);
      this.attaching(conn);
      const environment = options.tools
        ? { ...options.environment, ELPIS_MOTHER_ROLE: options.role ?? "worker" }
        : options.environment;
      creating = true;
      const response = object(
        await conn.call("thread/start", {
          cwd: options.cwd,
          approvalPolicy: "never",
          // As in DSH, the router and its workers have the same access: no sandbox, as your user (not root). This is Elpis's
          // Full access, not Bypass, so Elpis's own refusals of dangerous commands still apply.
          sandbox: "danger-full-access",
          ...route,
          config: {
            ...config,
            ...route.config,
            ...(options.tools ? roleConfig(options.role) : {}),
            ...(environment ? shellConfig(environment) : {}),
            ...(options.mcp ? { "mcp_servers.elpis_mother": this.toolServer(options.mcp) } : {}),
          },
          ...(options.instructions
            ? { developerInstructions: options.tools ? managedInstructions : options.instructions }
            : {}),
          ...(options.tools && !options.mcp
            ? {
                dynamicTools: options.tools.map(tool => ({
                  type: "function",
                  name: tool.name,
                  description: tool.description,
                  inputSchema: z.toJSONSchema(tool.schema, { io: "input" }),
                })),
              }
            : {}),
          ...(options.parentThreadId ? { elpisParentThreadId: options.parentThreadId } : {}),
        }),
      );
      const threadId = string(object(response.thread).id);
      if (!threadId) throw new Error("The runtime did not return a session ID");
      this.attaching(conn);
      this.connections.set(threadId, conn);
      this.watch(conn, threadId);
      // Naming is cosmetic: a failed name must not lose the created session's durable binding.
      await conn.call("thread/name/set", { threadId, name: options.name }).catch(() => {});
      return {
        threadId,
        activeTurn: null,
        model: string(response.model) ?? options.model?.model ?? null,
        messages: [],
      };
    } catch (error) {
      if (![...this.connections.values()].includes(conn)) {
        conn.close();
        this.owned.delete(conn);
      }
      const failure = error instanceof Error ? error : new Error(String(object(error).message ?? error));
      throw Object.assign(failure, {
        creationUnknown: creating && (typeof object(error).code !== "number" || !!object(error).connectionClosed),
      });
    }
  }
  async archive(threadId: string): Promise<void> {
    const conn = await this.connection(threadId);
    await conn.call("thread/archive", { threadId });
    this.connections.delete(threadId);
  }
  async reload(threadId: string): Promise<void> {
    await this.archive(threadId);
    await (await this.connection(threadId)).call("thread/unarchive", { threadId });
  }
  async read(threadId: string): Promise<WorkerSession> {
    return runRead.call(this, threadId);
  }
  async send(
    threadId: string,
    id: string,
    text: string,
    activeTurn: string | null,
    includedIds: readonly string[] = [],
  ): Promise<string> {
    const conn = await this.connection(threadId);
    const binding = this.bindings.get(threadId);
    binding?.authorize();
    let collaborationMode: object | undefined;
    if (binding && !activeTurn) {
      const current = object(await conn.call("thread/resume", { threadId, excludeTurns: true }));
      const mode = object(current.collaborationMode),
        settings = object(mode.settings);
      const model = string(current.model) ?? string(object(current.thread).model);
      if (!model) throw new Error("The runtime did not return the session model");
      if (model.startsWith("agy/"))
        throw new Error(
          "The Antigravity adapter does not expose Elpis tools. Choose Elpis, Codex or Claude for this role.",
        );
      if (model.startsWith("claude/")) {
        if (!binding.mcp) throw new Error("This session cannot reconnect Elpis tools after a provider change");
        await this.configure(threadId, await binding.mcp(), binding.environment?.());
      }
      collaborationMode = {
        mode: string(mode.mode) ?? "default",
        settings: {
          model,
          reasoning_effort: settings.reasoning_effort ?? current.reasoningEffort ?? null,
          developer_instructions: binding.instructions(),
        },
      };
    }
    const input = [{ type: "text", text: `${marker(id, includedIds)}\n${text}`, text_elements: [] }];
    binding?.signal.throwIfAborted();
    binding?.authorize();
    const response = object(
      await conn.call(activeTurn ? "turn/steer" : "turn/start", {
        threadId,
        input,
        ...(collaborationMode ? { collaborationMode } : {}),
        ...(activeTurn ? { expectedTurnId: activeTurn } : {}),
      }),
    );
    const turn = string(object(response.turn).id) ?? string(response.turnId) ?? activeTurn;
    if (!turn) throw new Error("The runtime did not acknowledge the turn");
    return turn;
  }
  async stop(threadId: string, turnId: string): Promise<void> {
    const conn = await this.connection(threadId);
    await conn.call("turn/interrupt", { threadId, turnId });
  }
  /** Only the router's own Elpis tools skip approval; with approval policy "never" the engine refused them (10 Nov: "the
   * tool requires approval, but this session's approval policy is never"). Other tools keep the session's rules. */
  private toolServer(mcp: McpRuntime): McpRuntime {
    return this.runtime === "elpis" ? { ...mcp, default_tools_approval_mode: "approve" } : mcp;
  }
  async configure(threadId: string, mcp: McpRuntime, environment?: Record<string, string | undefined>): Promise<void> {
    if (this.runtime === "gemini")
      throw new Error(
        "The Antigravity adapter does not expose Elpis tools. Choose Elpis, Codex or Claude for this role.",
      );
    const conn = await this.connection(threadId);
    await conn.call("thread/resume", {
      threadId,
      excludeTurns: true,
      config: {
        "mcp_servers.elpis_mother": this.toolServer(mcp),
        ...shellConfig({ ...environment, ELPIS_MOTHER_ROLE: mcp.env.ELPIS_MOTHER_ROLE ?? "worker" }),
      },
    });
  }
  async background(threadId: string): Promise<{ jobs: { id: string; label: string }[]; children: { id: string }[] }> {
    const conn = await this.connection(threadId);
    const pages = async (method: string, params: object): Promise<Record<string, unknown>[]> => {
      const result: Record<string, unknown>[] = [],
        seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = object(await conn.call(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) }));
        if (!Array.isArray(page.data)) throw new Error("The runtime did not return background work");
        result.push(...page.data.map(object));
        cursor = string(page.nextCursor);
        if (cursor && seen.has(cursor)) throw new Error("The runtime repeated a background page");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return result;
    };
    const jobs = await pages("thread/backgroundTerminals/list", { threadId });
    const children = await pages("thread/list", { ancestorThreadId: threadId });
    const liveChildren = await Promise.all(
      children.map(async child => {
        if (typeof child.id !== "string") return [];
        const status = object(child.status).type;
        if (status === "active") return [{ id: child.id }];
        // A descendant can have ended its turn while its own terminal still runs.
        if (status === "idle" && (await pages("thread/backgroundTerminals/list", { threadId: child.id })).length)
          return [{ id: child.id }];
        return [];
      }),
    );
    return {
      jobs: jobs.flatMap(job =>
        typeof job.processId === "string" ? [{ id: job.processId, label: string(job.command) ?? "" }] : [],
      ),
      children: liveChildren.flat(),
    };
  }
  async killJob(threadId: string, processId: string): Promise<void> {
    const conn = await this.connection(threadId);
    const result = object(await conn.call("thread/backgroundTerminals/terminate", { threadId, processId }));
    if (result.terminated !== true) throw new Error(`The runtime did not stop background process ${processId}`);
  }
  private watch(conn: Connection, threadId: string): void {
    const request = (raw: unknown): boolean => {
      const message = object(raw),
        params = object(message.params),
        binding = this.bindings.get(threadId);
      if (
        message.method !== "item/tool/call" ||
        params.threadId !== threadId ||
        !binding ||
        !conn.respond ||
        (typeof message.id !== "string" && typeof message.id !== "number")
      )
        return false;
      const id = message.id;
      const run = async () => {
        let result: object;
        try {
          binding.signal.throwIfAborted();
          binding.authorize();
          const tool = binding.tools().find(tool => tool.name === params.tool);
          if (!tool) throw new Error("This tool is unavailable to this session");
          const value = await tool.execute(tool.schema.parse(params.arguments), binding.signal);
          const image = object(value).image_url;
          result = {
            success: true,
            contentItems:
              typeof image === "string"
                ? [{ type: "inputImage", imageUrl: image }]
                : [{ type: "inputText", text: JSON.stringify(value) ?? "null" }],
          };
        } catch (error) {
          result = {
            success: false,
            contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }],
          };
        }
        if (!conn.closed) conn.respond?.(id, result);
      };
      const work = run().finally(() => this.toolCalls.delete(work));
      this.toolCalls.add(work);
      return true;
    };
    conn.requests?.add(request);
    const receive = (message: unknown) => {
      if (object(object(message).params).threadId === threadId)
        for (const listener of this.watchers.get(threadId) ?? []) listener(message);
    };
    const closed = (why: string) => {
      for (const listener of this.watchers.get(threadId) ?? [])
        listener({ method: "error", params: { threadId, error: { message: why, connectionClosed: true } } });
    };
    conn.listeners.add(receive);
    let live = true;
    conn.onClose(why => {
      if (live) closed(why);
    });
    const dispose = () => {
      live = false;
      conn.listeners.delete(receive);
      conn.requests?.delete(request);
      this.disposers.delete(dispose);
    };
    this.disposers.add(dispose);
  }
  subscribe(threadId: string, listener: (message: unknown) => void): () => void {
    if (!this.connections.has(threadId)) throw new Error("Attach the session before subscribing");
    const watchers = this.watchers.get(threadId) ?? new Set();
    watchers.add(listener);
    this.watchers.set(threadId, watchers);
    return () => {
      watchers.delete(listener);
    };
  }
  bind(threadId: string, binding: ToolBinding): void {
    const conn = this.connections.get(threadId);
    if (!conn?.requests || !conn.respond)
      throw new Error("This runtime connection cannot serve Elpis tools; update the Elpis runtime");
    this.bindings.set(threadId, binding);
  }
  close(): void {
    this.closed = true;
    for (const dispose of this.disposers) dispose();
    this.bindings.clear();
    this.watchers.clear();
    for (const conn of this.owned) conn.close();
    this.owned.clear();
    this.connections.clear();
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.toolCalls]);
  }
}
export class ElpisAdapter extends AppServerAdapter {
  constructor(connect: () => Connection) {
    super("elpis", connect);
  }
}
export class CodexAdapter extends AppServerAdapter {
  constructor(connect: () => Connection) {
    super("codex", connect);
  }
  protected override route(model: RoleModel | null) {
    return super.route(model?.provider === "codex" ? { ...model, provider: "openai" } : model);
  }
}
export class ClaudeAdapter extends AppServerAdapter {
  constructor(connect: () => Connection) {
    super("claude", connect);
  }
  protected override route(model: RoleModel | null) {
    if (!model) throw new Error("Choose a Claude worker model in router settings");
    return {
      model: model.model.startsWith("claude/") ? model.model : `claude/${model.model}`,
      ...(model.reasoningEffort ? { config: { model_reasoning_effort: model.reasoningEffort } } : {}),
    };
  }
}
export class GeminiAdapter extends AppServerAdapter {
  constructor(connect: () => Connection) {
    super("gemini", connect);
  }
  protected override route(model: RoleModel | null) {
    if (!model) throw new Error("Choose a Gemini worker model in router settings");
    return {
      model: model.model.startsWith("agy/") ? model.model : `agy/${model.model}`,
      ...(model.reasoningEffort ? { config: { model_reasoning_effort: model.reasoningEffort } } : {}),
    };
  }
}
export async function runtimeAdapters(options: { url: string; codexBin?: string }): Promise<RuntimeAdapter[]> {
  const module = new URL("../../resources/app-server-connection.mts", import.meta.url);
  const {
    connectAppServer,
  }: {
    connectAppServer: (options: {
      url?: string | undefined;
      engineBin?: string | undefined;
      name: string;
    }) => Connection;
  } = await import(module.href);
  const bridge = (): Connection => connectAppServer({ url: options.url, engineBin: undefined, name: "elpis-agents" });
  const codex = (): Connection =>
    connectAppServer({ url: undefined, engineBin: options.codexBin ?? "codex", name: "elpis-agents" });
  return [new ElpisAdapter(bridge), new CodexAdapter(codex), new ClaudeAdapter(bridge), new GeminiAdapter(bridge)];
}
