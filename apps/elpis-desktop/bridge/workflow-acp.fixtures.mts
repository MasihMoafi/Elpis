import { createTestTempDir, removeTestTempDir } from "../tests/temp-root.cts";
import { type TestContext } from "node:test";
import type { DesktopClientOptions } from "./client.mts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { DesktopClient } from "./client.mts";
import { createWorkflowRuns } from "./workflow-acp.mts";
import { createMemoryBudget } from "./memory-budget.mts";

export const ROOT = "00000000-0000-0000-0000-000000000001";

export const FATHER = "00000000-0000-0000-0000-00000000000f";

export const FAKE = fileURLToPath(new URL("../../../tools/elpis-claude/test/fake-acp-agent.mts", import.meta.url));

export type WorkflowRun = Awaited<ReturnType<ReturnType<typeof createWorkflowRuns>["list"]>>[number];

export type WorkflowInput = Parameters<ReturnType<typeof createWorkflowRuns>["start"]>[0];

export type NodeSpec = NonNullable<NonNullable<Parameters<typeof createWorkflowRuns>[0]>["nodeSpec"]>;

export type FakeEnv = {
  workflowFake?: Record<string, Record<string, string>>;
  ELPIS_HOME?: string;
  ELPIS_NODE_BIN?: string;
  ELPIS_ENGINE_BIN?: string;
  ELPIS_ACP_AGENT?: string;
};

export type Overrides = { env?: FakeEnv; stateDir?: string; nodeSpec?: NodeSpec };

export type LogRow = {
  method: string;
  params: {
    threadId: string;
    cwd: string;
    developerInstructions: string;
    input: unknown;
    prompt: { text: string }[];
    _meta: {
      elpis: { workflow: { writeScopes: string[]; kind: string; serviceTier?: string } };
      systemPrompt: { append: string };
    };
  };
};

export type SocketRow = LogRow & { id: number };

export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const task = (id: string, dependsOn: string[] = [], instruction = "Seed workflow-acp-739") => ({
  id,
  title: id,
  instruction,
  kind: "explore",
  dependsOn,
  writeScopes: [],
  acceptanceCriteria: ["Return evidence"],
});

export function fixture(t: TestContext, overrides: Overrides = {}, clientOptions: DesktopClientOptions = {}) {
  const tempRoot = createTestTempDir(path.join(os.homedir(), ".cache/elpis-tests/workflow-acp-"));
  const dir = path.join(tempRoot, "project");
  fs.mkdirSync(dir);
  const socket = new EventEmitter() as EventEmitter & {
    sent: SocketRow[];
    close: () => void;
    refuseTurns: number;
    send: (raw: string) => void;
  };
  socket.sent = [];
  socket.close = () => {};
  const root = {
    id: ROOT,
    cwd: dir,
    source: "cli",
    model: "m-fast",
    modelProvider: "openai",
    status: { type: "idle" },
  };
  // Chats the bridge starts (the Father's) are kept, so reading one returns it.
  const threads = new Map([[ROOT, root]]);
  socket.send = raw => {
    const row = JSON.parse(raw) as SocketRow;
    socket.sent.push(row);
    if (!row.id) return;
    const result =
      row.method === "model/list"
        ? {
            data: [
              { id: "m-fast", model: "m-fast" },
              { id: "claude/opus", model: "claude/opus" },
            ],
          }
        : row.method === "thread/list"
          ? { data: [root], nextCursor: null }
          : row.method === "thread/read" || row.method === "thread/resume"
            ? { thread: threads.get(row.params.threadId) ?? root }
            : row.method === "thread/start"
              ? (() => {
                  const made = { ...root, id: FATHER, cwd: row.params.cwd ?? dir };
                  threads.set(FATHER, made);
                  return { thread: made };
                })()
              : row.method === "turn/start" && socket.refuseTurns > 0 && socket.refuseTurns--
                ? { __error: "busy" }
                : row.method === "turn/start"
                  ? { turn: { id: `turn-${socket.sent.length}`, status: "inProgress", items: [] } }
                  : row.method === "workGraph/list"
                    ? { data: [] }
                    : row.method.startsWith("workGraph/run")
                      ? { graphId: "native", threadId: ROOT }
                      : {};
    queueMicrotask(() =>
      socket.emit(
        "message",
        JSON.stringify(
          "__error" in result && result.__error
            ? { id: row.id, error: { code: -32000, message: result.__error } }
            : { id: row.id, result },
        ),
      ),
    );
  };
  const log = (id: string): LogRow[] => {
    const p = path.join(dir, `${id}.jsonl`);
    return fs.existsSync(p)
      ? fs
          .readFileSync(p, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(line => JSON.parse(line) as LogRow)
      : [];
  };
  const client = new DesktopClient(socket, {
    home: overrides.env?.ELPIS_HOME ?? path.join(dir, "profile"),
    rewindHome: path.join(dir, "rewind"),
    reportRetryMs: 20,
    workflowOptions: {
      stateDir: path.join(dir, "state"),
      nodeSpec: ((node, env) => ({
        name: node.name,
        instructions: node.prompt,
        elpis: true,
        command: process.execPath,
        args: [FAKE],
        env: {
          FAKE_ACP_NAME: node.name,
          FAKE_ACP_MODELS: node.name === "Mother agent" ? "opus" : "m-fast",
          FAKE_ACP_LOG: path.join(dir, `${node.name}.jsonl`),
          ...(node.prompt.includes("Return only JSON:")
            ? {
                FAKE_ACP_ANSWER: JSON.stringify({
                  passed: !node.prompt.includes("[fail-check]"),
                  summary: "Observed the planted evidence",
                }),
              }
            : {}),
          ...((env as unknown as FakeEnv).workflowFake?.[node.name] ?? {}),
        },
        model: node.name === "Mother agent" ? "opus" : node.model,
      })) as NodeSpec,
      ...(overrides as unknown as Record<string, unknown> & { env?: NodeJS.ProcessEnv }),
    },
    ...clientOptions,
  });
  t.after(() => {
    client.close();
    removeTestTempDir(tempRoot);
  });
  const run = (tasks: WorkflowInput["tasks"], extra: Partial<Omit<WorkflowInput, "next">> & { next?: object } = {}) =>
    client.runWorkflow({ rootThreadId: ROOT, name: "ACP team", tasks, maxConcurrency: 2, ...extra });
  const finished = async (id: string): Promise<WorkflowRun> => {
    for (let n = 0; n < 500; n++) {
      const g = (await client.workflows(ROOT)).data.find(g => g.id === id);
      // This fixture returns no native work graphs, so every result is an ACP record.
      if (g && g.status !== "running") return g as WorkflowRun;
      await pause(20);
    }
    throw Error("workflow did not finish");
  };
  return { client, socket, dir, root, run, log, finished, fakeEnv: overrides.env };
}

// A41: stages belong to the bridge, not to the Workflows screen, so a run goes on when that screen is closed.
export const staged = async (f: ReturnType<typeof fixture>, id: string) => {
  let graph;
  for (let n = 0; n < 400; n++) {
    graph = (await f.client.workflows(ROOT)).data.find(item => item.id === id) as WorkflowRun | undefined;
    if (
      (graph?.next && ["cancelled", "failed"].includes(graph.next.status)) ||
      graph?.next?.reported ||
      graph?.next?.error
    )
      return graph as WorkflowRun & { next: NonNullable<WorkflowRun["next"]> & { error?: string; reported?: boolean } };
    await pause(25);
  }
  throw Error(`the next stage did not settle: ${JSON.stringify(graph?.next)}`);
};

export const fatherPart = {
  name: "Father agent · Team",
  thread: { name: "Father agent · Team", instructions: "You are the Father agent." },
  tasks: [task("f")],
};

// One bridge runs every workflow under one memory budget (bridge/memory-budget.mjs). Each node holds its turn until `release`.
export function budgetFixture(t: TestContext, budget: ReturnType<typeof createMemoryBudget>) {
  const tempRoot = createTestTempDir(path.join(os.homedir(), ".cache/elpis-tests/workflow-budget-"));
  const dir = path.join(tempRoot, "project");
  fs.mkdirSync(dir);
  const release = path.join(tempRoot, "release");
  const log = (id: string): LogRow[] => {
    const file = path.join(tempRoot, `${id}.jsonl`);
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(line => JSON.parse(line) as LogRow)
      : [];
  };
  const instructions = new Map<string, string>();
  const runs = createWorkflowRuns({
    stateDir: path.join(tempRoot, "state"),
    budget,
    nodeSpec: node => (
      instructions.set(node.name, node.prompt),
      {
        name: node.name,
        command: process.execPath,
        args: [FAKE],
        model: node.model,
        env: {
          FAKE_ACP_NAME: node.name,
          FAKE_ACP_MODELS: "m-fast",
          FAKE_ACP_LOG: path.join(tempRoot, `${node.name}.jsonl`),
          FAKE_ACP_HOLD_TURN: "1",
          FAKE_ACP_RELEASE: release,
        },
      }
    ),
  });
  const record = async (id: string) => {
    const found = (await runs.list()).find(record => record.id === id);
    assert.ok(found);
    return found;
  };
  const until = async (check: () => boolean | Promise<boolean>, message: string) => {
    for (let n = 0; n < 500; n++) {
      if (await check()) return;
      await pause(20);
    }
    assert.fail(message);
  };
  t.after(async () => {
    runs.close();
    await until(async () => (await runs.list()).every(record => record.status !== "running"), "runs stopped");
    removeTestTempDir(tempRoot);
  });
  return {
    log,
    record,
    until,
    instructions,
    release: () => fs.writeFileSync(release, ""),
    cancel: (rootThreadId: string) => runs.cancel(rootThreadId),
    started: (ids: string[]) => ids.filter(id => log(id).some(row => row.method === "session/prompt")),
    start: (rootThreadId: string, tasks: WorkflowInput["tasks"], extra: Partial<WorkflowInput> = {}) =>
      runs.start(
        { rootThreadId, name: rootThreadId, tasks, ...extra },
        { cwd: dir, model: "m-fast", modelProvider: "openai" },
      ),
    finished: async (id: string) => {
      await until(async () => (await record(id)).status !== "running", "workflow did not finish");
      return record(id);
    },
  };
}

export const plenty = { available: async () => 64, app: async () => 0, pollMs: 20 };
