import assert from "node:assert/strict";
import test from "node:test";
import { admissionStateAt, DEMO_TOKENS } from "../assets/demo-state.mjs";

test("sending the prompt increases request context, never admitted source files", () => {
  const before = admissionStateAt(.4), sent = admissionStateAt(.45);
  assert.equal(sent.total - before.total, DEMO_TOKENS.prompt);
  assert.equal(sent.sources, before.sources);
});
test("pending raw output stays outside context until its optimized result is admitted", () => {
  const read = admissionStateAt(.6), optimizing = admissionStateAt(.8), done = admissionStateAt(.95);
  assert.equal(optimizing.total, read.total);
  assert.equal(done.total - optimizing.total, DEMO_TOKENS.optimized);
  assert.equal(done.saved, DEMO_TOKENS.raw - DEMO_TOKENS.optimized);
  assert.equal(optimizing.saved, 0);
});
test("all phases reconcile categories and the window percentage", () => {
  for (const progress of [0,.3,.45,.6,.8,.95,1]) {
    const state = admissionStateAt(progress);
    assert.equal(state.total, state.conversation + state.sources);
    assert.equal(state.usedPercent, state.total / DEMO_TOKENS.limit * 100);
    assert.equal(state.remaining, DEMO_TOKENS.limit - state.total);
  }
});
test("scrubbing backwards is deterministic and resets saved-token feedback", () => {
  const original = admissionStateAt(.6);
  assert.ok(admissionStateAt(1).saved > 0);
  assert.deepEqual(admissionStateAt(.6), original);
  assert.equal(admissionStateAt(0).saved, 0);
});
