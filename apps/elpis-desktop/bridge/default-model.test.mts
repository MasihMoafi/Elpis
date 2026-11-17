import test from "node:test";
import assert from "node:assert/strict";
import { availableDefault } from "../lib/default-model.mts";

const models = [{ model: "claude/opus" }, { model: "gpt-6.1-sol", isDefault: true }];
const providers = { openai: { auth: { state: "signedIn" } }, claude: { state: "notConnected" } };
test("a disconnected subscription cannot remain the new-chat default, even in a cached catalogue", () => {
  assert.deepEqual(availableDefault({ model: "claude/opus", provider: "openai" }, models, providers), { model: "gpt-6.1-sol", provider: "openai" });
});
test("temporary discovery failure and a healthy chosen model preserve the default", () => {
  assert.equal(availableDefault({ model: "claude/opus", provider: "openai" }, models, { ...providers, claude: { state: "unknown" } }), null);
  assert.equal(availableDefault({ model: "gpt-6.1-sol", provider: "openai" }, models, providers), null);
  assert.equal(availableDefault({ model: "claude/opus", provider: "openai" }, [], providers), null);
});
test("an account rejection outweighs cached models and never selects a disconnected replacement", () => {
  assert.deepEqual(availableDefault({ model: "claude/opus", provider: "openai" }, models, { ...providers, claude: { state: "available", unavailable: true } }), { model: "gpt-6.1-sol", provider: "openai" });
  assert.equal(availableDefault({ model: "claude/opus", provider: "openai" }, models, { ...providers, openai: { auth: { state: "signedOut" } } }), null);
});
