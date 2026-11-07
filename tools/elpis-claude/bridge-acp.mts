import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { redactedLines } from "./log-redaction.mts";
import { wireId,wireObject } from "./bridge-wire.mts";
import type { ProviderAgent,AcpHandlers,AcpMessage,AcpResponses,AcpUpdate,AcpPermission } from "./bridge-types.mts";

function acpMessage(line: string): AcpMessage {
  const value: unknown = JSON.parse(line);
  if (!wireObject(value) || (value.id !== undefined && !wireId(value.id))
    || (value.method !== undefined && typeof value.method !== "string")) throw new Error("Invalid ACP message envelope");
  return value as AcpMessage;
}

function acpUpdate(value: unknown): AcpUpdate | null {
  if (!wireObject(value) || typeof value.sessionId !== "string" || !wireObject(value.update) || typeof value.update.sessionUpdate !== "string") return null;
  return value as AcpUpdate;
}

function acpPermission(value: unknown): AcpPermission | null {
  if (!wireObject(value) || typeof value.sessionId !== "string" || !Array.isArray(value.options)
    || !value.options.every(option => wireObject(option) && typeof option.optionId === "string" && typeof option.kind === "string")
    || (value.toolCall !== undefined && !wireObject(value.toolCall))) return null;
  return value as AcpPermission;
}

export function lineReader(stream: { on: (event: "data", listener: (chunk: string | Buffer) => void) => unknown }, onLine: (line: string) => void) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
}


export class Acp {
  declare proc: ChildProcessWithoutNullStreams;
  declare nextId: number;
  declare pending: Map<string | number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; method: string; sessionId: string | undefined }>;
  declare bySession: Map<string, AcpHandlers>;
  declare loading: Set<string>;
  declare dead: string | undefined;
  declare ready: Promise<unknown>;
  declare log: (message: string) => void;
  constructor(agent: ProviderAgent, log: (message: string) => void) {
    this.log = log;
    this.proc = spawn("node", [agent.adapter], { env: { ...process.env, ...agent.env }, stdio: ["pipe", "pipe", "pipe"] });
    redactedLines(this.proc.stderr, clean => log(`${agent.key} acp stderr: ${clean.trim().slice(0, 300)}`));
    this.nextId = 1;
    this.pending = new Map();
    // Each session's own handlers: a chat's running turn (also under its Claude subagents'
    // sessions) or a hidden structured request. Chats run at once, so updates and approvals go
    // only to their session's turn; an approval asked by any other session is refused.
    this.bySession = new Map();
    this.loading = new Set(); // sessions being reloaded: their replayed history draws nowhere
    lineReader(this.proc.stdout, (line) => this.#handle(acpMessage(line)));
    this.proc.on("exit", (code) => {
      this.dead = `the ${agent.label} ACP adapter exited (code ${code}). Is it installed at ${agent.adapter}?`;
      for (const p of this.pending.values()) p.reject({ message: this.dead });
      this.pending.clear();
    });
    // `subagents`: each subagent Claude starts gets its own ACP session (subagent_update on its
    // parent's session, its updates under its own), which the bridge draws as an Elpis child thread.
    this.ready = this.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, subagents: {} } });
  }
  send(msg: object) { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"); }
  call<K extends keyof AcpResponses>(method: K, params: { sessionId?: string; [key: string]: unknown }, timeoutMs?: number): Promise<AcpResponses[K]>;
  call<T = unknown>(method: string, params: { sessionId?: string; [key: string]: unknown }, timeoutMs?: number): Promise<T>;
  call<T>(method: string, params: { sessionId?: string; [key: string]: unknown }, timeoutMs = 0): Promise<T> {
    if (this.dead) return Promise.reject({ message: this.dead });
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject({ message: 'Reading Claude context files timed out.' }); }, timeoutMs) : undefined;
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value as T); }, reject: error => { clearTimeout(timer); reject(error); }, method, sessionId: params?.sessionId });
      this.send({ id, method, params });
    });
  }
  settleRecorded(sessionId: string, method: string, result: unknown) {
    for (const [id, pending] of this.pending) if (pending.sessionId === sessionId && pending.method === method) {
      this.pending.delete(id);
      pending.resolve(result);
    }
  }
  async #handle(msg: AcpMessage) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (p) { if (msg.error) p.reject(msg.error); else p.resolve(msg.result); }
    } else if (msg.method === "session/update") {
      const params = acpUpdate(msg.params);
      if (params && !this.loading.has(params.sessionId)) this.bySession.get(params.sessionId)?.onUpdate?.(params);
    } else if (msg.method === "_claude/sdkMessage" && wireObject(msg.params) && wireObject(msg.params.message) && msg.params.message.subtype === "init") {
      // Claude Code's own list of the tools it has this turn.
      const tools = Array.isArray(msg.params.message.tools) ? msg.params.message.tools : [];
      this.log(`claude tools (session ${msg.params.sessionId}): ${tools.join(", ")}`);
    } else if (msg.method === "session/request_permission") {
      const params = acpPermission(msg.params);
      const own = params ? this.bySession.get(params.sessionId) : undefined;
      if (!own) this.log(`approval asked by unknown session ${params?.sessionId} -> refused`);
      const optionId = own?.onPermission && params ? await own.onPermission(params) : null;
      this.send({ id: msg.id, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
    } else if (msg.id !== undefined) {
      this.send({ id: msg.id, error: { code: -32601, message: `client does not support ${msg.method}` } });
    }
  }
  kill() { this.proc.kill(); }
}
