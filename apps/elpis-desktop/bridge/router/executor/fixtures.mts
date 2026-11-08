import { object, type Connection } from "./adapters.mts";
/** Protocol fixture: owns runtime history independently of the executor's receipts; never calls a model. */
export class FakeServer {
  readonly calls: {
    method: string;
    params: Record<string, unknown>;
  }[] = [];
  readonly threads = new Map<
    string,
    {
      model: string;
      turns: {
        id: string;
        status: string;
        items: object[];
      }[];
    }
  >();
  readonly connections = new Set<Connection>();
  readonly jobs = new Map<
    string,
    {
      id: string;
      label: string;
    }[]
  >();
  readonly parents = new Map<string, string>();
  failure: ((method: string, params: Record<string, unknown>) => Error | undefined) | undefined;
  hold: ((method: string, params: Record<string, unknown>) => Promise<void>) | undefined;
  private seq = 0;
  private readonly answers = new Map<string, (result: unknown) => void>();
  async tool(
    threadId: string,
    tool: string,
    args: unknown,
  ): Promise<{
    success: boolean;
    value: unknown;
  }> {
    const id = `tool-${++this.seq}`;
    const answer = new Promise<unknown>(resolve => this.answers.set(id, resolve));
    const request = { id, method: "item/tool/call", params: { threadId, tool, arguments: args } };
    let handled = false;
    for (const conn of this.connections)
      if ([...(conn.requests ?? [])].some(handle => handle(request))) {
        handled = true;
        break;
      }
    if (!handled) throw new Error("No runtime owns this tool request");
    const result = object(await answer),
      items = result.contentItems;
    const first = Array.isArray(items) ? object(items[0]) : {};
    const text = typeof first.text === "string" ? first.text : "";
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = first.type === "inputImage" ? { image_url: first.imageUrl } : text;
    }
    return { success: result.success === true, value };
  }
  connect = (): Connection => {
    let closed = false;
    const listeners = new Set<(message: unknown) => void>(),
      closers = new Set<(why: string) => void>();
    const connection: Connection = {
      ready: Promise.resolve(),
      get closed() {
        return closed;
      },
      listeners,
      requests: new Set(),
      respond: (id, result) => {
        this.answers.get(String(id))?.(result);
        this.answers.delete(String(id));
      },
      call: async (method, raw) => {
        const params = object(raw);
        this.calls.push({ method, params });
        await this.hold?.(method, params);
        const failure = this.failure?.(method, params);
        if (failure) throw failure;
        if (method === "config/read") return { config: { mcp_servers: { personal: {}, approved: {} } } };
        if (method === "thread/start") {
          const id = `thread-${++this.seq}`;
          this.threads.set(id, { model: typeof params.model === "string" ? params.model : "default", turns: [] });
          return { thread: { id }, model: params.model ?? "default" };
        }
        if (method === "thread/name/set") return {};
        if (method === "thread/list")
          return {
            data: [...this.parents].flatMap(([id, parent]) =>
              parent === params.ancestorThreadId
                ? [
                    {
                      id,
                      status: {
                        type: this.threads.get(id)?.turns.some(turn => turn.status === "inProgress")
                          ? "active"
                          : "idle",
                      },
                    },
                  ]
                : [],
            ),
            nextCursor: null,
          };
        const threadId = String(params.threadId),
          thread = this.threads.get(threadId);
        if (!thread) throw Object.assign(new Error("Thread not found"), { code: -32600 });
        if (method === "thread/resume" || method === "thread/read")
          return { thread: { id: threadId, model: thread.model, turns: thread.turns } };
        if (method === "thread/turns/list") return { data: [...thread.turns].reverse(), nextCursor: null };
        if (method === "thread/backgroundTerminals/list")
          return {
            data: (this.jobs.get(threadId) ?? []).map(job => ({ processId: job.id, command: job.label })),
            nextCursor: null,
          };
        if (method === "thread/backgroundTerminals/terminate") {
          const jobs = this.jobs.get(threadId) ?? [],
            selected = jobs.find(job => job.id === params.processId);
          this.jobs.set(
            threadId,
            jobs.filter(job => job !== selected),
          );
          return { terminated: !!selected };
        }
        if (method === "turn/start" || method === "turn/steer") {
          const turn =
            method === "turn/start"
              ? { id: `turn-${++this.seq}`, status: "inProgress", items: [] as object[] }
              : thread.turns.find(turn => turn.id === params.expectedTurnId);
          if (!turn || turn.status !== "inProgress")
            throw Object.assign(new Error("no active turn to steer"), { code: -32600 });
          turn.items.push({ type: "userMessage", content: params.input });
          if (method === "turn/start") thread.turns.push(turn);
          this.emit(threadId, "turn/started", { turn });
          return { turn, turnId: turn.id };
        }
        if (method === "turn/interrupt") {
          this.finish(threadId, "interrupted");
          return {};
        }
        throw new Error(`Unexpected method ${method}`);
      },
      onClose: listener => closers.add(listener),
      close: () => {
        closed = true;
        this.connections.delete(connection);
        for (const close of closers) close("fixture closed");
      },
    };
    this.connections.add(connection);
    return connection;
  };
  emit(threadId: string, method: string, params: object): void {
    for (const conn of this.connections)
      for (const listener of conn.listeners) listener({ method, params: { threadId, ...params } });
  }
  finish(threadId: string, status = "completed", text = "Done"): void {
    const turn = this.threads.get(threadId)?.turns.findLast(turn => turn.status === "inProgress");
    if (!turn) return;
    turn.status = status;
    turn.items.push({ id: `answer-${turn.id}`, type: "agentMessage", text });
    this.emit(threadId, "item/completed", { item: { type: "agentMessage", text } });
    this.emit(threadId, "turn/completed", { turn });
  }
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function waitFor(check: () => void | Promise<void>, timeoutMs = 3000): Promise<void> {
  const { setTimeout: poll } = await import("node:timers/promises");
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (performance.now() >= deadline) throw error instanceof Error ? error : new Error(String(error));
    }
    await poll(Math.min(10, Math.max(1, deadline - performance.now())));
  }
}
