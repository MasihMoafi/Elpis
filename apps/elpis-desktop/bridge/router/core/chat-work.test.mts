import { it } from "node:test";
import assert from "node:assert/strict";
import { chatWorkDone } from "./model.mts";

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
