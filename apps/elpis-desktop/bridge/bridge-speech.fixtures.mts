import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { PassThrough, Readable } from "node:stream";
import { startDesktopServer } from "./server.mts";
import type { TestContext } from "node:test";
import { required, fixture } from "./bridge.fixtures.mts";

// These requests exercise the same bridge routes as the renderer. The API key and audio are fixtures.
export async function useForSpeechFixture(
  t: TestContext,
  { status = 200, contentType = "audio/mpeg", bytes = Buffer.from("ID3-test-mp3") } = {},
) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-use-for-"));
  const fetches: { url: string; options: RequestInit & { body: string; headers: HeadersInit } }[] = [],
    local: string[] = [];
  const kokoro = {
    available: () => true,
    warm() {},
    close() {},
    async speak(value: string) {
      local.push(value);
      return Buffer.from("local-wav");
    },
  };
  const readAloudFetch: typeof fetch = async (url, options) => {
    assert.ok(options && typeof options.body === "string" && options.headers);
    assert.ok(typeof url === "string" || url instanceof URL);
    const checked: RequestInit & { body: string; headers: HeadersInit } = {
      ...options,
      body: options.body,
      headers: options.headers,
    };
    fetches.push({ url: typeof url === "string" ? url : url.href, options: checked });
    return status === 200
      ? new Response(bytes, { headers: { "content-type": contentType } })
      : new Response("rejected", { status });
  };
  let app: Awaited<ReturnType<typeof startDesktopServer>> | null = null;
  async function start() {
    const f = fixture();
    await f.client.initialize();
    required(f.configRead.layers[0]).name.file = path.join(home, "config.toml");
    f.configRead.config.model_providers.openrouter = {
      name: "OpenRouter",
      base_url: "https://openrouter.ai/api/v1",
      wire_api: "chat",
      experimental_bearer_token: "fixture-key",
    };
    f.configRead.config.model_providers["api-other"] = {
      name: "Other API",
      base_url: "https://example.test/v1",
      wire_api: "responses",
      experimental_bearer_token: "other-fixture-key",
    };
    // Exercise the real HTTP handler without a listening socket (the sandbox can forbid loopback).
    const original = http.createServer;
    let handler: http.RequestListener | undefined;
    Object.assign(http, {
      createServer: (callback: http.RequestListener) => {
        handler = callback;
        return Object.assign(new EventEmitter(), {
          listen: (_port: number, _host: string, ready: () => void) => queueMicrotask(ready),
          address: () => ({ port: 43123 }),
          close: (done: () => void) => done(),
          closeAllConnections: () => {},
        });
      },
    });
    try {
      app = await startDesktopServer({
        client: f.client,
        elpisHome: home,
        kokoro,
        readAloudFetch,
        loveSpot: { directory: path.join(home, "drawing"), screenshots: path.join(home, "screenshots") },
      });
    } finally {
      http.createServer = original;
    }
    const url = new URL(app.url),
      origin = url.origin;
    async function dispatch(route: string, value?: unknown, cookie?: string) {
      const req = Object.assign(Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]), {
        method: value === undefined ? "GET" : "POST",
        url: `/api${route}`,
        headers: { host: url.host, origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      });
      const headers = new Headers();
      let status = 200;
      const res = Object.assign(new PassThrough(), {
        setHeader: (name: string, value: string) => headers.set(name, value),
        removeHeader: (name: string) => headers.delete(name),
        getHeader: (name: string) => headers.get(name),
        writeHead(code: number, fields: Record<string, string> = {}) {
          status = code;
          for (const [key, value] of Object.entries(fields)) headers.set(key, value);
          return this;
        },
      });
      const bytes: Buffer[] = [];
      res.on("data", (chunk: Buffer) => bytes.push(chunk));
      const finished = new Promise<void>((resolve, reject) => {
        res.on("end", resolve);
        res.on("error", reject);
      });
      assert.ok(handler);
      void Reflect.apply(handler, undefined, [req, res]);
      await finished;
      const buffer = Buffer.concat(bytes);
      return { status, headers, json: async () => JSON.parse(buffer.toString()), arrayBuffer: async () => buffer };
    }
    const session = await dispatch("/session", { token: new URLSearchParams(url.hash.slice(1)).get("token") });
    assert.equal(session.status, 200);
    const setCookie = session.headers.get("set-cookie");
    assert.ok(setCookie);
    const cookie = setCookie.split(";")[0];
    return (route: string, value?: unknown) => dispatch(route, value, cookie);
  }
  t.after(async () => {
    if (app) await app.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  return {
    start,
    stop: async () => {
      await required(app).close();
      app = null;
    },
    fetches,
    local,
  };
}
