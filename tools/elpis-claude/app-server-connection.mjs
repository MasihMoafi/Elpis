// One app-server connection, to the bridge (WebSocket) or the engine (stdio): what the delegate tool and the
// workflow runner use to start and drive helper chats. A helper never asks for approval: there is nobody to
// answer, so every request is declined.
import { spawn } from "node:child_process";
import WebSocket from "ws";

export function connectAppServer({ url, engineBin, name = "elpis-agents", version = "0.3.0" }) {
  const pending = new Map();
  const listeners = new Set();
  const closers = new Set();
  let seq = 0, closed = false;
  let send, close, opened;
  const onMessage = (m) => {
    if (m.id !== undefined && !m.method && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); return; }
    if (m.id !== undefined && m.method) send({ id: m.id, result: { decision: "decline" } });
    for (const l of listeners) l(m);
  };
  const ended = (why) => {
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
    opened = new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    opened.catch(() => {});
    ws.on("message", (d) => { let m; try { m = JSON.parse(d.toString()); } catch { return; } onMessage(m); });
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
      while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { onMessage(JSON.parse(line)); } catch {} } }
    });
    proc.on("exit", () => ended("the engine exited"));
    proc.stdin.on("error", () => {});
    send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
    close = () => proc.kill();
    opened = Promise.resolve();
  }
  const call = (method, params) => new Promise((resolve, reject) => {
    if (closed) { reject({ code: -32603, message: "the connection to Elpis closed", connectionClosed: true }); return; }
    const id = `${name}-${++seq}`;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const ready = opened
    .then(() => call("initialize", { clientInfo: { name, title: null, version }, capabilities: { experimentalApi: true } }))
    .then(() => send({ method: "initialized" }));
  return { call, send, listeners, onClose: (f) => closers.add(f), ready, close, get closed() { return closed; } };
}
