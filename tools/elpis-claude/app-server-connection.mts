// One app-server connection, to the bridge (WebSocket) or the engine (stdio): what the delegate tool and the
// workflow runner use to start and drive helper chats. A helper never asks for approval: there is nobody to
// answer, so requests without a registered handler are declined.
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { wireId,wireObject } from "./bridge-wire.mts";

type RpcMessage = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
type ConnectionOptions = { url?: string | (() => string | undefined) | undefined; engineBin?: string | undefined; name?: string; version?: string };
type Thread = { id: string; model?: string; parentThreadId?: string; status?: { type?: string }; source?: { subAgent?: { thread_spawn?: { parent_thread_id?: string } } } };
type Turn = { id?: string; status?: string; items?: { type: string; command?: string; text?: string }[]; error?: unknown };
type Responses = {
  'config/read': { config?: { mcp_servers?: Record<string, unknown>; [key: string]: unknown }; layers?: { config?: Record<string, unknown> }[] };
  'configRequirements/read': { requirements?: Record<string, unknown> };
  'thread/start': { thread: Thread; model?: string };
  'thread/read': { thread?: Thread };
  'thread/resume': { thread?: Thread; model?: string };
  'thread/turns/list': { data?: Turn[] };
  'turn/start': { turn?: Turn };
  'workflowRun/start': { runId: string; name: string; scriptPath: string };
};

function parseMessage(data: string): RpcMessage {
  const value: unknown = JSON.parse(data);
  if (!wireObject(value) || (value.id !== undefined && !wireId(value.id))
    || (value.method !== undefined && typeof value.method !== "string")) throw new Error("Invalid app-server message envelope");
  return value as RpcMessage;
}

export function connectAppServer({ url, engineBin, name = "elpis-agents", version = "0.3.0" }: ConnectionOptions) {
  const pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  const listeners = new Set<(message: RpcMessage) => void>();
  const requests = new Set<(message: RpcMessage) => boolean>();
  const closers = new Set<(reason: string) => void>();
  let seq = 0, closed = false;
  let send: (message: RpcMessage) => void, close: () => void, opened: Promise<void>;
  const onMessage = (m: RpcMessage) => {
    if (m.id !== undefined && !m.method && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (p) { if (m.error) p.reject(m.error); else p.resolve(m.result); } return; }
    if (m.id !== undefined && m.method && ![...requests].some(handle => handle(m))) send({ id: m.id, result: { decision: "decline" } });
    for (const l of listeners) l(m);
  };
  const ended = (why: string) => {
    if (closed) return;
    closed = true;
    const error = { code: -32603, message: why, connectionClosed: true };
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    for (const c of closers) c(why);
  };
  const target = typeof url === "function" ? url() : url;
  if (target) {
    const ws = new WebSocket(target);
    opened = new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    opened.catch(() => {});
    ws.on("message", (d) => { let m: RpcMessage; try { m = parseMessage(d.toString()); } catch { return; } onMessage(m); });
    ws.on("close", () => ended("the connection to Elpis closed"));
    ws.on("error", () => {});
    send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
    close = () => ws.close();
  } else {
    const proc = spawn(engineBin ?? `${process.env.HOME}/.local/bin/elpis`, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { onMessage(parseMessage(line)); } catch {} } }
    });
    proc.on("exit", () => ended("the engine exited"));
    proc.stdin.on("error", () => {});
    send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
    close = () => proc.kill();
    opened = Promise.resolve();
  }
  function call<K extends keyof Responses>(method: K, params: object): Promise<Responses[K]>;
  function call<T = unknown>(method: string, params: object): Promise<T>;
  function call<T>(method: string, params: object) {
    return new Promise<T>((resolve, reject) => {
      if (closed) { reject({ code: -32603, message: "the connection to Elpis closed", connectionClosed: true }); return; }
      const id = `${name}-${++seq}`;
      pending.set(id, { resolve: value => resolve(value as T), reject });
      send({ id, method, params });
    });
  }
  const ready = opened
    .then(() => call("initialize", { clientInfo: { name, title: null, version }, capabilities: { experimentalApi: true } }))
    .then(() => send({ method: "initialized" }));
  return { call, send, listeners, requests, respond: (id: string | number, result: unknown) => send({ id, result }), onClose: (f: (reason: string) => void) => closers.add(f), ready, close, get closed() { return closed; } };
}
