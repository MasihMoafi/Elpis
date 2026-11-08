import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopClient } from "../client.mts";
import { MotherAgent } from "./mother-agent.mts";
import { ElpisAdapter } from "./executor/adapters.mts";
import { FakeServer } from "./executor/fixtures.mts";
import { createServer } from "node:http";
import { once } from "node:events";

export const CHAT = "00000000-0000-0000-0000-000000000001";

export async function panel<T>(
  mother: MotherAgent,
  path: string,
  value?: unknown,
  method = value === undefined ? "GET" : "PUT",
): Promise<T> {
  const server = createServer((req, res) => {
    void mother.handle(req, res, String((server.address() as { port: number }).port));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/mother/${path}`, {
      method,
      headers: { "x-orchestrator-request": "1", "content-type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const body = (await response.json()) as T;
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

export function fixture({ fresh = false, native = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "mother-bridge-")),
    workers = new FakeServer();
  if (!fresh) {
    mkdirSync(join(home, "router"), { recursive: true });
    writeFileSync(join(home, "router", "mother.json"), JSON.stringify({ enabled: false }));
  }
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let adapterStarts = 0,
    created = false,
    name = "",
    configured = true,
    archived = false;
  const socket = Object.assign(new EventEmitter(), {
    close() {},
    send(raw: string) {
      const request = JSON.parse(raw) as { id?: string; method: string; params: Record<string, unknown> };
      if (!request.id) return;
      calls.push(request);
      let result: object;
      switch (request.method) {
        case "initialize":
          result = {};
          break;
        case "config/read":
          result = {
            config: {
              model: configured ? "chosen-main" : null,
              model_provider: "openai",
              background_model: configured ? "chosen-background" : null,
              background_provider: "openai",
            },
            layers: [{ name: { type: "user", file: join(home, "config.toml") }, version: "v1" }],
          };
          break;
        case "configRequirements/read":
          result = { requirements: null };
          break;
        case "pruner/read":
          result = {};
          break;
        case "experimentalFeature/list":
          result = { data: [] };
          break;
        case "model/list":
          result = {
            data: ["chosen-main", "chosen-background", "router-saved", "worker-saved"].map(model => ({
              id: model,
              model,
              displayName: model,
              supportedReasoningEfforts: [],
            })),
          };
          break;
        case "thread/start":
          created = true;
          result = {
            thread: { id: CHAT, name, status: { type: "idle" } },
            model: request.params.model,
            modelProvider: "openai",
          };
          break;
        case "thread/name/set":
          name = String(request.params.name);
          result = {};
          break;
        case "thread/list":
          result = { data: [] };
          break;
        case "thread/archive":
          archived = true;
          result = {};
          break;
        case "thread/unarchive":
          archived = false;
          result = { thread: { id: CHAT } };
          break;
        case "thread/resume":
          result = {
            thread: {
              id: CHAT,
              name,
              path: join(home, archived ? "archived_sessions" : "sessions", `${CHAT}.jsonl`),
              status: { type: "idle" },
            },
          };
          break;
        case "thread/delete":
          created = false;
          result = {};
          break;
        case "thread/read":
          if (!created) {
            queueMicrotask(() =>
              socket.emit(
                "message",
                JSON.stringify({ id: request.id, error: { code: -32600, message: "thread not found" } }),
              ),
            );
            return;
          }
          result = {
            thread: {
              id: CHAT,
              name,
              path: join(home, archived ? "archived_sessions" : "sessions", `${CHAT}.jsonl`),
              status: { type: "idle" },
            },
          };
          break;
        case "thread/items/list":
          result = { data: [], nextCursor: null };
          break;
        case "thread/unsubscribe":
          result = {};
          break;
        default:
          throw new Error(`Unexpected RPC ${request.method}`);
      }
      queueMicrotask(() => socket.emit("message", JSON.stringify({ id: request.id, result })));
    },
  });
  const client = new DesktopClient(socket, { home, appHome: home, githubConnector: { instructions: async () => "" } });
  const create = () =>
    new MotherAgent({
      client,
      home,
      ...(native
        ? {}
        : {
            adapters: async () => {
              adapterStarts++;
              return [new ElpisAdapter(workers.connect)];
            },
          }),
    });
  return {
    home,
    workers,
    calls,
    socket,
    client,
    create,
    get name() {
      return name;
    },
    get adapterStarts() {
      return adapterStarts;
    },
    unsetDefaults() {
      configured = false;
    },
    archiveExternally() {
      archived = true;
    },
  };
}

export const roles = (suffix: string) => ({
  dispatch: { provider: "openai", model: `router-${suffix}` },
  worker: { provider: "openai", model: `worker-${suffix}` },
});
