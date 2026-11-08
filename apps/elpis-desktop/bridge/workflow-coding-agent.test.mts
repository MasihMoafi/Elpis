import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorkflowRuns } from "./workflow-acp.mts";
import { startDesktopServer } from "./server.mts";
import type { WorkflowRecord } from "./workflow-acp/types.mts";
import { required, logParams, logPrompt, FAKE, pause, task, until, fixture, desktopClient } from "./workflow-coding.fixtures.mts";

test(
  "node models and advertised effort are applied before prompting; unavailable effort fails before work",
  { timeout: 20000 },
  async t => {
    const f = fixture(t);
    const started = await f.start([
      task("chosen", { provider: "custom", model: "m-slow", reasoningEffort: "high" }),
      task("unsupported", { reasoningEffort: "xhigh" }),
    ]);
    const result = await f.finished(started.graphId);
    const chosen = required(result.tasks.find(task => task.id === "chosen"));
    assert.equal(chosen.status, "succeeded");
    assert.match(required(chosen.result).summary, /custom-chosen\(m-slow\)/);
    const sent = f.log("chosen"),
      configs = sent.filter(row => row.method === "session/set_config_option");
    assert.deepEqual(
      configs.map(row => [logParams(row).configId, logParams(row).value]),
      [
        ["model", "m-slow"],
        ["effort", "high"],
      ],
    );
    assert.equal(required(result.tasks.find(task => task.id === "unsupported")).status, "failed");
    assert.match(
      required(required(result.tasks.find(task => task.id === "unsupported")).failureReason),
      /effort.*xhigh/i,
    );
    assert.equal(
      f.log("unsupported").some(row => row.method === "session/prompt"),
      false,
    );
  },
);

test(
  "all automatic workflow roles and Mother agent use Full access and log offered decisions; missing allow and verifier scope escape cannot grant more access",
  { timeout: 20000 },
  async t => {
    const env: Record<string, NodeJS.ProcessEnv> = {};
    for (const id of ["check-implement", "check-fix", "verify"])
      env[id] = { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: "Observed the requested check" }) };
    env.refused = {
      FAKE_ACP_PERMISSION_OPTIONS: JSON.stringify([{ optionId: "deny-only", kind: "reject_once", name: "Reject" }]),
    };
    env.nested = { FAKE_ACP_PERMISSION_SESSION: "nested-workflow-agent" };
    env.explore = {
      FAKE_ACP_WRITE: JSON.stringify({ file: "src/evidence", text: "workflow evidence" }),
      FAKE_ACP_PERMISSION_OPTIONS: JSON.stringify([
        { optionId: "grant-this-call", kind: "allow_once", name: "Allow this call" },
      ]),
    };
    const f = fixture(t, { env });
    const tasks = [
      task("explore"),
      task("implement", { kind: "implement", writeScopes: ["src"] }),
      task("fix", { kind: "fix", writeScopes: ["src"] }),
      task("check-implement", { kind: "verify", dependsOn: ["implement"] }),
      task("check-fix", { kind: "verify", dependsOn: ["fix"] }),
      task("verify", { kind: "verify" }),
      task("nested"),
      task("refused"),
    ].map(task => ({
      ...task,
      instruction: "[permission]",
      ...(task.id === "explore" ? { writeScopes: ["src"] } : {}),
    }));
    const started = await f.start(tasks, { isolation: "worktree", autoMerge: true });
    const completed = await f.finished(started.graphId);
    assert.equal(completed.status, "succeeded", completed.error ?? undefined);
    for (const node of [...completed.tasks, required(completed.mother)]) {
      assert.ok(node.permissions?.length, `${node.title} recorded its automatic permission`);
      const calls = f.log(node.title),
        mode = calls.findIndex(row => row.method === "session/set_mode");
      assert.equal(
        calls[mode]?.params?.modeId,
        "default",
        `${node.title} keeps the provider's permission checks active`,
      );
      assert.ok(mode < calls.findIndex(row => row.method === "session/prompt"));
    }
    assert.equal(
      required(required(required(completed.tasks.find(task => task.id === "explore")).permissions)[0]).optionId,
      "grant-this-call",
      "the offered ID is opaque and is never invented",
    );
    assert.equal(
      required(required(required(completed.tasks.find(task => task.id === "nested")).permissions)[0]).optionId,
      "allow_once",
      "the automatic policy also covers this process’s subagents",
    );
    assert.equal(
      required(required(required(completed.tasks.find(task => task.id === "refused")).permissions)[0]).optionId,
      null,
    );
    assert.deepEqual(required(f.log("refused").find(row => row.permission)).permission, {
      outcome: "selected",
      optionId: "deny-only",
    });

    const g = fixture(t, {
      env: {
        rogue: {
          FAKE_ACP_WRITE: JSON.stringify({ file: "src/seed", text: "forbidden verifier edit" }),
          FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: "Agent claims a pass" }),
        },
      },
    });
    const rogue = await g.start([task("rogue", { kind: "verify", instruction: "[permission]" })], {
      isolation: "worktree",
      autoMerge: true,
    });
    const rejected = await g.finished(rogue.graphId);
    assert.equal(rejected.status, "failed");
    assert.match(required(required(rejected.tasks[0]).failureReason), /outside its write scopes/);
    assert.equal(fs.readFileSync(path.join(g.cwd, "src/seed"), "utf8"), "base");
    assert.equal(rejected.review, undefined, "a verifier scope escape cannot reach review or merge");
  },
);

// 1 Nov live runs: Haiku saved answer-1.md, then answer-3.md, at the project root instead of in its folder, even after a
// correction, and the Voting run failed. A new file outside the agent's folders is moved into its first folder by Elpis
// itself; changing a file that already exists outside them still fails the agent.
test(
  "a new file saved outside the agent's folder is moved into it; an existing file changed outside still fails",
  { timeout: 20000 },
  async t => {
    const pass = { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: "The answer is in src/answer.md" }) };
    const team = () => [
      task("writer", { kind: "implement", writeScopes: ["src"] }),
      task("check", { kind: "verify", dependsOn: ["writer"] }),
    ];
    const f = fixture(t, {
      env: { writer: { FAKE_ACP_WRITE: JSON.stringify({ file: "answer.md", text: "misplaced" }) }, check: pass },
    });
    const done = await f.finished((await f.start(team(), { isolation: "worktree", autoMerge: true })).graphId);
    assert.equal(done.status, "succeeded", done.error ?? required(done.tasks[0]).failureReason ?? undefined);
    assert.equal(f.log("writer").filter(row => row.method === "session/prompt").length, 1, "no extra model turn");
    const writer = required(done.tasks.find(item => item.id === "writer"));
    assert.deepEqual(required(writer.result).relocated, [{ from: "answer.md", to: "src/answer.md" }]);
    assert.equal(fs.readFileSync(path.join(f.cwd, "src/answer.md"), "utf8"), "misplaced");
    assert.equal(fs.existsSync(path.join(f.cwd, "answer.md")), false, "nothing lands outside the folder");
    fs.writeFileSync(path.join(f.cwd, "README.md"), "base");
    f.git("add", "README.md");
    f.git("commit", "-qm", "readme");
    const g = fixture(t, {
      env: {
        writer: { FAKE_ACP_WRITE: JSON.stringify({ file: "src/../README.md", text: "edited outside" }) },
        check: pass,
      },
    });
    fs.writeFileSync(path.join(g.cwd, "README.md"), "base");
    g.git("add", "README.md");
    g.git("commit", "-qm", "readme");
    const failed = await g.finished((await g.start(team(), { isolation: "worktree" })).graphId);
    assert.equal(failed.status, "failed");
    assert.match(
      required(required(failed.tasks.find(item => item.id === "writer")).failureReason),
      /outside its write scopes: README\.md/,
    );
  },
);

test(
  "Mother agent uses Claude Opus to approve the reviewed commit; a rejected review never merges",
  { timeout: 20000 },
  async t => {
    for (const mode of ["approve", "reject", "next-stage"]) {
      const approved = mode !== "reject";
      const f = fixture(t, {
        env: {
          writer: { FAKE_ACP_WRITE: JSON.stringify({ file: "src/result", text: "mother review evidence\n" }) },
          "Mother agent": {
            FAKE_ACP_ANSWER: JSON.stringify({
              passed: approved,
              summary: approved ? "Observed passing checks" : "Regression remains",
            }),
          },
        },
      });
      const baseline = f.git("rev-parse", "HEAD");
      const run = await f.start([task("writer", { writeScopes: ["src"] })], {
        isolation: "worktree",
        autoMerge: mode !== "next-stage",
        ...(mode === "next-stage" ? { next: { name: "Next stage" } } : {}),
      });
      const completed = await f.finished(run.graphId);
      assert.equal(required(completed.mother).model, "claude/opus");
      assert.equal(
        logParams(f.log("Mother agent").find(row => row.method === "session/set_config_option")).value,
        "opus",
      );
      assert.match(logPrompt(f.log("Mother agent").find(row => row.method === "session/prompt")), /candidate|commit/i);
      if (approved) {
        assert.equal(completed.status, "succeeded", completed.error ?? undefined);
        assert.equal(required(completed.review).status, "merged");
        assert.equal(fs.readFileSync(path.join(f.cwd, "src/result"), "utf8"), "mother review evidence\n");
      } else {
        assert.equal(completed.status, "failed");
        assert.match(required(completed.error), /Regression remains/);
        assert.equal(f.git("rev-parse", "HEAD"), baseline);
        assert.equal(fs.existsSync(path.join(f.cwd, "src/result")), false);
        // A temporary Mother failure can be retried without rerunning or changing the children's work.
        const before = f.log("writer").length;
        f.runnerOptions.nodeSpec = node => ({
          name: node.name,
          command: process.execPath,
          args: [FAKE],
          model: "opus",
          env: {
            FAKE_ACP_MODELS: "opus",
            FAKE_ACP_EFFORTS: "low",
            FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: "Rechecked passing candidate" }),
          },
        });
        const retried = await f.restore().merge(run.graphId);
        assert.equal(required(retried.review).status, "merged");
        assert.equal(retried.review.error, undefined, "a successful retry clears the previous failure");
        assert.equal(f.log("writer").length, before);
      }
    }
  },
);

test(
  "authenticated HTTP task workflows use Claude Mother agent by default, expose the run, and refuse invalid or late requests",
  { timeout: 20000 },
  async t => {
    const f = fixture(t, {
      env: {
        Reproduce: { FAKE_ACP_WRITE: JSON.stringify({ file: "tests/regression.txt", text: "failing reproduction" }) },
        Fix: { FAKE_ACP_WRITE: JSON.stringify({ file: "src/result", text: "fixed" }) },
        Review: { FAKE_ACP_ANSWER: JSON.stringify({ passed: true, summary: "Independent passing regression" }) },
      },
    });
    const { client, socket } = desktopClient(f);
    await client.initialize();
    const app = await startDesktopServer({
      client,
      elpisHome: f.home,
      trashFile: path.join(f.home, "trash.json"),
      loveSpot: { directory: path.join(f.home, "drawing"), screenshots: path.join(f.home, "screenshots") },
    });
    try {
      const launch = new URL(app.url),
        origin = launch.origin;
      assert.equal((await fetch(`${origin}/api/workflows/presets`)).status, 401);
      const auth = await fetch(`${origin}/api/session`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ token: new URLSearchParams(launch.hash.slice(1)).get("token") }),
      });
      const headers = {
        Origin: origin,
        Cookie: required(required(auth.headers.get("set-cookie")).split(";")[0]),
        "Content-Type": "application/json",
      };
      const request = (route: string, body?: unknown) =>
        fetch(`${origin}/api${route}`, {
          headers,
          ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        });
      const presets = (await (await request("/workflows/presets")).json()) as {
        data: { name: string; steps: unknown[] }[];
      };
      assert.deepEqual(
        presets.data.map(preset => preset.name),
        ["Fix a bug", "UI change"],
      );
      assert.ok(presets.data.every(preset => preset.steps.length === 4));
      const invalid = await request("/workflows/presets", { preset: "missing", goal: "Tiny task", cwd: f.cwd });
      assert.equal(invalid.status, 400);
      assert.equal(
        socket.sent.some(message => message.method === "thread/start"),
        false,
      );
      await client.createThread({ cwd: f.cwd, agents: true });
      assert.equal(
        required(socket.sent.findLast(message => message.method === "thread/start")).params.model,
        "claude/opus",
      );
      await client.createThread({ cwd: f.cwd });
      assert.equal(
        required(socket.sent.findLast(message => message.method === "thread/start")).params.model,
        undefined,
        "ordinary chats keep their default",
      );
      const response = await request("/workflows/presets", { preset: "bug", goal: "Tiny test and fix", cwd: f.cwd });
      assert.equal(response.status, 200);
      const started = (await response.json()) as { graphId: string };
      const completed = await until(
        async () => ((await (await request(`/workflows/${started.graphId}`)).json()) as { run: WorkflowRecord }).run,
        record => record.status !== "running",
      );
      assert.equal(completed.status, "succeeded", completed.error ?? undefined);
      assert.equal(required(completed.review).status, "merged");
      assert.deepEqual(
        completed.tasks.map(task => task.model),
        ["gpt-6.1-sol", "gpt-6.1-sol", "agy/gemini-4-argon-high"],
      );
      assert.equal(new Set(completed.tasks.map(task => task.cwd)).size, 3);
      assert.equal(fs.readFileSync(path.join(f.cwd, "src/result"), "utf8"), "fixed");
      assert.equal(
        (await request(`/workflows/${started.graphId}/nodes/fix/messages`, { text: "Too late" })).status,
        409,
      );
      assert.equal((await request(`/workflows/${started.graphId}/merge`, { unexpected: true })).status, 400);
      assert.equal((await request("/workflows/11111111-1111-1111-1111-111111111111")).status, 404);
    } finally {
      await app.close();
    }
  },
);

test(
  "isolated nodes with the same scope run concurrently in different branches; shared-checkout nodes serialize",
  { timeout: 20000 },
  async t => {
    for (const isolated of [true, false]) {
      const f = fixture(t),
        tasks = ["first", "second", "queued"].map(id => task(id, { instruction: "[hang]", writeScopes: ["src"] }));
      const started = await f.start(tasks, isolated ? { isolation: "worktree" } : {});
      await until(
        () => f.log("first"),
        log => log.some(row => row.method === "session/prompt"),
      );
      if (isolated)
        await until(
          () => f.log("second"),
          log => log.some(row => row.method === "session/prompt"),
        );
      else {
        await pause(150);
        assert.equal(f.log("second").length, 0);
      }
      assert.equal(f.log("queued").length, 0, "concurrency cap still applies");
      if (isolated) {
        const record = await f.record(started.graphId);
        assert.ok(record);
        const [a, b] = record.tasks;
        assert.ok(a);
        assert.ok(b);
        assert.ok(a.worktree);
        assert.ok(b.worktree);
        assert.notEqual(a.cwd, b.cwd);
        assert.notEqual(a.worktree.branch, b.worktree.branch);
        assert.equal(
          f.git("rev-parse", "HEAD"),
          execFileSync("git", ["rev-parse", "HEAD"], { cwd: a.cwd, encoding: "utf8" }).trim(),
        );
        assert.equal(logParams(f.log("first").find(row => row.method === "session/new")).cwd, a.cwd);
      }
      f.runs.cancel("root");
      assert.equal((await f.finished(started.graphId)).status, "cancelled");
      assert.equal(f.log("queued").length, 0);
    }
  },
);

test(
  "live ACP progress survives reload; steering waits for tools and records delivery; ended nodes refuse messages",
  { timeout: 20000 },
  async t => {
    const env = { live: {} },
      g = fixture(t, { env });
    const release = path.join(g.home, "release-tool"),
      finish = path.join(g.home, "finish");
    Object.assign(env.live, { FAKE_ACP_TOOL_RELEASE: release, FAKE_ACP_RELEASE: finish });
    const run = await g.start([task("live", { instruction: "[tool-flight] [wait]" })]);
    await until(
      () => g.log("live"),
      log => log.some(row => row.toolStarted),
    );
    // The fake agent logs the tool before the bridge has recorded its update, so wait for the run record itself.
    const running = await until(
      () => g.record(run.graphId),
      record =>
        required(record.tasks[0]).progress?.some(row => row.title === "Read notes" && row.status === "in_progress"),
    );
    assert.ok(
      required(running.tasks[0]).progress?.some(row => row.text?.includes("Thinking about it.")),
      "live text is available before completion",
    );
    assert.ok(
      required(required(running.tasks[0]).progress).some(
        row => row.title === "Read notes" && row.status === "in_progress",
      ),
    );
    const accepted = await g.runs.steer(run.graphId, "live", {
      id: "message-1",
      text: "Include planted steering evidence.",
    });
    assert.equal(accepted.message.status, "pending");
    await pause(80);
    assert.equal(
      g.log("live").some(row => row.method === "_session/steering"),
      false,
      "a foreground tool is never interrupted",
    );
    fs.writeFileSync(release, "release");
    await until(
      () => g.record(run.graphId),
      record => required(record.tasks[0]).messages?.[0]?.status === "delivered",
    );
    const duplicate = await g.runs.steer(run.graphId, "live", {
      id: "message-1",
      text: "Include planted steering evidence.",
    });
    assert.equal(duplicate.message.status, "delivered");
    assert.equal(
      g.log("live").filter(row => row.method === "_session/steering").length,
      1,
      "retries do not deliver twice",
    );
    fs.writeFileSync(finish, "finish");
    const completed = await g.finished(run.graphId);
    assert.match(required(required(completed.tasks[0]).result).summary, /planted steering evidence/);
    await assert.rejects(g.runs.steer(run.graphId, "live", { text: "Too late" }), /not running/i);
    const restored = createWorkflowRuns({ stateDir: path.join(g.home, "state") });
    const saved = (await restored.list())[0];
    assert.ok(saved);
    assert.ok(required(saved.tasks[0]));
    assert.deepEqual(required(saved.tasks[0]).progress, required(completed.tasks[0]).progress);
    assert.deepEqual(required(saved.tasks[0]).messages, required(completed.tasks[0]).messages);
    await assert.rejects(restored.steer("missing", "live", { text: "No such run" }), /not found/i);
  },
);
