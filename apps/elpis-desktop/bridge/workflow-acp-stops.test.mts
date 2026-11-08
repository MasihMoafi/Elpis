import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryBudget } from "./memory-budget.mts";
import { task, budgetFixture, plenty } from "./workflow-acp.fixtures.mts";

test(
  "a run stops at its time limit and says so; agents are told the time left; a run within its limit finishes",
  { timeout: 20000 },
  async t => {
    const f = budgetFixture(t, createMemoryBudget({ env: {}, ...plenty }));
    const slow = await f.start("slow", [task("held")], { runLimitSeconds: 1 });
    const ended = await f.finished(slow.graphId);
    assert.equal(ended.status, "cancelled");
    assert.ok(ended.error);
    assert.match(ended.error, /time limit/);
    f.release();
    const quick = await f.start("quick", [task("fine")], { runLimitSeconds: 60 });
    assert.equal((await f.finished(quick.graphId)).status, "succeeded");
    const prompt = (id: string) => f.instructions.get(id) ?? "";
    assert.match(
      prompt("fine"),
      /Time left for the whole run: about 1 minute\./,
      "agents are told the time left so they finish inside it",
    );
    const open = await f.start("open", [task("unlimited")]);
    await f.finished(open.graphId);
    assert.doesNotMatch(prompt("unlimited"), /Time left/, "a run without a limit says nothing about time");
  },
);
