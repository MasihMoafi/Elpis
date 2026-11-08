import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGoalStore } from "./matilda-goals.mts";

test("goal records persist privately and reject conflicting writers", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "matilda-goals-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const a = createGoalStore(home),
    b = createGoalStore(home);
  const goal = await a.create({
    originalRequest: "Build it",
    decisions: ["Keep the contract"],
    constraints: ["Local only"],
    tasks: [{ id: "one", ownerSession: "session", model: "model", worktree: "/work", status: "working" }],
    messages: [{ taskId: "one", text: "Start", state: "sent", at: "2026-11-07T00:00:00Z" }],
    evidence: [],
    nextAction: "Wait",
  });
  assert.deepEqual(await b.get(goal.id), goal);
  const results = await Promise.allSettled([
    a.update(goal.id, goal.revision, { evidence: ["first"] }),
    b.update(goal.id, goal.revision, { evidence: ["second"] }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const saved = await b.get(goal.id);
  assert.equal(saved?.revision, 2);
  assert.equal(saved?.constraints[0], "Local only");
  assert.equal((await b.list()).length, 1);
  await assert.rejects(a.update(goal.id, goal.revision, { nextAction: "overwrite" }), /changed/);
  await assert.rejects(a.get("../escape"), /Invalid/);
  assert.equal((await fs.stat(path.join(home, "matilda", "goals"))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(home, "matilda", "goals", `${goal.id}.json`))).mode & 0o777, 0o600);
});
