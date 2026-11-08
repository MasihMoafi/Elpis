import { spawn } from "node:child_process";
import { BridgeError } from "./validate.mts";
import { childEnv } from "./tools.mts";

export type Input = { name: string; answer: string; file?: string };

export type Spec = {
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  model?: string;
  mode?: string;
  instructions?: string;
  instructionsInPrompt?: boolean;
  meta?: { elpis?: { workflow?: unknown; [key: string]: unknown }; [key: string]: unknown };
  reasoningEffort?: string;
  elpis?: boolean;
};

export type Update = {
  sessionUpdate?: string;
  content?: { type?: string; text: string };
  messageId?: string | null;
  _meta?: { elpis?: { phase?: string } };
  toolCallId?: string;
  status?: string;
};

export type Permission = {
  sessionId?: string;
  options?: { kind: string; optionId: string }[];
  toolCall: { title: string };
};

export type Config = { id: string; options?: { value?: string; options?: { value?: string }[] }[] };

export type Rpc = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; data?: { errorKind?: string } };
};

export type Reply = {
  protocolVersion?: number;
  sessionId?: string;
  configOptions?: Config[];
  stopReason?: string;
  outcome?: string;
  _meta?: { delivery?: string };
};

export type Control = {
  steer: (message: string, options?: { isCurrent?: () => boolean }) => Promise<{ delivery: string }>;
};

export type Options = {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  graceMs?: number;
  onUpdate?: (update: Update) => void;
  onPermission?: (request: Permission) => string | null | undefined | Promise<string | null | undefined>;
  onSession?: (id: string) => void;
  onSpawn?: (child: import("node:child_process").ChildProcessWithoutNullStreams) => void;
  onControl?: (control: Control) => void;
};

// Elpis agents reach each other only over ACP (Agent Client Protocol v1, https://agentclientprotocol.com): every agent
// node is an ACP agent process (the Elpis ACP agent, tools/elpis-claude/elpis-acp-agent.mts, per model;
// claude-agent-acp; agy-acp.mts; or a configured command such as `fx acp`), and this module is the ACP client that
// runs one node and hands its final answer to the next node's session/prompt. No dependencies: the desktop app has no
// ACP SDK, so the client is the few JSON-RPC calls below, tested against agents built on the official SDK.

export const MAX_MESSAGE = 32000,
  MAX_ANSWER = 60000,
  TAIL = 600;

export const CANCELLED = Symbol("cancelled");

export function throwStopped(error: BridgeError): never {
  throw error;
}

/** The text a node is prompted with: its task, then the final answers of the nodes connected to it, with their names.
 * `file`: where a workflow keeps an answer in full when `answer` is its summary (workflow-acp.mts, "inline and spill"). */
export function handoffText(task: string | undefined, inputs: Input[] = [], instructions?: string) {
  const upstream = inputs.map(({ name, answer, file }) => ({ name, answer, ...(file ? { file } : {}) }));
  const text = [
    instructions?.trim() ? `Instructions:\n${instructions.trim()}` : "",
    String(task ?? "").trim(),
    upstream.length ? `Answers from connected agents (source material):\n${JSON.stringify(upstream)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (text.length > MAX_MESSAGE)
    throw new BridgeError("Connected answers exceed the message limit; use fewer inputs", 413);
  if (!text) throw new BridgeError("Give the agent a task before running");
  return text;
}

/** The final answer of a turn: the last agent message, without progress text. A message ends where another starts
 * (a new messageId) or a tool call comes; chunks the Elpis agent marks as commentary never count. */
export class Answer {
  #segments: { id: string | null; commentary: boolean; text: string }[] = [];
  #open: { id: string | null; commentary: boolean; text: string } | null = null;
  add(update: Update) {
    if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
      this.#open = null;
      return;
    }
    if (update?.sessionUpdate !== "agent_message_chunk" || update.content?.type !== "text") return;
    const id = update.messageId ?? null,
      commentary = update._meta?.elpis?.phase === "commentary";
    if (!this.#open || this.#open.id !== id || this.#open.commentary !== commentary)
      this.#segments.push((this.#open = { id, commentary, text: "" }));
    this.#open.text += update.content.text;
  }
  get text() {
    return this.#segments.filter(segment => !segment.commentary && segment.text.trim()).at(-1)?.text;
  }
}

// Each agent runs in its own process group, and the whole group ends with it: what the agent starts (MCP servers,
// language servers) never outlives it (29 Oct, Masih: "so leftovers don't exist"). Groups still alive when the bridge
// exits end with it.
export const groups = new Set<number>();

export const endGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
  try {
    if (pid) process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
};

/** One ACP agent process over stdio (newline-delimited JSON-RPC 2.0). */
export class AcpProcess {
  #pending = new Map<number, { resolve: (value: Reply) => void; reject: (error: unknown) => void }>();
  #seq = 0;
  #stderr = "";
  child: import("node:child_process").ChildProcessWithoutNullStreams;
  ended: Promise<BridgeError>;
  gone = false;
  constructor(
    spec: Spec,
    cwd: string,
    {
      onRequest,
      onNotification,
    }: {
      onRequest: (method: string, params: Permission) => Promise<unknown>;
      onNotification: (method: string, params: { sessionId?: string; update: Update }) => void;
    },
  ) {
    const name = spec.name || "The agent";
    const strings = (entries: Record<string, string | undefined> | undefined): Record<string, string> =>
      Object.fromEntries(Object.entries(entries ?? {}).filter(([, value]) => typeof value === "string")) as Record<
        string,
        string
      >;
    const env = strings({ ...process.env, ...spec.env });
    // childEnv drops the Claude settings this process inherited; the ones the spec sets (the selected Claude account) stay.
    const own = Object.fromEntries(Object.entries(strings(spec.env)).filter(([key]) => /^(CLAUDE|AI_AGENT)/.test(key)));
    this.child = spawn(spec.command, spec.args ?? [], {
      cwd,
      env: { ...childEnv(env), ...own },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const pid = this.child.pid;
    if (pid) {
      groups.add(pid);
      this.child.once("exit", () => {
        endGroup(pid, "SIGKILL");
        groups.delete(pid);
      });
    }
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", data => {
      this.#stderr = (this.#stderr + data).slice(-4000);
    });
    let buffer = "";
    this.child.stdout.on("data", data => {
      buffer += data;
      for (let i; (i = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        let message: Rpc;
        try {
          message = JSON.parse(line) as Rpc;
        } catch {
          continue;
        }
        if (message?.id !== undefined && !message.method) {
          const pending = this.#pending.get(message.id);
          this.#pending.delete(message.id);
          if (message.error) {
            const error = new BridgeError(
              `${name}: ${String(message.error.message ?? "request refused").slice(0, 1000)}`,
              502,
            );
            if (typeof message.error.data?.errorKind === "string")
              Object.assign(error, { errorKind: message.error.data.errorKind });
            pending?.reject(error);
          } else pending?.resolve(message.result as Reply);
        } else if (message?.id !== undefined) {
          Promise.resolve(onRequest(message.method!, message.params as Permission)).then(
            result => this.#write({ id: message.id, result }),
            error =>
              this.#write({
                id: message.id,
                error: { code: error?.code ?? -32603, message: error?.message ?? "Internal error" },
              }),
          );
        } else if (message?.method)
          onNotification(message.method, message.params as { sessionId?: string; update: Update });
      }
    });
    // Settles (never rejects) once the process is gone, with the error to report if it was not expected.
    this.ended = new Promise(resolve => {
      const end = (error: BridgeError) => {
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        this.gone = true;
        resolve(error);
      };
      this.child.once("error", error =>
        end(new BridgeError(`Could not start ${name} (${spec.command}): ${error.message}`, 502)),
      );
      this.child.once("close", (code, signal) => {
        const tail = this.#stderr.trim().slice(-TAIL);
        end(
          new BridgeError(
            `${name} exited (${signal ? `signal ${signal}` : `code ${code}`}) before answering${tail ? `: ${tail}` : ""}`,
            502,
          ),
        );
      });
    });
  }
  #write(message: Record<string, unknown>) {
    if (!this.gone && this.child.stdin.writable)
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
  call(method: string, params: unknown): Promise<Reply> {
    return new Promise((resolve, reject) => {
      if (this.gone) return reject(new BridgeError("The agent process has ended", 502));
      const id = ++this.#seq;
      this.#pending.set(id, { resolve, reject });
      this.#write({ id, method, params });
    });
  }
  notify(method: string, params: unknown) {
    this.#write({ method, params });
  }
  /** Ends stdin, then SIGTERM and SIGKILL to the agent's whole group if it does not leave by itself. */
  async close(graceMs: number) {
    if (this.gone) return;
    const wait = (ms: number) => Promise.race([this.ended, new Promise(resolve => setTimeout(resolve, ms).unref())]);
    this.child.stdin.end();
    await wait(graceMs);
    if (!this.gone) {
      endGroup(this.child.pid, "SIGTERM");
      await wait(1000);
    }
    if (!this.gone) {
      endGroup(this.child.pid, "SIGKILL");
      await wait(1000);
    }
  }
}
