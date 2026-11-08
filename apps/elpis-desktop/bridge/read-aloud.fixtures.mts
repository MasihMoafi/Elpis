import { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import * as native from "./client.mts";
import { startDesktopServer } from "./server.mts";

export type Request = {
  id?: number;
  method: string;
  params: {
    threadId: string;
    voice: string;
    model: string;
    modelProvider: string;
    text: string;
    transport: { type: string };
    input: { text: string }[];
    [key: string]: unknown;
  };
};

export type SpeechEvent = { type: string; id: string; [key: string]: unknown };

export type TestState = {
  account: string | null;
  provider: string;
  voice: string;
  configModel: string;
  listed: string[];
  holdStart: boolean;
  failAppend: boolean;
  holdCleanup: boolean;
  busy: boolean;
  model?: string;
  finishStart?: () => void;
  finishCleanup?: () => void;
  beforeTurnAnswer?: (turn: { id: string; status: string }) => void;
};

export type TestResponse = EventEmitter & {
  body: ReadableStream<Uint8Array>;
  status: number;
  destroyed: boolean;
  headersSent: boolean;
  headers: { get: (name: string) => string | undefined };
  setHeader: (name: string, value: string) => void;
  writeHead: (status: number, values?: Record<string, string>) => void;
  flushHeaders: () => void;
  write: (line: string) => void;
  end: (line?: string) => void;
  destroy: () => void;
  text: () => Promise<string>;
};

export function required<T>(value: T | null | undefined): T {
  assert.ok(value);
  return value;
}

export const CHAT = "00000000-0000-0000-0000-000000000001";

export const SPEECH = "00000000-0000-0000-0000-000000000002";

export const OTHER = "00000000-0000-0000-0000-000000000003";

export const offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n";

export const until = async (check: () => unknown, _what?: string) => {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "speech operation did not finish");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

export async function fixture(t: TestContext, { loveSpotAudio }: { loveSpotAudio?: { available: boolean } } = {}) {
  const controls: SpeechEvent[] = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-read-aloud-"));
  const socket = new EventEmitter() as EventEmitter & {
    sent: Request[];
    close: () => void;
    send: (raw: string) => void;
  };
  socket.sent = [];
  socket.close = () => {};
  const state: TestState = {
    account: "chatgpt",
    provider: "openai",
    voice: "juniper",
    configModel: "gpt-6.1-sol",
    listed: ["claude/opus", "gpt-6.1-luna"],
    holdStart: false,
    failAppend: false,
    holdCleanup: false,
    busy: false,
  };
  const notify = (method: string, params: Record<string, unknown>) => {
    if (method === "turn/completed" && params.threadId === CHAT) state.busy = false;
    socket.emit("message", JSON.stringify({ method, params }));
  };
  socket.send = raw => {
    const request = JSON.parse(raw) as Request;
    socket.sent.push(request);
    if (!request.id) return;
    const answer = (result: unknown) => socket.emit("message", JSON.stringify({ id: request.id, result }));
    queueMicrotask(() => {
      if (request.method === "account/read")
        return answer({ account: state.account === null ? null : { type: state.account } });
      if (request.method === "config/read")
        return answer({
          config: { realtime: { voice: state.voice }, model: state.configModel, model_provider: "openai" },
        });
      if (request.method === "model/list")
        return answer({ data: state.listed.map(model => ({ id: model, model })), nextCursor: null });
      if (request.method === "thread/realtime/listVoices")
        return answer({ voices: { v1: ["cove", "juniper"], defaultV1: "cove" } });
      if (request.method === "thread/read") {
        answer({
          thread: {
            id: request.params.threadId,
            model: state.model ?? (state.provider === "openai" ? "gpt-5" : "claude/sonnet"),
            modelProvider: state.provider,
            status: { type: state.busy ? "active" : "idle" },
          },
        });
        return;
      }
      if (request.method === "thread/resume") return answer({ thread: { id: CHAT } });
      // The first private thread is SPEECH; later ones get their own ids.
      if (request.method === "thread/start") {
        const n = socket.sent.filter(row => row.method === "thread/start").length;
        return answer({
          thread: {
            id: n === 1 ? SPEECH : `00000000-0000-0000-0000-${String(100 + n).padStart(12, "0")}`,
            ephemeral: true,
          },
        });
      }
      if (request.method === "turn/start") {
        state.busy = true;
        const turn = {
          id: `voice-turn-${socket.sent.filter(row => row.method === "turn/start").length}`,
          status: "inProgress",
          items: [],
        };
        state.beforeTurnAnswer?.(turn);
        return answer({ turn });
      }
      if (request.method === "thread/realtime/appendSpeech" && state.failAppend)
        return socket.emit(
          "message",
          JSON.stringify({ id: request.id, error: { code: -32000, message: "fixture speech failure" } }),
        );
      if (request.method === "thread/unsubscribe" && state.holdCleanup) {
        state.finishCleanup = () => answer({});
        return;
      }
      if (request.method === "thread/realtime/start") {
        state.finishStart = () => {
          notify("thread/realtime/sdp", { threadId: request.params.threadId, sdp: "v=0\r\nanswer" });
          answer({});
        };
        if (!state.holdStart) state.finishStart();
        return;
      }
      answer({});
    });
  };
  const client = new native.DesktopClient(socket, {
    timeoutMs: 3000,
    rewindHome: path.join(root, "rewind"),
    workflowOptions: { stateDir: path.join(root, "workflows") },
    spawnLinksFile: path.join(root, "spawn.json"),
  });
  // Exercise the HTTP handler without binding a port: this sandbox forbids listen().
  let handler: http.RequestListener | undefined;
  const originalCreate = http.createServer;
  const create = mock.method(http, "createServer", ((callback: http.RequestListener) => {
    handler = callback;
    const server = originalCreate(callback);
    server.listen = ((...args: unknown[]) => {
      const callback = args.at(-1);
      assert.ok(typeof callback === "function");
      queueMicrotask(() => callback());
      return server;
    }) as typeof server.listen;
    server.address = () => ({ port: 43210 }) as import("node:net").AddressInfo;
    return server;
  }) as typeof http.createServer);
  let app;
  try {
    app = await startDesktopServer({
      client,
      elpisHome: root,
      loveSpotAudio,
      trashFile: path.join(root, "trash.json"),
      loveSpot: { directory: path.join(root, "board"), screenshots: path.join(root, "shots") },
    });
  } finally {
    create.mock.restore();
  }
  const handle = handler;
  assert.ok(handle);
  t.after(async () => {
    state.finishStart?.();
    state.finishCleanup?.();
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const url = new URL(app.url),
    token = new URLSearchParams(url.hash.slice(1)).get("token");
  let cookie = "";
  const post = async (route: string, body: unknown, signal?: AbortSignal) => {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(request, {
      method: "POST",
      url: "/api/" + route,
      headers: { host: url.host, cookie, origin: url.origin, "content-type": "application/json" },
    });
    const response = new EventEmitter() as TestResponse,
      headers = new Map<string, string>();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    response.body = new ReadableStream({
      start(controller) {
        stream = controller;
      },
      cancel() {
        response.destroy();
      },
    });
    response.setHeader = (name, value) => headers.set(name.toLowerCase(), value);
    response.writeHead = (status, values = {}) => {
      response.status = status;
      for (const [name, value] of Object.entries(values)) response.setHeader(name, value);
      response.headersSent = true;
      response.emit("headers");
    };
    response.flushHeaders = () => {};
    response.write = line => {
      controls.push(JSON.parse(line) as SpeechEvent);
      if (!response.destroyed) required(stream).enqueue(new TextEncoder().encode(line));
    };
    response.end = line => {
      if (response.destroyed) return;
      if (line) response.write(line);
      response.destroyed = true;
      try {
        required(stream).close();
      } catch {}
      response.emit("close");
    };
    response.destroy = () => response.end();
    response.text = () => new Response(response.body).text();
    response.headers = { get: name => headers.get(name.toLowerCase()) };
    signal?.addEventListener("abort", () => response.destroy(), { once: true });
    const sent = new Promise(resolve => response.once("headers", resolve));
    // The handler is exercised against the partial request and response implemented above.
    Reflect.apply(handle, undefined, [request, response]);
    await sent;
    return response;
  };
  const auth = await post("session", { token });
  cookie = required(required(auth.headers.get("set-cookie")).split(";")[0]);
  const methods = (name: string) => socket.sent.filter(row => row.method === name);
  const open = async (text: string | null = "Read these words exactly.", { live = false } = {}) => {
    const controller = new AbortController();
    const response = await post(
      live ? "voice" : text === null ? "love-spot/voice" : "voice/read-aloud",
      live ? { threadId: CHAT, sdp: offer } : text === null ? { sdp: offer } : { threadId: CHAT, text, sdp: offer },
      controller.signal,
    );
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let pending = "";
    const next = async (): Promise<SpeechEvent> => {
      while (!pending.includes("\n")) {
        const row = await reader.read();
        assert.equal(row.done, false);
        pending += new TextDecoder().decode(row.value);
      }
      const index = pending.indexOf("\n"),
        line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      const event = JSON.parse(line) as SpeechEvent;
      return event.type === "cue" ? next() : event;
    };
    return { controller, reader, next };
  };
  return { state, notify, post, methods, open, app, socket, client, controls };
}
