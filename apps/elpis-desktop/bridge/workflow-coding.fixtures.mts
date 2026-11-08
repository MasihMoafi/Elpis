import { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWorkflowRuns } from "./workflow-acp.mts";
import { DesktopClient } from "./client.mts";
import { EventEmitter } from "node:events";
import type { StoredTask, WorkflowOptions, WorkflowParams } from "./workflow-acp/types.mts";

export type NodeSpec = NonNullable<WorkflowOptions["nodeSpec"]>;

export type FakeLog = {
  method?: string;
  params?: { configId?: string; value?: string; modeId?: string; cwd?: string; prompt?: { text: string }[] };
  permission?: { outcome: string; optionId: string };
  toolStarted?: boolean;
};

export type FixtureOptions = {
  env?: Record<string, NodeJS.ProcessEnv>;
  nodeSpec?: (node: Parameters<NodeSpec>[0], spec: ReturnType<NodeSpec>) => ReturnType<NodeSpec> | undefined;
  runner?: Partial<WorkflowOptions>;
};

export type StartOptions = Omit<Partial<WorkflowParams>, "next"> & { next?: Record<string, unknown> };

export type SocketMessage = { id?: number; method: string; params: Record<string, unknown> };

export function required<T>(value: T | null | undefined): T {
  assert.ok(value);
  return value;
}

export function logParams(row: FakeLog | undefined) {
  return required(required(row).params);
}

export function logPrompt(row: FakeLog | undefined) {
  return required(required(logParams(row).prompt)[0]).text;
}

// gio trash refuses /tmp, so test roots live where the trash works.
export const TEST_ROOT = path.join(os.homedir(), ".cache/elpis-tests");

fs.mkdirSync(TEST_ROOT, { recursive: true });

export const FAKE = fileURLToPath(new URL("../../../tools/elpis-claude/test/fake-acp-agent.mts", import.meta.url));

export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const task = (id: string, extra: Partial<StoredTask> = {}): WorkflowParams["tasks"][number] => ({
  id,
  title: id,
  kind: "explore",
  instruction: "Tiny evidence",
  dependsOn: [],
  writeScopes: [],
  acceptanceCriteria: ["Observed evidence"],
  ...extra,
});

export async function until<T>(read: () => T | Promise<T>, check: (value: T) => unknown): Promise<T> {
  for (let n = 0; n < 300; n++) {
    const value = await read();
    if (check(value)) return value;
    await pause(20);
  }
  assert.fail("Workflow condition did not settle");
}

export function fixture(t: TestContext, options: FixtureOptions = {}) {
  const home = fs.mkdtempSync(path.join(TEST_ROOT, "wfrun-test-"));
  const cwd = path.join(home, "project");
  fs.mkdirSync(cwd);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@elpis.local", ...args],
      { cwd, encoding: "utf8" },
    ).trim();
  git("init", "-q");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src/seed"), "base");
  git("add", "src/seed");
  git("commit", "-qm", "base");
  const log = (id: string): FakeLog[] => {
    const file = path.join(home, `${id}.jsonl`);
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(line => JSON.parse(line) as FakeLog)
      : [];
  };
  const runnerOptions: WorkflowOptions & { nodeSpec: NodeSpec } = {
    stateDir: path.join(home, "state"),
    timeoutMs: 10000,
    nodeSpec: node => {
      const spec = {
        name: node.name,
        command: process.execPath,
        args: [FAKE],
        model: node.model?.replace(/^(claude|agy)\//, ""),
        env: {
          FAKE_ACP_NAME: `${node.provider ?? "default"}-${node.name}`,
          FAKE_ACP_MODELS: "m-fast,m-slow,opus,gpt-6.1-sol,gemini-4-argon-high",
          FAKE_ACP_EFFORTS: "low,medium,high",
          FAKE_ACP_LOG: path.join(home, `${node.name}.jsonl`),
          ...(node.name === "Mother agent"
            ? { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: "Reviewed the candidate diff and tests" }) }
            : {}),
          ...(options.env?.[node.name] ?? {}),
        },
      };
      return options.nodeSpec?.(node, spec) ?? spec;
    },
    ...options.runner,
  };
  const runs = createWorkflowRuns(runnerOptions);
  t.after(async () => {
    runs.close();
    await until(
      () => runs.list(),
      list => list.every(record => record.status !== "running"),
    );
    execFileSync("gio", ["trash", home]);
  });
  const start = (tasks: WorkflowParams["tasks"], extra: StartOptions = {}) =>
    runs.start({ rootThreadId: "root", name: "Coding team", tasks, maxConcurrency: 2, ...extra } as WorkflowParams, {
      cwd,
      model: "m-fast",
      modelProvider: "openai",
    });
  const record = async (id: string) => {
    const result = (await runs.list()).find(record => record.id === id);
    assert.ok(result);
    return result;
  };
  const finished = (id: string) =>
    until(
      () => record(id),
      record => record.status !== "running",
    );
  return {
    home,
    cwd,
    git,
    log,
    runs,
    start,
    record,
    finished,
    runnerOptions,
    restore: () => createWorkflowRuns(runnerOptions),
  };
}

/** What a run left in its repository: its folder, its `elpis/<id>/` branches and its registered worktrees. */
export function leftovers(f: ReturnType<typeof fixture>, id: string) {
  const elpis = `${f.cwd}-elpis`;
  return {
    folder: fs.existsSync(path.join(elpis, "workflows", id)),
    elpis: fs.existsSync(elpis),
    branches: f.git("for-each-ref", "--format=%(refname:short)", `refs/heads/elpis/${id}/`).split("\n").filter(Boolean),
    worktrees: f
      .git("worktree", "list", "--porcelain")
      .split("\n")
      .filter(line => line.startsWith("worktree ") && line.includes(`/workflows/${id}/`)),
  };
}

export const NOTHING = { folder: false, elpis: false, branches: [], worktrees: [] };

/** A desktop client on the fixture's workflow state, over a stand-in runtime socket whose one chat is ROOT. */
export const ROOT = "00000000-0000-0000-0000-000000000001";

export function desktopClient(f: ReturnType<typeof fixture>) {
  const socket = new EventEmitter() as EventEmitter & {
    sent: SocketMessage[];
    close: () => void;
    send: (raw: string) => void;
  };
  socket.sent = [];
  socket.close = () => {};
  const root = {
    id: ROOT,
    cwd: f.cwd,
    source: "cli",
    model: "m-fast",
    modelProvider: "openai",
    status: { type: "idle" },
  };
  socket.send = raw => {
    const message = JSON.parse(raw) as SocketMessage;
    socket.sent.push(message);
    if (!message.id) return;
    const result =
      message.method === "model/list"
        ? {
            data: ["m-fast", "claude/opus", "gpt-6.1-sol", "agy/gemini-4-argon-high"].map(model => ({
              id: model,
              model,
            })),
          }
        : message.method === "thread/start"
          ? { thread: { ...root, model: message.params.model ?? root.model } }
          : ["thread/read", "thread/resume"].includes(message.method)
            ? { thread: root }
            : ["workGraph/list", "thread/list"].includes(message.method)
              ? { data: [] }
              : {};
    queueMicrotask(() => socket.emit("message", JSON.stringify({ id: message.id, result })));
  };
  const client = new DesktopClient(socket, {
    appHome: f.home,
    archiveDirectory: path.join(f.home, "archives"),
    rewindHome: path.join(f.home, "rewind"),
    spawnLinksFile: path.join(f.home, "spawns.json"),
    githubConnector: { instructions: async () => "" },
    workflowOptions: f.runnerOptions,
  });
  return { client, socket };
}

// 28 Oct, Masih: no check-ins. Mother used to look in on a running step after its tools and long reports, an Opus call
// on the person's Claude quota each time; she now speaks only when a step fails.
export const routes = async () => [
  { model: "m-fast", provider: "openai", efforts: ["low", "high"], defaultEffort: "high" },
  { model: "claude/opus", provider: "claude", efforts: ["low"] },
];
