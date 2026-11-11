// E17 (11 Nov): an agent whose subscription has no quota left stops instead of moving to another one. History says which
// model could not run and why, and offers the step that fits: choose another model and resume, in the run's chat.
import test from "node:test";
import assert from "node:assert/strict";
import { runFailure } from "./workflow-failure.ts";

const run = (failureReason: string) => ({
  status: "failed",
  rootThreadId: "chat-a",
  error: failureReason,
  tasks: [
    { title: "Veyra · Answer 2", status: "succeeded" },
    { title: "Quillon · Answer 1", status: "failed", failureReason, assignedThreadId: "chat-b" },
  ],
});

test("a run stopped by a usage limit says which model could not run and offers to resume with another", () => {
  const before =
    "gpt-6-luna on ChatGPT did not run because the ChatGPT usage limit is reached until 12 Nov, 09:30; wait for the reset, or choose another model for this agent and resume.";
  assert.deepEqual(runFailure(run(before), true), {
    reason:
      "Quillon · Answer 1 could not run gpt-6-luna: the ChatGPT usage limit is reached until 12 Nov, 09:30. Finished work is kept.",
    step: { label: "Choose another model or wait, then resume", chat: "chat-a" },
  });
  const during =
    "claude/opus on Claude stopped because the Claude usage limit was reached during its work; wait for the reset, or choose another model for this agent and resume.";
  assert.deepEqual(runFailure(run(during), true), {
    reason:
      "Quillon · Answer 1 stopped on claude/opus: the Claude usage limit was reached during its work. Finished work is kept.",
    step: { label: "Choose another model or wait, then resume", chat: "chat-a" },
  });
});

test("another provider error still reads as the agent's error and opens its chat", () => {
  assert.deepEqual(runFailure(run("Quillon · Answer 1: The tool crashed"), true), {
    reason: "Quillon · Answer 1 stopped with an error: The tool crashed.",
    step: { label: "Open the agent's chat", chat: "chat-b" },
  });
});
