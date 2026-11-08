import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { workflowModelRoutes } from "./workflow-models.mts";
import { required, logParams, TEST_ROOT, FAKE, task, until, fixture, leftovers, NOTHING, ROOT, desktopClient } from "./workflow-coding.fixtures.mts";

test(
  "isolated results expose commits and diff; final review merges only a successful run into its unchanged clean source",
  { timeout: 20000 },
  async t => {
    for (const mode of ["merge", "dirty", "advanced", "failed"]) {
      const f = fixture(t, {
        env: {
          writer: { FAKE_ACP_WRITE: JSON.stringify({ file: "src/result", text: "planted review evidence\n" }) },
          check: { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: "Observed planted review evidence" }) },
        },
      });
      const baseline = f.git("rev-parse", "HEAD");
      const started = await f.start(
        [
          task("writer", {
            kind: "implement",
            writeScopes: ["src"],
            ...(mode === "failed" ? { instruction: "[crash]" } : {}),
          }),
          task("check", { kind: "verify", dependsOn: ["writer"] }),
        ],
        { isolation: "worktree" },
      );
      const result = await f.finished(started.graphId);
      assert.equal(f.git("rev-parse", "HEAD"), baseline, "source never changes before review");
      assert.equal(fs.existsSync(path.join(f.cwd, "src/result")), false);
      if (mode === "failed") {
        await assert.rejects(f.runs.merge(started.graphId), /successful|succeeded/i);
        continue;
      }
      assert.equal(required(result.review).status, "ready");
      const changes = required(required(result.tasks[0]).result);
      assert.ok(changes.diff);
      assert.ok(changes.candidateCommit);
      assert.ok(changes.commits);
      assert.match(changes.diff, /\+planted review evidence/);
      assert.match(changes.candidateCommit, /^[a-f0-9]{40}$/);
      assert.ok(changes.commits.some(commit => commit.sha === changes.candidateCommit));
      if (mode === "dirty") fs.writeFileSync(path.join(f.cwd, "src/seed"), "user edit");
      if (mode === "advanced") {
        fs.writeFileSync(path.join(f.cwd, "src/seed"), "new commit");
        f.git("add", "src/seed");
        f.git("commit", "-qm", "source advanced");
      }
      // A restarted bridge can merge the persisted candidate, without rerunning any model.
      const restored = f.restore();
      if (mode !== "merge") {
        const head = f.git("rev-parse", "HEAD");
        await assert.rejects(restored.merge(started.graphId), /project changed|not merged/i);
        assert.equal(f.git("rev-parse", "HEAD"), head);
        assert.equal(fs.existsSync(path.join(f.cwd, "src/result")), false);
        assert.equal(
          fs.readFileSync(path.join(f.cwd, "src/seed"), "utf8"),
          mode === "dirty" ? "user edit" : "new commit",
        );
      } else {
        const merged = await restored.merge(started.graphId);
        assert.equal(required(merged.review).status, "merged");
        assert.deepEqual(leftovers(f, started.graphId), NOTHING, "a merged run leaves no worktree, branch or folder");
        assert.equal(fs.readFileSync(path.join(f.cwd, "src/result"), "utf8"), "planted review evidence\n");
        const head = f.git("rev-parse", "HEAD");
        await restored.merge(started.graphId);
        assert.equal(f.git("rev-parse", "HEAD"), head, "merge retries are idempotent");
      }
    }
  },
);

// Masih, 29 Oct: "so leftovers don't exist". A run's worktrees and branches end when its work has reached the project.
test(
  "a run whose work reached the project, or that had none, leaves no worktree, branch or folder",
  { timeout: 20000 },
  async t => {
    const f = fixture(t, {
      env: { writer: { FAKE_ACP_WRITE: JSON.stringify({ file: "src/result", text: "merged evidence\n" }) } },
    });
    const empty = await f.finished((await f.start([task("reader")], { isolation: "worktree" })).graphId);
    assert.equal(empty.status, "succeeded", empty.error ?? undefined);
    assert.equal(required(empty.review).status, "empty");
    assert.ok(required(empty.worktrees).length, "the run had a worktree to free");
    assert.deepEqual(leftovers(f, empty.id), NOTHING, "an empty run leaves nothing");
    const merged = await f.finished(
      (await f.start([task("writer", { writeScopes: ["src"] })], { isolation: "worktree", autoMerge: true })).graphId,
    );
    assert.equal(merged.status, "succeeded", merged.error ?? undefined);
    assert.equal(required(merged.review).status, "merged");
    assert.equal(fs.readFileSync(path.join(f.cwd, "src/result"), "utf8"), "merged evidence\n");
    assert.equal(required(merged.worktrees).length, 2, "a task worktree and the integration worktree");
    assert.deepEqual(leftovers(f, merged.id), NOTHING, "a merged run leaves nothing");
  },
);

test(
  "failed and cancelled runs keep their worktrees until they leave History; only their own are freed, and a failed removal retries",
  { timeout: 30000 },
  async t => {
    const f = fixture(t),
      elpis = `${f.cwd}-elpis`,
      other = randomUUID(),
      otherPath = path.join(elpis, "workflows", other, "x-r1");
    const failed = await f.finished(
      (
        await f.start([task("broken", { writeScopes: ["src"], instruction: "[crash]" })], {
          isolation: "worktree",
          rootThreadId: ROOT,
        })
      ).graphId,
    );
    assert.equal(failed.status, "failed");
    const waiting = await f.start([task("waiter", { writeScopes: ["src"], instruction: "[hang]" })], {
      isolation: "worktree",
      rootThreadId: ROOT,
    });
    await until(
      () => f.log("waiter"),
      log => log.some(row => row.method === "session/prompt"),
    );
    f.runs.cancel(ROOT);
    const cancelled = await f.finished(waiting.graphId);
    assert.equal(cancelled.status, "cancelled");
    for (const run of [failed, cancelled]) {
      assert.equal(required(run.worktrees).length, 1);
      const kept = leftovers(f, run.id);
      assert.ok(
        kept.folder && fs.existsSync(required(required(run.worktrees)[0]).path),
        `a ${run.status} run keeps its worktree, so it can resume`,
      );
      assert.deepEqual(kept.branches, [required(required(run.worktrees)[0]).branch]);
      assert.equal(required(kept.worktrees).length, 1);
    }
    // Another run's worktree, and branches that only look like this run's, are not this run's to free. A record that
    // lists paths outside its own folder cannot reach them either.
    f.git("worktree", "add", "-q", "-b", `elpis/${other}/x`, otherPath);
    for (const branch of ["elpis-other", `elpis/${failed.id}-copy/x`]) f.git("branch", branch);
    const file = path.join(f.runnerOptions.stateDir, `${failed.id}.json`),
      saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.worktrees.push({ path: otherPath, branch: `elpis/${other}/x` }, { path: f.cwd, branch: "elpis-other" });
    fs.writeFileSync(file, JSON.stringify(saved));
    f.git("worktree", "lock", required(required(cancelled.worktrees)[0]).path);
    const { client } = desktopClient(f);
    await client.initialize();
    t.after(() => client.close());
    // A removal that Git refuses still removes the run from History, and is recorded.
    assert.deepEqual(await client.removeWorkflowHistory(cancelled.id, {}), { removed: cancelled.id, canUndo: true });
    assert.ok(fs.existsSync(required(required(cancelled.worktrees)[0]).path));
    assert.match((await client.workflowRun(cancelled.id)).run.cleanup?.error ?? "", /locked/);
    assert.ok(fs.existsSync(required(required(failed.worktrees)[0]).path), "removing one run frees nothing of another");
    f.git("worktree", "unlock", required(required(cancelled.worktrees)[0]).path);
    await client.removeWorkflowHistory(failed.id, {});
    for (const run of [failed, cancelled])
      assert.deepEqual(
        { ...leftovers(f, run.id), elpis: false },
        NOTHING,
        `the removed ${run.status} run is freed, on retry too`,
      );
    assert.ok(fs.existsSync(path.join(otherPath, "src/seed")), "another run keeps its worktree");
    assert.ok(fs.existsSync(path.join(f.cwd, "src/seed")));
    for (const branch of [`elpis/${other}/x`, "elpis-other", `elpis/${failed.id}-copy/x`])
      assert.equal(f.git("branch", "--list", branch).trim().replace(/^\+ /, ""), branch);
    // Undo brings back the record only; its resume says plainly why it cannot continue.
    assert.equal((await client.undoWorkflowHistory({})).restored, failed.id);
    assert.ok((await client.workflowHistory()).data.some(run => run.id === failed.id));
    await assert.rejects(client.resumeWorkflow(failed.id, {}), /worktrees were removed.*cannot resume/i);
  },
);

test(
  "Default workflow nodes skip an exhausted subscription and record their actual healthy route",
  { timeout: 20000 },
  async t => {
    const routes = [
      { model: "claude/opus", provider: "claude", exhausted: true, reason: "Weekly usage limit reached" },
      { model: "m-fast", provider: "openai", exhausted: false },
    ];
    const f = fixture(t, { runner: { modelRoutes: async () => routes } });
    const run = await f.runs.start(
      { rootThreadId: "root", name: "Quota routing", tasks: [task("default-node")] },
      { cwd: f.cwd, model: "claude/opus", modelProvider: "claude" },
    );
    const completed = await f.finished(run.graphId);
    assert.equal(completed.status, "succeeded", completed.error ?? undefined);
    const routing = required(required(completed.tasks[0]).routing);
    assert.deepEqual(routing.requested, { model: "claude/opus", provider: "claude" });
    assert.deepEqual(routing.actual, { model: "m-fast", provider: "openai" });
    assert.equal(
      f.log("default-node").some(row => row.method === "session/set_config_option" && logParams(row).value === "opus"),
      false,
      "known exhausted Claude never receives a model turn",
    );
    assert.match(required(required(routing.attempts[0]).reason), /Weekly/);
  },
);

test(
  "resume preserves successful nodes and the same run while retrying a failed dependent",
  { timeout: 20000 },
  async t => {
    const offline = path.join(TEST_ROOT, `workflow-offline-${process.pid}-${Date.now()}`);
    fs.writeFileSync(offline, "offline");
    t.after(() => {
      if (fs.existsSync(offline)) execFileSync("gio", ["trash", offline]);
    });
    const f = fixture(t, { env: { second: { FAKE_ACP_OFFLINE: offline } } });
    const run = await f.start([task("first"), task("second", { dependsOn: ["first"] })]);
    const failed = await f.finished(run.graphId);
    assert.equal(failed.status, "failed");
    const original = required(failed.tasks[0]).result,
      before = f.log("first").filter(row => row.method === "session/prompt").length;
    execFileSync("gio", ["trash", offline]);
    const resumed = await f.runs.resume(run.graphId, { cwd: f.cwd, model: "m-fast", modelProvider: "openai" }, {});
    assert.equal(resumed.graphId, run.graphId, "recovery keeps the original workflow");
    const completed = await f.finished(run.graphId);
    assert.equal(completed.status, "succeeded", completed.error ?? undefined);
    assert.deepEqual(required(completed.tasks[0]).result, original, "successful evidence stays byte-for-byte");
    assert.equal(
      f.log("first").filter(row => row.method === "session/prompt").length,
      before,
      "the successful node is not replayed",
    );
    assert.equal(f.log("second").filter(row => row.method === "session/prompt").length, 2);
  },
);

test("subscription recovery routes exclude API billing, expired limits and managed-provider escapes", () => {
  const models = ["m-fast", "claude/opus", "agy/gemini-4-argon-high"].map(model => ({ model }));
  const providers = {
    openai: { auth: { state: "signedIn", method: "API key" }, usage: [] },
    claude: { state: "connected", usage: [{ secondary: { usedPercent: 100, resetsAt: Date.now() / 1000 - 60 } }] },
    gemini: { state: "connected", usage: [] },
    openrouter: [{ keySet: true }],
  };
  const routes = workflowModelRoutes(models, providers, {});
  assert.deepEqual(
    routes.map(route => route.provider),
    ["claude", "agy"],
    "a stored API key never authorizes automatic paid fallback",
  );
  assert.ok(routes[0]);
  assert.equal(routes[0].exhausted, false, "an expired usage window does not block a fresh allowance");
  assert.deepEqual(
    workflowModelRoutes(models, providers, { modelProvider: "claude" }).map(route => route.provider),
    ["claude"],
    "managed connection restrictions apply before routing",
  );
  assert.deepEqual(
    workflowModelRoutes(
      models,
      { ...providers, claude: { state: "notConnected", signedOut: true }, gemini: { state: "notConnected" } },
      {},
    ),
    [],
    "signed-out subscriptions are unavailable",
  );
});

for (const [error, kind, recovers] of [
  ["Weekly usage limit reached", "usage_limit_reached", true],
  ["Claude (ACP) error: You have hit your weekly limit.", "provider_error", true],
  ["Weekly report failed because the file is missing", "provider_error", false],
  ["Please review the weekly limit documentation", "provider_error", false],
] as const)
  test(`quota recovery classifies ${error} without replaying unrelated failures`, { timeout: 20000 }, async t => {
    const preservesPartialWork = error === "Claude (ACP) error: You have hit your weekly limit.";
    const f: ReturnType<typeof fixture> = fixture(t, {
      runner: {
        modelRoutes: async () => [
          { model: "claude/opus", provider: "claude" },
          { model: "m-fast", provider: "openai" },
        ],
        nodeSpec: node => ({
          name: node.name,
          command: process.execPath,
          args: [FAKE],
          model: node.model.replace(/^(claude|agy)\//, ""),
          env: {
            FAKE_ACP_NAME: `${node.provider}-${node.name}`,
            FAKE_ACP_MODELS: "opus,m-fast",
            FAKE_ACP_LOG: path.join(f.home, `${node.name}.jsonl`),
            ...(node.provider === "claude"
              ? {
                  ...(preservesPartialWork
                    ? {
                        FAKE_ACP_WRITE: JSON.stringify({
                          file: "src/quota-partial",
                          text: "work from the exhausted subscription",
                        }),
                        FAKE_ACP_PROMPT_ERROR_AFTER_WRITE: error,
                      }
                    : { FAKE_ACP_PROMPT_ERROR: error }),
                  FAKE_ACP_ERROR_KIND: kind,
                }
              : preservesPartialWork
                ? {
                    FAKE_ACP_EXPECT: JSON.stringify({
                      file: "src/quota-partial",
                      text: "work from the exhausted subscription",
                    }),
                  }
                : {}),
          },
        }),
      },
    });
    const started = await f.start([task("limited", { model: "claude/opus", provider: "claude" })]);
    const completed = await f.finished(started.graphId),
      node = required(completed.tasks[0]);
    const routing = required(node.routing);
    assert.equal(completed.status, recovers ? "succeeded" : "failed", completed.error ?? undefined);
    assert.deepEqual(
      routing.attempts.map(attempt => [attempt.provider, attempt.status]),
      recovers
        ? [
            ["claude", "failed"],
            ["openai", "succeeded"],
          ]
        : [["claude", "failed"]],
    );
    assert.deepEqual(
      routing.actual,
      recovers ? { model: "m-fast", provider: "openai" } : { model: "claude/opus", provider: "claude" },
    );
    assert.ok(required(required(routing.attempts[0]).reason).includes(error));
    assert.equal(
      f.log("limited").filter(row => row.method === "session/prompt").length,
      recovers ? 2 : 1,
      "only quota failures reach another subscription",
    );
    if (preservesPartialWork)
      assert.match(
        required(node.result).summary,
        /Read planted result: work from the exhausted subscription/,
        "the fallback continues in the same workspace with the first subscription's work",
      );
    if (recovers)
      assert.equal(
        completed.mother,
        undefined,
        "successful quota recovery does not create an unnecessary supervisor turn",
      );
  });

test(
  "Mother agent actually steers a running sibling after a node fails without blindly replaying the failed operation",
  { timeout: 20000 },
  async t => {
    const env: Record<string, NodeJS.ProcessEnv> = {},
      f = fixture(t, { env });
    const offline = path.join(f.home, "offline"),
      release = path.join(f.home, "tool-release"),
      finish = path.join(f.home, "finish");
    fs.writeFileSync(offline, "offline");
    env.bad = { FAKE_ACP_OFFLINE: offline };
    env.live = {
      FAKE_ACP_TOOL_RELEASE: release,
      FAKE_ACP_HOLD_TOOL: "1",
      FAKE_ACP_RELEASE: finish,
      FAKE_ACP_HOLD_TURN: "1",
    };
    env["Mother agent"] = {
      FAKE_ACP_ANSWER: JSON.stringify({
        action: "steer",
        taskId: "live",
        message: "Include MOTHER_GUIDANCE_2710 in your final evidence.",
        reason: "The independent sibling can finish while the unavailable node waits for manual recovery.",
      }),
    };
    const started = await f.start([
      task("seed"),
      task("live", { instruction: "Continue the independent work." }),
      task("bad", { dependsOn: ["seed"] }),
    ]);
    await until(
      () => f.log("Mother agent"),
      log => log.some(row => row.method === "session/prompt"),
    );
    assert.equal(
      f.log("live").some(row => row.method === "_session/steering"),
      false,
      "Mother agent waits for a foreground tool before steering",
    );
    fs.writeFileSync(release, "done");
    await until(
      () => f.record(started.graphId),
      record =>
        record.mother?.decisions?.some(
          decision => decision.decision === "steer" && decision.delivery === "currentTurn",
        ),
    );
    fs.writeFileSync(finish, "done");
    const completed = await f.finished(started.graphId);
    assert.equal(completed.status, "failed", "the genuinely failed node remains visible for recovery");
    assert.match(
      required(required(completed.tasks.find(node => node.id === "live")).result).summary,
      /MOTHER_GUIDANCE_2710/,
    );
    const decision = required(required(completed.mother).decisions.find(decision => decision.decision === "steer"));
    assert.equal(decision.taskId, "live");
    assert.equal(decision.delivery, "currentTurn");
    assert.equal(
      f.log("Mother agent").filter(row => row.method === "session/prompt").length,
      1,
      "supervision is one bounded actual ACP decision",
    );
    assert.equal(
      f.log("bad").filter(row => row.method === "session/prompt").length,
      1,
      "a generic provider failure never blindly replays the operation",
    );
  },
);
