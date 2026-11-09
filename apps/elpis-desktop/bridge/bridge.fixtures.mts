import { required, ROOT, CHILD, CREATED, MODEL, FORK, PROFILE_SANDBOX } from "./bridge-data.fixtures.mts";
export { required, ROOT, CHILD, CREATED, MODEL, FORK, PROFILE_SANDBOX } from "./bridge-data.fixtures.mts";
import { fixtureData } from "./bridge-data.fixtures.mts";
import type { FixtureRequest } from "./bridge-fixture-types.fixtures.mts";
export type { FixtureThread, FixtureParams, FixtureRequest, FixtureProvider, FixtureLayer, FixtureGraph, ApprovalEvent, FixtureOptions } from "./bridge-fixture-types.fixtures.mts";
import { fileURLToPath } from "node:url";

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import os from "node:os";
import path from "node:path";

import { DesktopClient } from "./client.mts";

export function fixture(props: Parameters<typeof fixtureData>[0] = {}) {
  const data = fixtureData(props);
  const { configRead, requirementsRead, prunerSupported, hooksList, threads, threadListPaging, omitWorkflowParentInList, replacementPages, promptPages, workflowRecords, browserConfig, archiveDirectory, clientOptions } = data;
  let { pruner } = data;
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
