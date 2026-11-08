import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { PassThrough, Readable } from "node:stream";
import { DesktopClient } from "./client.mts";
import { startDesktopServer } from "./server.mts";
import type { TestContext } from "node:test";
import type { DesktopClientOptions } from "./client.mts";
import type { BrowserConfig } from "./client-state.mts";

export type FixtureThread = {
  id: string;
  name?: string | null;
  preview?: string | null;
  agentNickname?: string;
  source?:
    string | { subAgent?: { thread_spawn?: { parent_thread_id?: string; agent_path?: string }; other?: string } };
  cwd?: string;
  path?: string;
  model?: string | null;
  modelProvider?: string;
  status: { type: string };
  archived?: boolean;
  parentThreadId?: string | null;
  forkedFromId?: string;
  canAcceptDirectInput?: boolean;
  collaborationMode?: { mode: string; settings?: object };
  reasoningEffort?: string;
};

export type FixtureParams = {
  threadId?: string;
  rootThreadId?: string;
  turnId?: string;
  expectedTurnId?: string;
  lastTurnId?: string;
  name?: string;
  model?: string;
  modelProvider?: string;
  provider?: string;
  reasoningEffort?: string;
  cursor?: string | null;
  limit?: number;
  archived?: boolean;
  ancestorThreadId?: string;
  sourceKinds?: string[];
  searchTerm?: string;
  config?: Record<string, unknown>;
  edits?: { keyPath: string; value: unknown; mergeStrategy?: string }[];
  input?: { type: string; text?: string }[];
  includeTurns?: boolean;
  additionalContext?: Record<string, { kind: string; value: string }>;
  collaborationMode?: { mode: string; settings: { model: string } };
  [key: string]: unknown;
};

export type FixtureRequest = {
  id?: string | number;
  method?: string;
  params?: FixtureParams;
  result?: unknown;
  error?: { code: number; message?: string };
};

export type FixtureProvider = {
  name?: string;
  base_url?: string;
  env_key?: string;
  wire_api?: string;
  experimental_bearer_token?: string;
  http_headers?: Record<string, string>;
  requires_openai_auth?: boolean;
  auth?: { command: string };
};

export type FixtureLayer = {
  name: { type: string; file: string };
  version: string;
  config: Record<string, unknown>;
  disabledReason?: string;
};

export type FixtureGraph = {
  id: string;
  rootThreadId: string;
  name?: string;
  status?: string;
  tasks: { id: string; title?: string; assignedThreadId?: string; status?: string }[];
};

export type ApprovalEvent =
  | {
      type: "approval";
      data: {
        id: string;
        wireId?: string;
        ownerThreadId: string;
        thread: { name: string };
        params: { threadId: string };
      };
    }
  | { type: "approvalResolved"; data: { id: string } };

export type FixtureOptions = {
  prunerSupported?: boolean;
  omitWorkflowParentInList?: boolean;
  replacementPages?: Record<string, unknown>;
  promptPages?: Record<string, unknown>;
  browserConfig?: BrowserConfig;
  threadListPaging?: boolean;
  archiveDirectory?: string;
  clientOptions?: DesktopClientOptions;
};

export function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

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

export const ROOT = "00000000-0000-0000-0000-000000000001";

export const CHILD = "00000000-0000-0000-0000-000000000002";

export const CREATED = "00000000-0000-0000-0000-000000000003";

export const MODEL = "test-model";

export const FORK = "00000000-0000-0000-0000-000000000007";

// The engine's built-in permission profiles and the sandbox each one runs.
export const PROFILE_SANDBOX: Record<string, { type: string }> = {
  ":workspace": { type: "workspaceWrite" },
  ":danger-full-access": { type: "dangerFullAccess" },
  ":bypass-permissions": { type: "dangerFullAccess" },
};

export function fixture({
  prunerSupported = false,
  omitWorkflowParentInList = false,
  replacementPages,
  promptPages,
  browserConfig,
  threadListPaging = false,
  archiveDirectory = path.join(os.tmpdir(), `bridge-archives-${randomUUID()}`),
  clientOptions = {},
}: FixtureOptions = {}) {
  const workflowRecords: FixtureGraph[] = [];
  let pruner: {
    model: string;
    provider: string;
    version: string;
    providers: { id: string; displayName: string }[];
    systemPrompt: string;
    reasoningEffort?: string | null;
  } = {
    model: "optimizer-original",
    provider: "openai",
    version: "pruner-v1",
    providers: [{ id: "openai", displayName: "OpenAI" }],
    systemPrompt: "PRIVATE CONFIG SECRET",
  };
  const configRead = {
    config: Object.assign(
      {
        model: MODEL,
        model_provider: "openai",
        background_model: "cheap-model",
        background_provider: "local",
        features: { automatic_context_pruning: true } as Record<string, boolean | undefined>,
        memories: { use_memories: true, generate_memories: false } as Record<string, boolean>,
        model_providers: {
          local: {
            name: "Local provider",
            base_url: "http://127.0.0.1:1234/v1?key=PRIVATE CONFIG SECRET",
            http_headers: { Authorization: "PRIVATE CONFIG SECRET" },
          },
          openrouter: {
            name: "OpenRouter",
            base_url: "https://openrouter.ai/api/v1",
            env_key: "APP_TEST_OPENROUTER_KEY",
          },
        } as Record<string, FixtureProvider> & { local: FixtureProvider; openrouter: FixtureProvider },
        mcp_servers: {
          rag: {
            command: "/usr/bin/python",
            args: ["--token", "PRIVATE CONFIG SECRET"],
            env: { OPENROUTER_API_KEY: "PRIVATE CONFIG SECRET", RAG_MCP_BACKEND: "lancedb" },
          },
          whispertype: {
            command: "python",
            env_vars: ["APP_TEST_COMPANY_KEY"],
            env: { WHISPERTYPE_BACKEND: "local", WHISPERTYPE_CLOUD_MODEL: "openai/gpt-4o-mini-transcribe" },
          },
          remote: {
            url: "https://mcp.example/path?token=PRIVATE CONFIG SECRET",
            bearer_token_env_var: "APP_TEST_BEARER",
            enabled: false,
          },
        } as {
          rag?: { command: string; args: string[]; env: Record<string, string>; enabled?: boolean };
          whispertype: { command: string; env_vars: string[]; env: Record<string, string> };
          remote: { url: string; bearer_token_env_var: string; enabled: boolean };
        },
        api_key: "PRIVATE CONFIG SECRET",
      },
      {} as { approval_policy?: string; default_permissions?: string; approvals_reviewer?: string },
    ),
    layers: [
      {
        name: { type: "user", file: "/private/config.toml" },
        version: "user-version",
        config: { secret: "PRIVATE CONFIG SECRET" },
      },
    ] as FixtureLayer[],
  };
  const requirementsRead: { requirements: ({ modelProvider?: string | null } & Record<string, unknown>) | null } = {
    requirements: null,
  };
  const hooksList = {
    data: [
      {
        cwd: "/work",
        warnings: ["hooks.json: unknown field ignored"],
        errors: [],
        hooks: [
          {
            key: "user:/private/hooks.json:pre_tool_use:0:0",
            eventName: "preToolUse",
            handlerType: "command",
            command: "rtk hook claude",
            async: false,
            matcher: "^Bash$",
            timeoutSec: 5,
            statusMessage: "compressing shell output",
            sourcePath: "/home/person/.elpis-next/hooks.json",
            source: "user",
            pluginId: null,
            displayOrder: 0,
            enabled: true,
            isManaged: false,
            currentHash: "sha256:current",
            trustStatus: "untrusted",
          },
          {
            key: "managed:/etc/requirements.toml:stop:0:0",
            eventName: "stop",
            handlerType: "command",
            command: "audit",
            matcher: null,
            timeoutSec: 30,
            statusMessage: null,
            sourcePath: "/etc/requirements.toml",
            source: "system",
            pluginId: null,
            displayOrder: 1,
            enabled: true,
            isManaged: true,
            currentHash: "sha256:managed",
            trustStatus: "managed",
          },
        ],
      },
    ],
  };
  const threads = new Map<string, FixtureThread>([
    [
      ROOT,
      {
        id: ROOT,
        name: "Existing root",
        source: "cli",
        cwd: os.tmpdir(),
        model: MODEL,
        modelProvider: "openai",
        status: { type: "idle" },
      },
    ],
    [
      CHILD,
      {
        id: CHILD,
        name: null,
        preview: "",
        agentNickname: "Sagan",
        model: MODEL,
        modelProvider: "openai",
        parentThreadId: ROOT,
        canAcceptDirectInput: false,
        source: { subAgent: { thread_spawn: { parent_thread_id: ROOT, agent_path: "/root/failure_reporting" } } },
        status: { type: "active" },
      },
    ],
  ]);
  const socket = Object.assign(new EventEmitter(), {
    sent: [] as FixtureRequest[],
    closed: false,
    send: (_raw: string) => {},
    close: () => {},
  });
  // A thread's applied permissions, as the engine reports them in thread/settings/updated and thread/resume.
  const engineSettings = new Map();
  socket.send = raw => {
    const request = JSON.parse(raw);
    socket.sent.push(request);
    if (request.id === undefined || !request.method) return;
    let result;
    switch (request.method) {
      case "initialize":
        result = { userAgent: "protocol-test" };
        break;
      case "config/read":
        result = configRead;
        break;
      case "configRequirements/read":
        result = requirementsRead;
        break;
      case "pruner/read":
        if (prunerSupported) {
          result = pruner;
          break;
        }
        queueMicrotask(() =>
          socket.emit(
            "message",
            JSON.stringify({ id: request.id, error: { code: -32601, message: "Unknown method" } }),
          ),
        );
        return;
      case "pruner/write":
        pruner = {
          ...pruner,
          model: request.params.model,
          provider: request.params.provider,
          reasoningEffort: request.params.reasoningEffort ?? null,
          version: "pruner-v2",
        };
        result = pruner;
        break;
      case "config/batchWrite":
        result = { status: "ok" };
        break;
      case "hooks/list":
        result = hooksList;
        break;
      case "memory/reset":
        result = {};
        break;
      // Like native stored rows, listed threads do not report forkedFromId; thread/read does.
      case "thread/list": {
        let data = [...threads.values()]
          .filter(thread => !!thread.archived === !!request.params.archived)
          .filter(
            thread => !request.params.ancestorThreadId || thread.parentThreadId === request.params.ancestorThreadId,
          );
        let nextCursor = null;
        if (threadListPaging) {
          data = data.filter(
            thread =>
              !request.params.sourceKinds?.length ||
              request.params.sourceKinds.includes(
                typeof thread.source === "object" ? "subAgentThreadSpawn" : thread.source,
              ),
          );
          // Like the engine's index: search matches the first message in exact letter case, not a name given later.
          if (request.params.searchTerm)
            data = data.filter(thread => (thread.preview ?? "").includes(request.params.searchTerm));
          const offset = Number(request.params.cursor ?? 0),
            end = offset + request.params.limit;
          if (end < data.length) nextCursor = String(end);
          data = data.slice(offset, end);
        }
        result = {
          data: data.map(thread => ({
            ...thread,
            forkedFromId: null,
            ...(omitWorkflowParentInList &&
            thread.source &&
            typeof thread.source === "object" &&
            thread.source.subAgent?.other?.startsWith("work_graph:")
              ? { parentThreadId: null }
              : {}),
          })),
          nextCursor,
        };
        break;
      }
      case "thread/read":
        result = { thread: structuredClone(threads.get(request.params.threadId)) };
        break;
      case "thread/subscribe":
        result = { thread: structuredClone(threads.get(request.params.threadId)) };
        break;
      // Like the engine (thread_processor.rs), an archived chat refuses to resume, naming the terminal's command.
      case "thread/resume":
        if (threads.get(request.params.threadId)?.archived) {
          queueMicrotask(() =>
            socket.emit(
              "message",
              JSON.stringify({
                id: request.id,
                error: {
                  code: -32600,
                  message: `session ${request.params.threadId} is archived. Run \`codex unarchive ${request.params.threadId}\` to unarchive it first.`,
                },
              }),
            ),
          );
          return;
        }
        result = {
          ...(engineSettings.has(request.params.threadId)
            ? (({ sandboxPolicy, ...rest }) => ({ ...rest, sandbox: sandboxPolicy }))(
                engineSettings.get(request.params.threadId),
              )
            : {}),
          thread: structuredClone(threads.get(request.params.threadId)),
          model: required(threads.get(request.params.threadId)).model ?? MODEL,
          collaborationMode: required(threads.get(request.params.threadId)).collaborationMode,
          initialTurnsPage: {
            data:
              required(threads.get(request.params.threadId)).status?.type === "active"
                ? [{ id: "running-turn", status: "inProgress" }]
                : [],
          },
        };
        break;
      case "thread/turns/list":
        result = {
          data:
            required(threads.get(request.params.threadId)).status?.type === "active"
              ? [{ id: "running-turn", status: "inProgress" }]
              : [],
        };
        break;
      case "thread/fork": {
        const thread = {
          id: FORK,
          forkedFromId: request.params.threadId,
          source: "appServer",
          canAcceptDirectInput: true,
          model: request.params.model,
          modelProvider: request.params.modelProvider,
          status: { type: "idle" },
        };
        threads.set(FORK, thread);
        result = { thread };
        break;
      }
      case "thread/name/set":
        required(threads.get(request.params.threadId)).name = request.params.name;
        result = {};
        break;
      case "thread/archive":
        required(threads.get(request.params.threadId)).archived = true;
        result = {};
        break;
      case "thread/unarchive":
        delete required(threads.get(request.params.threadId)).archived;
        result = { thread: structuredClone(threads.get(request.params.threadId)) };
        break;
      case "thread/revert":
        result = { thread: { ...structuredClone(threads.get(request.params.threadId)), turns: [] } };
        break;
      case "thread/delete":
        if (request.params.threadId === ROOT && threads.has(FORK)) {
          queueMicrotask(() =>
            socket.emit(
              "message",
              JSON.stringify({
                id: request.id,
                error: { code: -32600, message: `cannot delete thread ${CHILD}: forked history still references it` },
              }),
            ),
          );
          return;
        }
        threads.delete(request.params.threadId);
        if (request.params.threadId === ROOT) threads.delete(CHILD);
        result = {};
        break;
      case "account/read":
        result = {
          account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
          requiresOpenaiAuth: true,
        };
        break;
      case "account/rateLimits/read":
        result = {
          rateLimits: { limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1 } },
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1 },
              secondary: null,
              credits: { balance: "PRIVATE CONFIG SECRET" },
            },
            claude: {
              limitId: "claude",
              limitName: "Claude",
              primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 2 },
              secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 3 },
            },
            "antigravity-pro": {
              limitId: "antigravity-pro",
              limitName: "Gemini Pro",
              primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 4 },
            },
          },
        };
        break;
      case "config/mcpServer/reload":
        result = {};
        break;
      case "thread/items/list":
        result = request.params.turnId
          ? (replacementPages?.[request.params.cursor ?? "start"] ?? {
              data: [
                {
                  turnId: request.params.turnId,
                  item: {
                    type: "userMessage",
                    id: "prompt",
                    content: [{ type: "text", text: "Original prompt", textElements: [] }],
                  },
                },
              ],
              nextCursor: null,
            })
          : (promptPages?.[request.params.cursor ?? "start"] ?? {
              data: [
                {
                  turnId: "t1",
                  item: { type: "agentMessage", id: "item1", text: "Actual fixture transcript" },
                  startedAtMs: 1,
                },
              ],
              nextCursor: null,
            });
        break;
      case "model/list":
        result = {
          data: [
            { id: MODEL, model: MODEL, displayName: "Test model" },
            { id: "claude/opus", model: "claude/opus", displayName: "Opus (Claude subscription)" },
          ],
          nextCursor: null,
        };
        break;
      case "account/logout":
        result = {};
        break;
      case "thread/start": {
        const thread = { id: CREATED, source: "cli", canAcceptDirectInput: true, status: { type: "idle" } };
        threads.set(CREATED, thread);
        result = { thread };
        break;
      }
      case "turn/start":
        required(threads.get(request.params.threadId)).status = { type: "active" };
        result = { turn: { id: "new-turn", status: "inProgress", items: [] } };
        break;
      case "turn/steer":
        result = { turnId: request.params.expectedTurnId };
        break;
      case "turn/settings/update":
        result = { status: "applied" };
        break;
      case "thread/settings/update": {
        // As the engine: the request only queues the change; the applied settings follow in
        // thread/settings/updated, and only when they changed.
        const p = request.params,
          before = JSON.stringify(engineSettings.get(p.threadId) ?? null);
        const applied = p.cwd
          ? { ...engineSettings.get(p.threadId), cwd: p.cwd }
          : p.effort
            ? { ...engineSettings.get(p.threadId), reasoningEffort: p.effort }
            : {
                approvalPolicy: p.approvalPolicy,
                approvalsReviewer: p.approvalsReviewer,
                sandboxPolicy: p.permissions ? PROFILE_SANDBOX[p.permissions] : p.sandboxPolicy,
                activePermissionProfile: p.permissions ? { id: p.permissions } : null,
              };
        if (p.cwd) required(threads.get(p.threadId)).cwd = p.cwd;
        engineSettings.set(p.threadId, applied);
        result = {};
        if (JSON.stringify(applied) !== before)
          setTimeout(
            () =>
              socket.emit(
                "message",
                JSON.stringify({
                  method: "thread/settings/updated",
                  params: {
                    threadId: p.threadId,
                    threadSettings: { ...applied, model: required(threads.get(p.threadId)).model ?? MODEL },
                  },
                }),
              ),
            5,
          );
        break;
      }
      case "turn/interrupt":
        required(threads.get(request.params.threadId)).status = { type: "idle" };
        result = {};
        break;
      case "thread/unsubscribe":
        result = { status: "unsubscribed" };
        break;
      case "workGraph/list":
        result = {
          data: workflowRecords
            .filter(graph => graph.rootThreadId === request.params.rootThreadId)
            .map(graph => ({
              maxConcurrency: 1,
              eventCount: 0,
              worktreeReport: null,
              error: null,
              ...graph,
              name: graph.name ?? graph.id,
              status: graph.status ?? "completed",
              tasks: graph.tasks.map(task => ({
                kind: "implement",
                dependencies: [],
                provider: null,
                model: null,
                result: null,
                evidence: [],
                failureReason: null,
                ...task,
                title: task.title ?? task.id,
                status: task.status ?? "completed",
                assignedThreadId: task.assignedThreadId ?? null,
              })),
            })),
        };
        break;
      case "workGraph/runWithProviders":
      case "workGraph/run":
        result = { graphId: "graph-1", threadId: request.params.rootThreadId, turnId: "workflow-turn" };
        break;
      default:
        throw new Error(`Unexpected protocol method ${request.method}`);
    }
    queueMicrotask(() => socket.emit("message", JSON.stringify({ id: request.id, result })));
  };
  socket.close = () => {
    socket.closed = true;
    socket.emit("close");
  };
  // 156e765a4 adds optional gh instructions. Provider routing tests must not read the operator's connector or credentials.
  const workflowHome = path.join(os.tmpdir(), `bridge-workflows-${randomUUID()}`);
  const client = new DesktopClient(socket, {
    home: workflowHome,
    browserConfig,
    archiveDirectory,
    githubConnector: { instructions: async () => null },
    workflowOptions: {
      stateDir: workflowHome,
      nodeSpec: (node: { name: string; model: string }) => ({
        name: node.name,
        command: process.execPath,
        args: [fileURLToPath(new URL("../../../tools/elpis-claude/test/fake-acp-agent.mts", import.meta.url))],
        env: { FAKE_ACP_MODELS: node.model },
        model: node.model,
      }),
    },
    ...clientOptions,
  });
  return { socket, client, threads, configRead, requirementsRead, workflowRecords, hooksList, engineSettings };
}

/** As the engine answers for a chat it keeps only as whole turns (older history, or a new chat before its first
 * message is recorded): no item pages (-32601), as the TUI's LegacyOnly history expects; thread/read has the turns. */
export function wholeTurnHistory(
  socket: ReturnType<typeof fixture>["socket"],
  turns: { id: string; status: string; items: object[] }[] | null,
) {
  const answer = socket.send;
  socket.send = raw => {
    const request = JSON.parse(raw);
    const reply = (body: Record<string, unknown>) => {
      socket.sent.push(request);
      queueMicrotask(() => socket.emit("message", JSON.stringify({ id: request.id, ...body })));
    };
    if (request.method === "thread/items/list")
      return reply({ error: { code: -32601, message: "thread/items/list is not supported yet" } });
    if (request.method === "thread/read" && request.params.includeTurns)
      return reply(
        turns
          ? {
              result: {
                thread: { id: request.params.threadId, name: "Existing root", status: { type: "idle" }, turns },
              },
            }
          : {
              error: {
                code: -32600,
                message: `thread ${request.params.threadId} is not materialized yet; includeTurns is unavailable before first user message`,
              },
            },
      );
    return answer(raw);
  };
}
