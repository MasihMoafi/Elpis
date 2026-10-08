// The context split Elpis draws for a bridged chat (/context, the Context Ledger, the dashboard).
// Elpis requires its parts to add up to the reported context; a debug build panicked when the
// text-length estimates exceeded what Antigravity reported (4379 vs 3210).
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitContext } from "../context-split.mjs";

const total = (split) => Object.entries(split).filter(([k]) => k !== "estimatedTotal").reduce((sum, [, v]) => sum + v, 0);

test("estimates larger than the reported context shrink to fit it", () => {
  const split = splitContext({ user: 9000, agent: 4000, reasoning: 0, toolCalls: 2000, toolResults: 2516 }, 0, 3210);
  assert.equal(split.estimatedTotal, 3210);
  assert.equal(total(split), 3210);
  assert.equal(split.systemInstructions, 0);
  assert.ok(split.userMessages > split.agentMessages, "proportions are kept");
});

test("the rest of a larger reported context is the system instructions", () => {
  const split = splitContext({ user: 400, agent: 800, reasoning: 0, toolCalls: 0, toolResults: 0 }, 2000, 5000);
  assert.deepEqual([split.userMessages, split.agentMessages, split.developerMessages], [100, 200, 500]);
  assert.equal(split.systemInstructions, 4200);
  assert.equal(total(split), 5000);
});
