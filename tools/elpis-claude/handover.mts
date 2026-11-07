// Handing over to a newer bridge while chats work (acp-bridge.mts startDrain).
//
// The old bridge gives up bridge.sock to the newer one at once and keeps running the chats that were working, on a
// private drain socket named in drain.json. The newer bridge sends every request about those chats there, over one
// connection per client, and passes back what comes for them. When such a chat is done, the old bridge says so
// (bridge/released) and the newer bridge asks the client to reconnect, which then reopens the chat in the newer bridge.
import fs from "node:fs";
import WebSocket from "ws";
import { drainFile, startToken } from "./shared-runtime.mts";
import { wireId, wireObject } from "./bridge-wire.mts";

type Id = string | number;
type HandoverMessage = { id?: Id; method?: string; params?: { threadId?: string; [key: string]: unknown }; error?: { code?: number; message?: string }; result?: { thread?: { id?: string }; [key: string]: unknown }; [key: string]: unknown };
type ClientSocket = WebSocket & { pending: Set<Id>; sendWire: (line: string) => void };
type Drain = { pid: number; token: string; sock: string; threads: Set<string> };
type Route = { id: Id; threadId: string; subscribe?: boolean; legacyRead?: boolean };

function handoverMessage(value: unknown): value is HandoverMessage {
  return wireObject(value) && (value.id === undefined || wireId(value.id))
    && (value.method === undefined || typeof value.method === "string")
    && (value.params == null || wireObject(value.params))
    && (value.result == null || wireObject(value.result))
    && (value.error == null || wireObject(value.error));
}

/** Counts the requests a client is waiting on, so it is asked to reconnect only between answers. */
export function trackRequests(ws: ClientSocket) {
  ws.pending = new Set<Id>();
  const wire = ws.sendWire;
  ws.sendWire = (line: string) => {
    if (ws.pending.size) { try { const msg: unknown = JSON.parse(String(line)); if (handoverMessage(msg) && msg.id !== undefined && !msg.method) ws.pending.delete(msg.id); } catch {} }
    wire(line);
  };
  return (msg: HandoverMessage) => { if (msg?.id !== undefined && msg.method) ws.pending.add(msg.id); };
}

/** Asks a client to reconnect once it waits on no answer, or after `capMs` at most. */
export function closeWhenQuiet(ws: ClientSocket, reason: string, capMs = 10_000) {
  const deadline = Date.now() + capMs;
  const attempt = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.pending?.size && Date.now() < deadline) { setTimeout(attempt, 100).unref?.(); return; }
    ws.close(1012, reason);
  };
  attempt();
}

/** The old bridge's drain socket and working chats, while it lives; read again when drain.json changes. */
let drain: Drain | null = null, drainRead = 0, drainStat = "";
export function currentDrain() {
  const now = Date.now();
  if (now - drainRead < 250) return drain;
  drainRead = now;
  let stat;
  try { const st = fs.statSync(drainFile()); stat = `${st.mtimeMs}:${st.size}`; } catch { drain = null; drainStat = ""; return null; }
  if (stat !== drainStat) {
    drainStat = stat;
    try {
      const value: unknown = JSON.parse(fs.readFileSync(drainFile(), "utf8"));
      if (!wireObject(value) || typeof value.pid !== "number" || typeof value.token !== "string" || typeof value.sock !== "string"
        || (value.threads !== undefined && (!Array.isArray(value.threads) || !value.threads.every(thread => typeof thread === "string")))) throw new Error("Invalid drain state");
      drain = value.pid !== process.pid ? { pid: value.pid, token: value.token, sock: value.sock, threads: new Set(value.threads ?? []) } : null;
    } catch { drain = null; }
  }
  if (drain && startToken(drain.pid) !== drain.token) drain = null;
  return drain;
}

/** The newer bridge's side, for one client: `take(msg)` handles (returns true) what belongs to the old bridge. */
export function drainProxy(ws: ClientSocket, log: (message: string) => void = () => {}) {
  let shadow: WebSocket | null = null, initialize: HandoverMessage['params'] | null = null, seq = 0;
  const waiting = new Map<Id, Route>(); // shadow request id -> client request and optional legacy follow
  const asked = new Map<Id, Id>();   // id shown to the client -> the old bridge's own request id
  const touched = new Set<string>(); // chats of the old bridge this client used
  const outbox: string[] = [];
  const reconnect = (why: string) => { log(`drain: asking a client to reconnect (${why})`); closeWhenQuiet(ws, "Session backend changed"); };
  const open = (sock: string) => {
    shadow = new WebSocket(`ws+unix://${sock}:/`);
    shadow.on("open", () => {
      (shadow as WebSocket).send(JSON.stringify({ id: "drain-init", method: "initialize", params: initialize ?? { clientInfo: { name: "elpis-handover" }, capabilities: { experimentalApi: true } } }));
      for (const line of outbox.splice(0)) (shadow as WebSocket).send(line);
    });
    shadow.on("message", (data) => {
      let msg: unknown; try { msg = JSON.parse(String(data)); } catch { return; }
      if (!handoverMessage(msg)) return;
      if (msg.id === "drain-init") return;
      // Another connection of the old bridge may have seen the chat's end first: its last events get a second to arrive.
      if (msg.method === "bridge/released") {
        const id = msg.params?.threadId;
        if (touched.has(id as string)) setTimeout(() => { if (touched.delete(id as string)) reconnect(`chat ${id} moved`); }, 1000).unref?.();
        return;
      }
      if (msg.id !== undefined && !msg.method) {
        if (!waiting.has(msg.id)) return;
        const route = waiting.get(msg.id) as Route; waiting.delete(msg.id);
        if (route.subscribe && msg.error?.code === -32600 && typeof msg.error.message === "string"
          && msg.error.message.startsWith("Invalid request: unknown variant `thread/subscribe`")) {
          const id = `drain-${++seq}`;
          waiting.set(id, { id: route.id, threadId: route.threadId, legacyRead: true });
          send({ id, method: "thread/read", params: { threadId: route.threadId, includeTurns: false } });
          return;
        }
        const result = route.legacyRead && msg.result?.thread?.id === route.threadId
          ? { ...msg.result, followingLive: false } : msg.result;
        ws.sendWire(JSON.stringify({ ...msg, ...(result === undefined ? {} : { result }), id: route.id }));
      } else if (msg.method && msg.id !== undefined) {
        const id = `drain-ask-${++seq}`; asked.set(id, msg.id); log(`drain: the old bridge asks ${msg.method}`);
        ws.sendWire(JSON.stringify({ ...msg, id }));
      } else if (msg.method && touched.has(msg.params?.threadId as string)) ws.sendWire(JSON.stringify(msg));
    });
    shadow.on("close", (code, reason) => { log(`drain: old bridge connection closed (${code} ${reason})`); shadow = null; if (touched.size) reconnect("the old bridge finished"); });
    shadow.on("error", (e) => log(`drain: old bridge connection error: ${e.message}`));
  };
  const send = (msg: HandoverMessage) => {
    const line = JSON.stringify(msg);
    if (shadow?.readyState === WebSocket.OPEN) shadow.send(line); else outbox.push(line);
  };
  return {
    take(msg: HandoverMessage) {
      if (msg?.method === "initialize") initialize = msg.params;
      if (msg?.id !== undefined && !msg.method && asked.has(msg.id)) { const id = asked.get(msg.id) as Id; asked.delete(msg.id); send({ ...msg, id }); return true; }
      const threadId = msg?.params?.threadId;
      if (!msg?.method || typeof threadId !== "string") return false;
      const old = currentDrain();
      if (!old?.threads.has(threadId) && !(shadow && touched.has(threadId))) return false;
      touched.add(threadId);
      if (!shadow) open((old as Drain).sock);
      if (msg.id === undefined) { send(msg); return true; }
      const id = `drain-${++seq}`; waiting.set(id, { id: msg.id, threadId, subscribe: msg.method === "thread/subscribe" });
      send({ ...msg, id });
      return true;
    },
    close() { shadow?.close(); },
  };
}
