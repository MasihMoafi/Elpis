import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createMemoryBudget } from "./memory-budget.mts";
import { ROOT, FATHER, pause, task, fixture, staged, fatherPart, budgetFixture, plenty } from "./workflow-acp.fixtures.mts";
import type { WorkflowInput, FakeEnv } from "./workflow-acp.fixtures.mts";

// 29 Oct, Masih: "use sol high or med in fast mode". A task's Fast tier reaches its agent; a task without it sends none.
test("a task in Fast runs its agent on the Fast tier; an unknown tier is refused", { timeout: 20000 }, async t => {
  const f = fixture(t);
  await f.client.initialize();
  const fast = {
    ...task("fast"),
    kind: "implement",
    writeScopes: ["agents/fast"],
    serviceTier: "priority",
    unchecked: true,
  };
  const plain = { ...task("plain"), kind: "implement", writeScopes: ["agents/plain"], unchecked: true };
  const g = await f.finished((await f.run([fast, plain])).graphId);
  assert.equal(g.status, "succeeded", g.error ?? undefined);
  assert.equal(
    f.log("fast").find(row => row.method === "session/new")!.params._meta.elpis.workflow.serviceTier,
    "priority",
  );
  assert.equal(
    f.log("plain").find(row => row.method === "session/new")!.params._meta.elpis.workflow.serviceTier,
    undefined,
  );
  await assert.rejects(
    f.run([{ ...task("odd"), kind: "implement", writeScopes: ["agents/odd"], serviceTier: "turbo", unchecked: true }]),
    /service tier/i,
  );
  await assert.rejects(
    f.run([{ ...task("bare"), kind: "implement", writeScopes: ["agents/bare"] }]),
    /directly dependent check/,
    "a writer still needs a check unless it says it goes unchecked",
  );
});

test(
  "A30: an empty project runs real ACP processes; every writer and check creates its own report, including a whole-project writer",
  { timeout: 20000 },
  async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wf1-reports-"));
    const env: FakeEnv & { workflowFake: Record<string, Record<string, string>> } = { workflowFake: {} };
    const f = fixture(t, { stateDir: path.join(home, "workflow-state"), env });
    await f.client.initialize();
    assert.deepEqual(fs.readdirSync(f.dir), [], "the run starts in a project with no files or subfolders");
    const tasks: WorkflowInput["tasks"] = [],
      reports = new Map<string, string>();
    for (const [index, id] of ["first", "middle", "last"].entries()) {
      const folder = `agents/${id}`,
        ownReport = `${folder}/report.md`,
        checkReport = `${folder}/check/report.md`;
      const content = `# ${id}\n## Result\nPlanted evidence A30-${index}.\n## Evidence\nACP wrote this file.\n## Files\n${ownReport}\n## Open\nNone.\n`;
      const verdict = `# Check ${id}\n## Verdict\nPassed: read A30-${index}.\n## Evidence\nRead ${ownReport}.\n## Files\n${checkReport}\n## Open\nNone.\n`;
      const dependencies = index ? ["first", "first-check", ...(index > 1 ? ["middle", "middle-check"] : [])] : [];
      tasks.push(
        {
          ...task(id, dependencies, `Write ${ownReport}`),
          kind: "implement",
          writeScopes: [...(id === "last" ? ["."] : []), folder],
        },
        {
          ...task(`${id}-check`, [id], `Check ${ownReport} and write ${checkReport}`),
          kind: "verify",
          writeScopes: [`${folder}/check`],
        },
      );
      env.workflowFake[id] = {
        HOME: home,
        ELPIS_HOME: path.join(home, "elpis"),
        CODEX_HOME: path.join(home, "codex"),
        FAKE_ACP_WRITE: JSON.stringify({ file: path.join(f.dir, ownReport), text: content }),
      };
      env.workflowFake[`${id}-check`] = {
        HOME: home,
        ELPIS_HOME: path.join(home, "elpis"),
        CODEX_HOME: path.join(home, "codex"),
        FAKE_ACP_WRITE: JSON.stringify({ file: path.join(f.dir, checkReport), text: verdict }),
        FAKE_ACP_EXPECT: JSON.stringify({ file: path.join(f.dir, ownReport), text: content }),
      };
      reports.set(ownReport, content);
      reports.set(checkReport, verdict);
    }
    const started = await f.run(tasks);
    for (const task of tasks) {
      const folder = task.writeScopes.at(-1);
      assert.ok(folder);
      assert.ok(
        fs.statSync(path.join(f.dir, folder)).isDirectory(),
        `${task.id}'s folder exists as soon as the run starts`,
      );
    }
    const result = await f.finished(started.graphId);
    assert.equal(result.status, "succeeded", result.error ?? undefined);
    for (const [report, content] of reports)
      assert.equal(fs.readFileSync(path.join(f.dir, report), "utf8"), content, `real report written: ${report}`);
    for (const task of tasks) {
      const session = f.log(task.id).find(row => row.method === "session/new");
      assert.ok(session, `${task.id} started its own ACP session`);
      assert.deepEqual(session.params._meta.elpis.workflow.writeScopes, task.writeScopes);
      assert.doesNotMatch(session.params._meta.systemPrompt.append, /read.only/i);
      const folder = task.writeScopes.at(-1);
      assert.ok(folder);
      assert.ok(fs.statSync(path.join(f.dir, folder)).isDirectory());
      const finishedTask = result.tasks.find(item => item.id === task.id);
      assert.ok(finishedTask);
      assert.ok(finishedTask.result);
      assert.match(finishedTask.result.summary, task.kind === "verify" ? /Read planted result/ : /answered/);
    }
    assert.equal(new Set(tasks.map(task => task.writeScopes.at(-1))).size, tasks.length);
    assert.equal(
      f.socket.sent.some(row => row.method.startsWith("workGraph/run")),
      false,
      "the ACP scheduler, not native work graphs, ran",
    );
    t.diagnostic(
      'Six ACP child sessions wrote and read all six report.md files; a writer had scope ".". No model or credentials used.',
    );
  },
);

test(
  "the Father agent part starts from the bridge after the Mother agent part, in his own chat, and his report reaches hers",
  { timeout: 30000 },
  async t => {
    const f = fixture(t);
    await f.client.initialize();
    const r = await f.run([task("m")], { next: fatherPart });
    assert.equal((await f.finished(r.graphId)).status, "succeeded");
    const graph = await staged(f, r.graphId);
    assert.deepEqual([graph.next.threadId, graph.next.status, graph.next.reported], [FATHER, "succeeded", true]);
    assert.equal(f.log("f").filter(row => row.method === "session/prompt").length, 1, "the Father agent's agent ran");
    assert.match(
      f.socket.sent.find(row => row.method === "thread/start")!.params.developerInstructions,
      /You are the Father agent\./,
    );
    const report = f.socket.sent.find(row => row.method === "turn/start" && row.params.threadId === ROOT);
    assert.match(JSON.stringify(report!.params.input), /Report from the Father agent[\s\S]*Status: succeeded/);
  },
);

test(
  "a refused Father agent report is tried again, and its reason is kept when it never goes through",
  { timeout: 30000 },
  async t => {
    for (const [refusals, reported] of [
      [2, true],
      [9, false],
    ] as const) {
      const f = fixture(t);
      await f.client.initialize();
      f.socket.refuseTurns = refusals;
      const r = await f.run([task("m")], { next: fatherPart });
      const graph = await staged(f, r.graphId);
      if (!reported)
        for (let n = 0; n < 200 && !graph.next.error; n++) {
          Object.assign(
            graph,
            (await f.client.workflows(ROOT)).data.find(item => item.id === r.graphId),
          );
          await pause(25);
        }
      assert.equal(!!graph.next.reported, reported);
      if (!reported) assert.match(graph.next.error!, /^Father agent report not delivered: busy/);
      assert.equal(
        f.socket.sent.filter(row => row.method === "turn/start" && row.params.threadId === ROOT).length,
        reported ? 3 : 4,
      );
    }
  },
);

test("a Mother agent part that fails never starts the Father agent", { timeout: 30000 }, async t => {
  const f = fixture(t);
  await f.client.initialize();
  const r = await f.run([task("m", [], "[crash]")], { next: fatherPart });
  assert.equal((await f.finished(r.graphId)).status, "failed");
  assert.equal((await staged(f, r.graphId)).next.status, "cancelled");
  assert.equal(
    f.socket.sent.some(row => row.method === "thread/start"),
    false,
  );
  assert.equal(f.log("f").length, 0);
});

test(
  "workflow ACP permissions are allowed and recorded on the node without reaching the approval UI",
  { timeout: 20000 },
  async t => {
    const f = fixture(t);
    await f.client.initialize();
    const questions: unknown[] = [];
    f.client.on("event", event => {
      if (event.type !== "approval") return;
      questions.push(event.data);
      // Let the old implementation finish so its UI leak fails explicitly, without a timeout.
      f.client.answerApproval(event.data.id, { decision: "accept" });
    });
    const r = await f.run([task("a", [], "[permission]")]);
    const g = await f.finished(r.graphId);
    assert.equal(g.status, "succeeded");
    const firstTask = g.tasks[0];
    assert.ok(firstTask);
    assert.ok(firstTask.result);
    assert.ok(firstTask.permissions?.[0]);
    assert.ok(firstTask.progress);
    assert.match(firstTask.result.summary, /permission: allow_once/);
    assert.equal(f.client.pendingApprovals.length, 0);
    assert.deepEqual(questions, [], "no permission question is emitted to the person");
    assert.equal(firstTask.permissions[0].optionId, "allow_once");
    const automatic = firstTask.progress.find(entry => entry.text?.includes("automatically"));
    assert.ok(automatic?.text);
    assert.match(automatic.text, /Write notes.txt/);
  },
);

test("time limit cancels the process and blocks dependents", { timeout: 20000 }, async t => {
  const f = fixture(t);
  await f.client.initialize();
  const r = await f.run([task("a", [], "[hang]"), task("b", ["a"])], { maxRuntimeSeconds: 1 });
  const g = await f.finished(r.graphId);
  assert.equal(g.status, "failed");
  assert.ok(g.error);
  assert.match(g.error, /timed out/);
  assert.equal(f.log("b").length, 0);
});

test(
  "isolated ACP writes reach their verifier, then the source; scope escape or a changed source prevents integration",
  { timeout: 30000 },
  async t => {
    for (const mode of ["success", "scope", "dirty"]) {
      const f = fixture(t, { env: { workflowFake: {} } });
      await f.client.initialize();
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
          { cwd: f.dir, encoding: "utf8" },
        ).trim();
      git("init", "-q");
      fs.writeFileSync(path.join(f.dir, ".gitignore"), "state/\n*.jsonl\n");
      fs.mkdirSync(path.join(f.dir, "src"));
      fs.writeFileSync(path.join(f.dir, "src", "seed"), "base");
      git("add", ".gitignore", "src/seed");
      git("commit", "-qm", "baseline");
      const baseline = git("rev-parse", "HEAD");
      // The fake ACP command writes relative to its session's actual isolated cwd.
      const a = { ...task("writer"), kind: "implement", writeScopes: ["src"] };
      const check = { ...task("check", ["writer"]), kind: "verify" };
      // Recreate only the injected fake environment, without replacing runAcpNode.
      f.fakeEnv!.workflowFake!.writer = {
        FAKE_ACP_WRITE: JSON.stringify({
          file: mode === "scope" ? "outside.txt" : "src/result",
          text: "workflow planted result",
        }),
      };
      f.fakeEnv!.workflowFake!.check = {
        FAKE_ACP_EXPECT: JSON.stringify({ file: "src/result", text: "workflow planted result" }),
      };
      if (mode === "dirty") fs.writeFileSync(path.join(f.dir, "src", "seed"), "user edit");
      const r = await f.run([a, check], { isolation: "worktree" });
      const g = await f.finished(r.graphId);
      if (mode === "success") {
        assert.equal(fs.existsSync(path.join(f.dir, "src/result")), false, "the candidate waits for Mother agent");
        await f.client.mergeWorkflow(r.graphId, {});
        assert.equal(g.status, "succeeded", g.error ?? undefined);
        assert.equal(fs.readFileSync(path.join(f.dir, "src/result"), "utf8"), "workflow planted result");
        assert.notEqual(git("rev-parse", "HEAD"), baseline);
        assert.equal(
          f
            .log("check")
            .find(row => row.method === "session/new")!
            .params.cwd.includes("-elpis/workflows/"),
          true,
        );
      } else {
        if (mode === "dirty") {
          assert.equal(g.status, "succeeded");
          await assert.rejects(f.client.mergeWorkflow(r.graphId, {}), /project changed/);
        } else assert.equal(g.status, "failed");
        assert.equal(git("rev-parse", "HEAD"), baseline);
        assert.equal(fs.existsSync(path.join(f.dir, "src/result")), false);
        if (mode === "dirty") assert.equal(fs.readFileSync(path.join(f.dir, "src/seed"), "utf8"), "user edit");
      }
    }
  },
);

test(
  "the concurrency cap and overlapping writer scopes hold before another process starts",
  { timeout: 20000 },
  async t => {
    for (const shared of [true, false]) {
      const f = fixture(t);
      await f.client.initialize();
      fs.mkdirSync(path.join(f.dir, "one"));
      fs.mkdirSync(path.join(f.dir, "two"));
      const tasks = ["a", "b", "c"].flatMap((id, i) => [
        { ...task(id, [], "[hang]"), kind: "implement", writeScopes: [shared || i === 0 ? "one" : "two"] },
        { ...task(`${id}-check`, [id]), kind: "verify" },
      ]);
      const r = await f.run(tasks);
      for (let n = 0; n < 200 && !f.log("a").some(row => row.method === "session/prompt"); n++) await pause(20);
      if (!shared)
        for (let n = 0; n < 500 && !f.log("b").some(row => row.method === "session/prompt"); n++) await pause(20);
      await pause(250);
      assert.equal(
        f.log("b").some(row => row.method === "session/prompt"),
        !shared,
      );
      assert.equal(f.log("c").length, 0, "third task cannot exceed the cap");
      await f.client.interrupt(ROOT, {});
      assert.equal((await f.finished(r.graphId)).status, "cancelled");
      assert.equal(
        f.log("b").some(row => row.method === "session/prompt"),
        !shared,
        "overlapping work stays blocked through cancellation",
      );
      assert.equal(f.log("c").length, 0, "queued work never starts during cancellation");
    }
  },
);

test("two workflows of three nodes share the global cap of 4 and all six finish", { timeout: 20000 }, async t => {
  // The cap is set here: since 2 Nov (661f980b9, Masih: "no cap of 4") Elpis picks it from CPUs and free memory.
  const f = budgetFixture(t, createMemoryBudget({ env: {}, cap: 4, ...plenty }));
  const ids = ["a1", "a2", "a3", "b1", "b2", "b3"];
  const one = await f.start(
    "one",
    ids.slice(0, 3).map(id => task(id)),
    { maxConcurrency: 3 },
  );
  const two = await f.start(
    "two",
    ids.slice(3).map(id => task(id)),
    { maxConcurrency: 3 },
  );
  await f.until(() => f.started(ids).length >= 4, "four nodes start");
  await pause(300);
  assert.equal(f.started(ids).length, 4, "a fifth node waits for a slot");
  assert.equal(ids.filter(id => f.log(id).length).length, 4, "no process starts for the waiting nodes");
  f.release();
  const ended = [await f.finished(one.graphId), await f.finished(two.graphId)];
  assert.deepEqual(
    ended.flatMap(record => record.tasks.map(task => task.status)),
    Array(6).fill("succeeded"),
  );
  assert.equal(
    ended.some(record => record.log),
    false,
    "nothing waited for memory",
  );
});

test(
  "no node starts below the memory floor; the run log says so once when the wait starts and once when it ends",
  { timeout: 20000 },
  async t => {
    let free = 3.1;
    const f = budgetFixture(t, createMemoryBudget({ env: {}, ...plenty, available: async () => free }));
    f.release();
    const run = await f.start("low", [task("m1"), task("m2")]),
      stopped = await f.start("stopped", [task("s1")]);
    await pause(300);
    const waiting = await f.record(run.graphId);
    assert.deepEqual(
      waiting.tasks.map(task => task.status),
      ["pending", "pending"],
    );
    assert.equal(f.log("m1").length + f.log("m2").length, 0, "no agent process starts");
    assert.ok(waiting.log);
    assert.deepEqual(
      waiting.log.map(line => line.text),
      ["waiting for memory: 3.1 GB available, floor 4 GB"],
      "one line however long the wait",
    );
    f.cancel("stopped");
    assert.equal(
      (await f.finished(stopped.graphId)).status,
      "cancelled",
      "a run cancelled while it waits for memory ends",
    );
    assert.equal(f.log("s1").length, 0);
    free = 12;
    const ended = await f.finished(run.graphId);
    assert.deepEqual(
      ended.tasks.map(task => task.status),
      ["succeeded", "succeeded"],
    );
    assert.ok(ended.log);
    assert.deepEqual(
      ended.log.map(line => line.text),
      ["waiting for memory: 3.1 GB available, floor 4 GB", "memory available: 12.0 GB available, the app uses 0.0 GB"],
    );
  },
);

test("a workflow's own maxConcurrency still bounds it when the global cap allows more", { timeout: 20000 }, async t => {
  const f = budgetFixture(t, createMemoryBudget({ env: { ELPIS_WORKER_CAP: "8" }, ...plenty }));
  const ids = ["c1", "c2", "c3"];
  const run = await f.start(
    "bounded",
    ids.map(id => task(id)),
    { maxConcurrency: 2 },
  );
  await f.until(() => f.started(ids).length >= 2, "two nodes start");
  await pause(300);
  assert.deepEqual(f.started(ids), ["c1", "c2"]);
  assert.equal(f.log("c3").length, 0, "the third node waits for its own workflow");
  f.release();
  assert.deepEqual(
    (await f.finished(run.graphId)).tasks.map(task => task.status),
    ["succeeded", "succeeded", "succeeded"],
  );
});
