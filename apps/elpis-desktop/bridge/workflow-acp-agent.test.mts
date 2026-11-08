import { createTestTempDir, removeTestTempDir } from "../tests/temp-root.cts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktopServer } from "./server.mts";
import { loveNodeSpec } from "./love-agents.mts";
import { createWorkflowHistory, createWorkflowRuns } from "./workflow-acp.mts";
import { ROOT, FAKE, pause, task, fixture } from "./workflow-acp.fixtures.mts";
import type { FakeEnv } from "./workflow-acp.fixtures.mts";

test("an explicit desktop profile reaches the actual workflow agent despite an ambient profile", async t => {
  const home = createTestTempDir(path.join(os.tmpdir(), "workflow-profile-"));
  t.after(() => removeTestTempDir(home));
  const endpoints = ["ELPIS_APP_BRIDGE_SOCKET", "ELPIS_BRIDGE_SOCKET", "ELPIS_BRIDGE_URL"];
  const ambient = Object.fromEntries(endpoints.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(ambient)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const key of endpoints) process.env[key] = path.join(home, "foreign-profile.sock");
  const expected = { ELPIS_HOME: home, ...Object.fromEntries(endpoints.map(key => [key, null])) };
  const f = fixture(
    t,
    {
      env: {
        ELPIS_HOME: path.join(home, "ambient"),
        ELPIS_NODE_BIN: process.execPath,
        ELPIS_ENGINE_BIN: fileURLToPath(
          new URL("../../../tools/elpis-claude/test/fake-app-server.mts", import.meta.url),
        ),
        ELPIS_ACP_AGENT: FAKE,
      },
      nodeSpec: (node, env) => {
        const spec = loveNodeSpec(node, env);
        return {
          ...spec,
          env: { ...spec.env, FAKE_ACP_EXPECT_ENV: spec.env.FAKE_ACP_EXPECT_ENV ?? JSON.stringify(expected) },
        };
      },
    },
    { home },
  );
  await f.client.initialize();
  const started = await f.run([task("profile")]);
  assert.equal(
    (await f.finished(started.graphId)).status,
    "succeeded",
    "the spawned agent itself refuses a different home or any ambient endpoint",
  );
  const explicit = {
    ...expected,
    ELPIS_HOME: path.join(home, "node-profile"),
    ELPIS_APP_BRIDGE_SOCKET: path.join(home, "node.sock"),
  };
  fs.writeFileSync(
    path.join(home, "acp-agents.json"),
    JSON.stringify({
      external: {
        command: process.execPath,
        args: [FAKE],
        env: {
          ELPIS_HOME: explicit.ELPIS_HOME,
          ELPIS_APP_BRIDGE_SOCKET: explicit.ELPIS_APP_BRIDGE_SOCKET,
          FAKE_ACP_MODELS: "m-fast",
          FAKE_ACP_EXPECT_ENV: JSON.stringify(explicit),
        },
      },
    }),
  );
  f.root.modelProvider = "external";
  assert.equal(
    (await f.finished((await f.run([task("explicit-node")])).graphId)).status,
    "succeeded",
    "explicit per-node environment overrides remain authoritative",
  );
});

test(
  "Restart waits through local workflow admission and final persistence while engine threads stay idle",
  { timeout: 20000 },
  async t => {
    const f = fixture(t);
    await f.client.initialize();
    const app = await startDesktopServer({
      client: f.client,
      elpisHome: f.dir,
      trashFile: path.join(f.dir, "trash.json"),
      loveSpot: { directory: path.join(f.dir, "drawing"), screenshots: path.join(f.dir, "screenshots") },
    });
    const gate = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const admission = gate(),
      admitting = gate(),
      finish = gate(),
      finishing = gate();
    const send = f.socket.send,
      rename = fs.promises.rename;
    let holdRead = true,
      run;
    f.socket.send = raw => {
      if (JSON.parse(raw).method === "thread/read" && holdRead) {
        admitting.resolve();
        void admission.promise.then(() => send(raw));
      } else send(raw);
    };
    fs.promises.rename = async (from, to) => {
      if (
        (to as string).startsWith(path.join(f.dir, "state") + path.sep) &&
        JSON.parse(await fs.promises.readFile(from, "utf8")).status === "succeeded"
      ) {
        finishing.resolve();
        await finish.promise;
      }
      return rename(from, to);
    };
    try {
      assert.equal(await app.canRestart(), true);
      run = f.run([task("restart-evidence")]);
      await admitting.promise;
      assert.equal(await app.canRestart(), false, "workflow admission has not reached its active runner yet");
      holdRead = false;
      admission.resolve();
      await run;
      assert.equal(await app.canRestart(), false, "local ACP execution is running despite an idle native thread");
      await finishing.promise;
      assert.equal(await app.canRestart(), false, "the last durable workflow result is still pending");
      finish.resolve();
      assert.equal((await f.finished((await run).graphId)).status, "succeeded");
      assert.equal(f.root.status.type, "idle");
      assert.equal(await app.canRestart(), true);
    } finally {
      holdRead = false;
      admission.resolve();
      finish.resolve();
      fs.promises.rename = rename;
      try {
        const started = await run?.catch(() => null);
        if (started) await f.finished(started.graphId);
      } finally {
        await app.close();
      }
    }
  },
);

test(
  "Workflows uses real ACP and hands only completed dependency answers to the next agent",
  { timeout: 20000 },
  async t => {
    const f = fixture(t);
    await f.client.initialize();
    const r = await f.run([task("a"), task("b", ["a"], "Use the planted answer")]);
    assert.equal(
      f.socket.sent.some(row => row.method.startsWith("workGraph/run")),
      false,
      "native execution is disabled",
    );
    const g = await f.finished(r.graphId);
    assert.equal(g.status, "succeeded");
    const prompt = f.log("b").find(row => row.method === "session/prompt")!.params.prompt[0]!.text;
    assert.match(prompt, /a\(m-fast\) answered: Seed workflow-acp-739/);
    assert.equal(f.log("a").filter(row => row.method === "session/prompt").length, 1);
    assert.ok(g.tasks.every(row => row.assignedThreadId && row.result?.summary));
  },
);

test("workflow history lists persisted teams without a selected conversation", { timeout: 20000 }, async t => {
  const f = fixture(t);
  await f.client.initialize();
  assert.deepEqual((await f.client.workflowHistory()).data, [], "An empty history does not invent workflows");
  const started = await f.run([task("saved-team")]);
  const completed = await f.finished(started.graphId);
  const history = (await f.client.workflowHistory()).data;
  const record = history.find(row => row.id === completed.id);
  assert.ok(record);
  assert.ok(record.tasks[0]);
  assert.equal(record.rootThreadId, ROOT);
  assert.equal(record.name, "ACP team");
  assert.equal(record.status, "succeeded");
  assert.equal(record.tasks[0].id, "saved-team");
});

test("a dead workflow owner cannot leave Mother agent running and block history removal", async t => {
  const stateDir = createTestTempDir(path.join(os.tmpdir(), "workflow-orphan-"));
  t.after(() => removeTestTempDir(stateDir));
  const cases = [
    { status: "running", mother: "running", ownerPid: 2147483647, removable: true },
    { status: "cancelled", mother: "running", ownerPid: 2147483647, removable: true },
    { status: "failed", mother: "reviewing", ownerPid: 2147483647, removable: true },
    { status: "cancelled", mother: "running", ownerPid: process.pid, removable: false },
  ];
  const ids = cases.map((entry, index) => {
    const id = `00000000-0000-0000-0000-${String(index + 2).padStart(12, "0")}`;
    fs.writeFileSync(
      path.join(stateDir, `${id}.json`),
      JSON.stringify({
        id,
        rootThreadId: ROOT,
        status: entry.status,
        ownerPid: entry.ownerPid,
        mother: { status: entry.mother },
        tasks: [],
      }),
    );
    return id;
  });
  const runs = createWorkflowRuns({ stateDir });
  const history = createWorkflowHistory(path.join(stateDir, "history.json"));
  const read = () => runs.list();
  const listed = await history.list(await read());
  for (const [index, entry] of cases.entries()) {
    const row = listed.data.find(row => row.id === ids[index]);
    assert.ok(row);
    assert.equal(row.removable, entry.removable, `${entry.status}/${entry.mother}, owner ${entry.ownerPid}`);
    if (entry.removable) assert.equal((await history.remove(row.id, read)).removed, row.id);
    else await assert.rejects(history.remove(row.id, read), /Finish this workflow/);
  }
});

test("failure blocks dependent ACP nodes; an independent node can finish", { timeout: 20000 }, async t => {
  const f = fixture(t);
  await f.client.initialize();
  const r = await f.run([task("a", [], "[crash]"), task("b", ["a"]), task("c")]);
  const g = await f.finished(r.graphId);
  assert.equal(g.status, "failed");
  const b = g.tasks.find(n => n.id === "b");
  assert.ok(b);
  assert.equal(b.status, "blocked");
  assert.equal(f.log("b").length, 0);
  const c = g.tasks.find(n => n.id === "c");
  assert.ok(c);
  assert.equal(c.status, "succeeded");
});

test(
  "the Mother agent rescues a failed step on Claude Opus and knows the run's goal; a blank goal is not kept",
  { timeout: 20000 },
  async t => {
    const f = fixture(t);
    await f.client.initialize();
    const g = await f.finished(
      (await f.run([task("a", [], "[crash]")], { goal: "Translate the leaflet into Farsi" })).graphId,
    );
    assert.equal(g.goal, "Translate the leaflet into Farsi");
    // Since 3 Nov (caeea5006) the Mother runs on the Claude subscription, Opus first (bridge/workflow-models.mts).
    assert.ok(g.mother);
    assert.deepEqual([g.mother.model, g.mother.provider], ["claude/opus", "claude"], "she rescues on Claude Opus");
    const rescue = f
      .log("Mother agent")
      .filter(row => row.method === "session/prompt")
      .map(row => row.params.prompt[0]!.text)
      .join("\n");
    assert.match(rescue, /Goal: Translate the leaflet into Farsi\./);
    const blank = await f.finished((await f.run([task("b")], { goal: "   " })).graphId);
    assert.equal(blank.goal, undefined, "a blank goal is not kept");
  },
);

test(
  "recursive feedback runs exactly the explicit number of rounds, with previous round answers",
  { timeout: 20000 },
  async t => {
    const f = fixture(t);
    await f.client.initialize();
    const tasks = [{ ...task("a"), feedbackFrom: ["b"] }, task("b", ["a"], "Continue")];
    const r = await f.run(tasks, { roundLimit: 2 });
    const g = await f.finished(r.graphId);
    assert.equal(g.status, "succeeded");
    assert.equal(g.round, 2);
    const prompts = f.log("a").filter(row => row.method === "session/prompt");
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0]!.params.prompt[0]!.text, /b\(m-fast\)/);
    assert.match(prompts[1]!.params.prompt[0]!.text, /b\(m-fast\) answered/);
  },
);

test("cycles, missing dependencies, duplicate IDs and unbounded feedback fail before spawning", async t => {
  const f = fixture(t);
  await f.client.initialize();
  for (const tasks of [
    [task("a", ["b"]), task("b", ["a"])],
    [task("a", ["missing"])],
    [task("a"), task("a")],
    [{ ...task("a"), feedbackFrom: ["a"] }],
  ])
    await assert.rejects(f.run(tasks), /loop|depend|unique|round limit/i);
  assert.equal(f.log("a").length, 0);
});

test(
  "a root cannot start two runs; interrupt cancels ACP and never starts a waiting dependent",
  { timeout: 20000 },
  async t => {
    const f = fixture(t);
    await f.client.initialize();
    const r = await f.run([task("a", [], "[hang]"), task("b", ["a"])]);
    await assert.rejects(f.run([task("c")]), /already running/);
    for (let n = 0; n < 200 && !f.log("a").some(row => row.method === "session/prompt"); n++) await pause(20);
    await f.client.interrupt(ROOT, {});
    const g = await f.finished(r.graphId);
    assert.equal(g.status, "cancelled");
    assert.ok(f.log("a").some(row => row.method === "session/cancel"));
    assert.equal(f.log("b").length, 0);
  },
);

test("failed verification cannot release a downstream writer", { timeout: 20000 }, async t => {
  const f = fixture(t, {
    env: {
      workflowFake: {
        check: { FAKE_ACP_ANSWER: JSON.stringify({ passed: false, summary: "The planted criterion failed" }) },
      },
    },
  });
  await f.client.initialize();
  fs.mkdirSync(path.join(f.dir, "src"));
  const a = { ...task("writer"), kind: "implement", writeScopes: ["src"] };
  const check = { ...task("check", ["writer"], "[fail-check]"), kind: "verify" };
  const r = await f.run([a, check, task("next", ["check"])]);
  const g = await f.finished(r.graphId);
  assert.equal(g.status, "failed");
  const checkResult = g.tasks.find(t => t.id === "check");
  assert.ok(checkResult);
  assert.equal(checkResult.status, "failed");
  assert.equal(f.log("next").length, 0);
});

// 28 Oct, Masih: "Why is it taking so excruciatingly long?" Putting finished parts together needs no agent, no model and
// no check: a join step writes its parts, in order, into its output, and nothing outside the project.
test(
  "a join step puts its parts together in order with no agent, and refuses a part outside the project",
  { timeout: 20000 },
  async t => {
    const f = fixture(t);
    await f.client.initialize();
    fs.mkdirSync(path.join(f.dir, "agents", "a"), { recursive: true });
    fs.mkdirSync(path.join(f.dir, "agents", "b"), { recursive: true });
    fs.writeFileSync(path.join(f.dir, "agents", "a", "pages.md"), "Page one.\n");
    fs.writeFileSync(path.join(f.dir, "agents", "b", "pages.md"), "Page two.\n");
    const join = {
      id: "join",
      kind: "join",
      title: "Join the pages",
      instruction: "Join",
      dependsOn: [],
      writeScopes: ["."],
      acceptanceCriteria: ["all parts"],
      parts: ["agents/a/pages.md", "agents/b/pages.md"],
      output: "transcription.md",
    };
    const g = await f.finished((await f.run([join])).graphId);
    assert.equal(g.status, "succeeded", g.error ?? undefined);
    assert.equal(fs.readFileSync(path.join(f.dir, "transcription.md"), "utf8"), "Page one.\n\nPage two.\n");
    assert.equal(f.log("join").length, 0, "no agent was started");
    // Pages of one text: a page that ends mid-sentence runs on into the next.
    fs.writeFileSync(path.join(f.dir, "agents", "a", "pages.md"), "A sentence that runs\n");
    const flowing = await f.finished((await f.run([{ ...join, id: "flow", flow: true }])).graphId);
    assert.equal(flowing.status, "succeeded", flowing.error ?? undefined);
    assert.equal(fs.readFileSync(path.join(f.dir, "transcription.md"), "utf8"), "A sentence that runs Page two.\n");
    const outside = await f.finished((await f.run([{ ...join, id: "outside", parts: ["../secret.md"] }])).graphId);
    assert.equal(outside.status, "failed");
    assert.ok(outside.error);
    assert.match(outside.error, /outside the project/);
  },
);

// 28 Oct, Masih: the OCR run "shouldn't take this long" and must finish with no further input. Its check found a dropped
// clause and the run stopped, because Mother may only retry the failed node, the check itself. A failed check now sends
// its step back once with the check's findings, and the step is checked again.
test(
  "a failed check sends its step back once with the findings, then checks again and the run goes on",
  { timeout: 20000 },
  async t => {
    const env: FakeEnv & { workflowFake: Record<string, Record<string, string>> } = { workflowFake: {} },
      f = fixture(t, { env });
    fs.mkdirSync(path.join(f.dir, "src"));
    const out = path.join(f.dir, "src", "out.txt");
    Object.assign(env.workflowFake, {
      writer: { FAKE_ACP_WRITE: JSON.stringify({ file: out, text: "fixed", when: "Your check found a problem" }) },
      check: { FAKE_ACP_EXPECT: JSON.stringify({ file: out, text: "fixed" }) },
    });
    await f.client.initialize();
    const r = await f.run([
      { ...task("writer"), kind: "implement", writeScopes: ["src"] },
      { ...task("check", ["writer"]), kind: "verify" },
      task("next", ["check"]),
    ]);
    const g = await f.finished(r.graphId);
    assert.equal(g.status, "succeeded", g.error ?? undefined);
    const prompts = f
      .log("writer")
      .filter(entry => entry.method === "session/prompt")
      .map(entry => JSON.stringify(entry.params));
    assert.equal(prompts.length, 2, "the step ran once more");
    assert.ok(prompts[1]);
    assert.match(prompts[1], /The planted result did not arrive/, "with its check\u2019s findings");
    assert.ok(f.log("next").length > 0, "and the run went on");
  },
);

test(
  "every agent writes: a check gets its own folder, and folders the run names are created inside the project only",
  { timeout: 20000 },
  async t => {
    const f = fixture(t);
    await f.client.initialize();
    const outside = fs.mkdtempSync(path.join(path.dirname(f.dir), "outside-"));
    fs.symlinkSync(outside, path.join(f.dir, "link"));
    await assert.rejects(
      f.run([
        { ...task("escape"), kind: "implement", writeScopes: ["link/agents/escape"] },
        { ...task("escape-check", ["escape"]), kind: "verify" },
      ]),
      /project folder/i,
    );
    assert.deepEqual(fs.readdirSync(outside), [], "nothing is created through a link out of the project");
    const writer = { ...task("writer"), kind: "implement", writeScopes: ["agents/writer"] };
    const check = { ...task("check", ["writer"]), kind: "verify", writeScopes: ["agents/writer/check"] };
    const g = await f.finished((await f.run([writer, check])).graphId);
    assert.equal(g.status, "succeeded", g.error ?? undefined);
    assert.ok(fs.statSync(path.join(f.dir, "agents/writer/check")).isDirectory());
    const opened = f.log("check").find(row => row.method === "session/new")!.params._meta.elpis.workflow;
    assert.deepEqual([opened.kind, opened.writeScopes], ["verify", ["agents/writer/check"]]);
  },
);
