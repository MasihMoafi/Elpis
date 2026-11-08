import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorkflowRuns } from "./workflow-acp.mts";
import type { WorkflowOptions } from "./workflow-acp/types.mts";
import { required, logPrompt, task, until, fixture, routes } from "./workflow-coding.fixtures.mts";

test(
  "isolated workflow recovery keeps successful candidate commits and reuses the failed workspace",
  { timeout: 20000 },
  async t => {
    const env: Record<string, NodeJS.ProcessEnv> = {},
      f = fixture(t, { env }),
      offline = path.join(f.home, "offline");
    fs.writeFileSync(offline, "offline");
    env.writer = { FAKE_ACP_WRITE: JSON.stringify({ file: "src/preserved", text: "preserved candidate evidence" }) };
    env.check = { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: "Observed preserved candidate evidence" }) };
    env.second = { FAKE_ACP_OFFLINE: offline };
    const started = await f.start(
      [
        task("writer", { kind: "implement", writeScopes: ["src"] }),
        task("check", { kind: "verify", dependsOn: ["writer"] }),
        task("second", { dependsOn: ["check"] }),
      ],
      { isolation: "worktree" },
    );
    const failed = await f.finished(started.graphId);
    assert.equal(failed.status, "failed");
    const candidate = required(required(failed.tasks[0]).result).candidateCommit,
      workspace = required(failed.tasks.find(node => node.id === "second")).cwd;
    const calls = f.log("writer").filter(row => row.method === "session/prompt").length;
    execFileSync("gio", ["trash", offline]);
    const resumed = await f.runs.resume(started.graphId, { cwd: f.cwd, model: "m-fast", modelProvider: "openai" });
    assert.equal(resumed.graphId, started.graphId);
    const completed = await f.finished(started.graphId);
    assert.equal(completed.status, "succeeded", completed.error ?? undefined);
    assert.equal(required(required(completed.tasks[0]).result).candidateCommit, candidate);
    assert.equal(
      required(completed.tasks.find(node => node.id === "second")).cwd,
      workspace,
      "the failed node continues in its existing worktree",
    );
    assert.equal(
      f.log("writer").filter(row => row.method === "session/prompt").length,
      calls,
      "successful writers are never replayed",
    );
    assert.equal(
      fs.readFileSync(path.join(required(required(completed.review).path), "src/preserved"), "utf8"),
      "preserved candidate evidence",
    );
    assert.equal(fs.existsSync(path.join(f.cwd, "src/preserved")), false, "recovery still waits for a verified merge");
  },
);

test("legacy later-round recovery refuses missing feedback evidence without changing saved work", async t => {
  const f = fixture(t),
    id = randomUUID();
  const retained = {
    id,
    rootThreadId: randomUUID(),
    status: "failed",
    round: 2,
    roundLimit: 3,
    tasks: [task("legacy", { status: "failed" })],
  };
  const file = path.join(f.home, "state", `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(retained));
  const before = fs.readFileSync(file, "utf8");
  const restored = createWorkflowRuns({ stateDir: path.dirname(file) });
  await assert.rejects(restored.resume(id, { cwd: f.cwd }, {}), /earlier-round evidence/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(f.log("legacy").length, 0, "no node is replayed with missing feedback");
});

test("recovery refuses an independently resumed assigned agent without changing the saved run", async t => {
  const f = fixture(t),
    id = randomUUID(),
    rootThreadId = randomUUID(),
    childId = randomUUID();
  const retained = {
    id,
    rootThreadId,
    status: "failed",
    round: 1,
    projectCwd: f.cwd,
    tasks: [task("evidence", { assignedThreadId: childId, status: "failed" })],
  };
  const file = path.join(f.home, "state", `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(retained));
  const before = fs.readFileSync(file, "utf8");
  const restored = createWorkflowRuns({
    ...f.runnerOptions,
    observeThread: async threadId => ({ id: threadId, status: { type: threadId === childId ? "active" : "idle" } }),
  });
  t.after(() => restored.close());
  await assert.rejects(restored.resume(id, { cwd: f.cwd }), /already working/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "status and recovery model remain untouched");
  assert.equal(f.log("evidence").length, 0, "recovery does not start another agent");
});

for (const failure of [
  "failed verification",
  "invalid verification",
  "corrected verification",
  "out-of-scope candidate",
])
  test(`Mother agent supervises ${failure} with one visible corrective decision`, { timeout: 20000 }, async t => {
    const env: Record<string, NodeJS.ProcessEnv> = {},
      f = fixture(t, { env });
    env.evidence =
      failure === "out-of-scope candidate"
        ? { FAKE_ACP_WRITE: JSON.stringify({ file: "outside-report", text: "Preserve this rejected candidate" }) }
        : {
            FAKE_ACP_ANSWER:
              failure === "failed verification"
                ? JSON.stringify({ passed: false, summary: "Required evidence is missing" })
                : "No structured verification evidence",
          };
    if (failure === "corrected verification") {
      let attempts = 0;
      Object.defineProperty(env, "evidence", {
        get: () => ({
          FAKE_ACP_ANSWER: JSON.stringify({
            passed: ++attempts > 1,
            summary: "Observed the requested evidence after focused correction",
          }),
        }),
      });
    }
    env["Mother agent"] = {
      FAKE_ACP_ANSWER: JSON.stringify({
        action: "retry",
        taskId: "evidence",
        instruction: "Inspect the failed evidence and correct only the existing scope.",
        reason: "The retained result needs one focused correction.",
      }),
    };
    // Since 1 Nov a new file outside the folders is moved in by Elpis itself; changing an existing one still needs the Mother.
    if (failure === "out-of-scope candidate") {
      fs.writeFileSync(path.join(f.cwd, "outside-report"), "base");
      f.git("add", "outside-report");
      f.git("commit", "-qm", "existing outside file");
    }
    const started = await f.start(
      [
        task("evidence", {
          kind: failure === "out-of-scope candidate" ? "explore" : "verify",
          writeScopes: failure === "out-of-scope candidate" ? ["src"] : [],
        }),
      ],
      failure === "out-of-scope candidate" ? { isolation: "worktree" } : {},
    );
    const completed = await f.finished(started.graphId);
    assert.equal(completed.status, failure === "corrected verification" ? "succeeded" : "failed");
    assert.equal(
      completed.mother?.decisions.length,
      1,
      "Mother agent makes a single bounded decision even if the correction also fails",
    );
    assert.equal(required(required(completed.mother).decisions[0]).decision, "retry");
    assert.equal(f.log("Mother agent").filter(row => row.method === "session/prompt").length, 1);
    assert.equal(
      f.log("evidence").filter(row => row.method === "session/prompt").length,
      2,
      "the correction executes exactly once",
    );
    if (failure === "corrected verification") {
      assert.equal(
        required(completed.tasks[0]).failureReason,
        null,
        "a corrected task cannot retain a current failure",
      );
      assert.match(required(required(completed.tasks[0]).result).summary, /Observed the requested evidence/);
      assert.match(
        logPrompt(f.log("evidence").filter(row => row.method === "session/prompt")[1]),
        /Mother agent's corrective guidance/,
      );
    } else {
      assert.match(
        required(required(completed.tasks[0]).failureReason),
        failure === "out-of-scope candidate" ? /outside its write scopes/ : /Check failed/,
      );
      assert.equal(required(completed.tasks[0]).result, null);
    }
    if (failure === "out-of-scope candidate") {
      assert.equal(
        fs.readFileSync(path.join(required(required(completed.tasks[0]).cwd), "outside-report"), "utf8"),
        "Preserve this rejected candidate",
      );
      assert.equal(
        fs.readFileSync(path.join(f.cwd, "outside-report"), "utf8"),
        "base",
        "rejected work never reaches the source checkout",
      );
    }
  });

for (const activeMember of ["nested", "next-stage", "unrelated"])
  test(`recovery checks paginated ${activeMember} work before starting an agent`, async t => {
    const cleanup: { run?: ReturnType<typeof createWorkflowRuns> } = {};
    t.after(async () => {
      const active = cleanup.run;
      if (!active) return;
      active.close();
      await until(
        () => active.list(),
        list => list.every(record => record.status !== "running"),
      );
    });
    const f = fixture(t),
      id = randomUUID(),
      rootThreadId = randomUUID(),
      childId = randomUUID(),
      nextId = randomUUID();
    const retained = {
      id,
      rootThreadId,
      status: "failed",
      round: 1,
      projectCwd: f.cwd,
      tasks: [task("evidence", { assignedThreadId: childId, status: "failed" })],
      next: { threadId: randomUUID(), tasks: [task("next", { assignedThreadId: nextId, status: "failed" })] },
    };
    const file = path.join(f.home, "state", `${id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(retained));
    const before = fs.readFileSync(file, "utf8"),
      pages: Parameters<NonNullable<WorkflowOptions["listThreadDescendants"]>>[0][] = [];
    const restored = createWorkflowRuns({
      ...f.runnerOptions,
      observeThread: async threadId => ({
        id: threadId,
        status: {
          type:
            threadId === "foreign" ||
            (activeMember === "next-stage" && threadId === nextId) ||
            (activeMember === "nested" && threadId === "grandchild")
              ? "active"
              : "idle",
        },
      }),
      listThreadDescendants: async options => {
        pages.push(options);
        return options.cursor
          ? {
              data: [
                {
                  id: "grandchild",
                  source: { subAgent: { thread_spawn: { parent_thread_id: childId } } },
                  status: { type: activeMember === "nested" ? "active" : "idle" },
                },
                { id: "foreign", parentThreadId: rootThreadId, status: { type: "active" } },
              ],
              nextCursor: null,
            }
          : {
              data: [
                { id: childId, parentThreadId: rootThreadId, status: { type: "idle" } },
                { id: nextId, parentThreadId: retained.next.threadId, status: { type: "idle" } },
              ],
              nextCursor: "second",
            };
      },
    });
    cleanup.run = restored;
    if (activeMember !== "unrelated") {
      await assert.rejects(restored.resume(id, { cwd: f.cwd }), /already working/);
      assert.equal(fs.readFileSync(file, "utf8"), before, "refused recovery preserves the saved run and model");
      assert.equal(f.log("evidence").length, 0);
    } else {
      await restored.resume(id, { cwd: f.cwd });
      await until(
        () => restored.list(),
        list => list.every(record => record.status !== "running"),
      );
      assert.ok(
        f.log("evidence").some(row => row.method === "session/prompt"),
        "unrelated live work cannot block recovery",
      );
      assert.deepEqual(
        pages.map(page => page.cursor ?? null),
        [null, "second"],
      );
    }
  });

test(
  "a run whose steps succeed never asks Mother agent, even after their tools and long reports",
  { timeout: 20000 },
  async t => {
    const env: Record<string, NodeJS.ProcessEnv> = {},
      f = fixture(t, { env, runner: { modelRoutes: routes } });
    env.live = { FAKE_ACP_ANSWER: "A long report. ".repeat(40) };
    env["Mother agent"] = { FAKE_ACP_ANSWER: JSON.stringify({ action: "continue", reason: "should not be asked" }) };
    const completed = await f.finished((await f.start([task("live")])).graphId);
    assert.equal(completed.status, "succeeded", completed.error ?? undefined);
    assert.equal(
      f.log("Mother agent").filter(row => row.method === "session/prompt").length,
      0,
      "Mother agent was never asked",
    );
    assert.equal(completed.mother?.decisions?.length ?? 0, 0);
  },
);
