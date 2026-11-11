import { it } from "node:test";
import assert from "node:assert/strict";
import { chatWorkDone, resultOwed } from "./model.mts";

const chat = { source: "elpis-chat", thread: "elpis-chat:a", address: { threadId: "a" } };

it("ends a ticket that only answers an Elpis chat, so the chat's next message reaches the router", () => {
  assert.equal(chatWorkDone({ channels: [chat] } as never), true);
});
it("keeps a ticket open while it asks the person something, has other channels, or has ended", () => {
  assert.equal(chatWorkDone({ channels: [chat], attention: { id: "q" } } as never), false);
  assert.equal(chatWorkDone({ channels: [chat, { source: "github", thread: "github:1" }] } as never), false);
  assert.equal(chatWorkDone({ channels: [chat], ended: { at: "x" } } as never), false);
  assert.equal(chatWorkDone({ channels: [] } as never), false);
});

it("owes him the result when a ready report ends a job he asked for in the Elpis chat, and only then", () => {
  const done = { at: "now", by: "executor", outcome: "completed" } as never;
  assert.equal(resultOwed("ready", { channels: [chat], ended: done }), true);
  assert.equal(resultOwed("ready", { channels: [chat] }), false, "a report that did not end the job");
  assert.equal(resultOwed("progress", { channels: [chat], ended: done }), false);
  assert.equal(resultOwed("ready", { channels: [chat, { source: "github", thread: "github:1" }] as never, ended: done }), false);
  assert.equal(resultOwed("ready", { channels: [chat], ended: { at: "now", by: "human", outcome: "stopped" } as never }), false);
});
