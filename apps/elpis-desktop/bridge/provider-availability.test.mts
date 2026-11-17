import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ClaudeAccounts } from "../../../tools/elpis-claude/claude-accounts.mts";
import { createProviderCatalog } from "../../../tools/elpis-claude/bridge-provider-catalog.mts";
import { providersSnapshot } from "./provider-projections.mts";

for (const status of [403, 500]) test(`Claude availability distinguishes account rejection from a transient HTTP ${status}`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-availability-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "claude"); await fs.mkdir(directory);
  const credential = path.join(directory, ".credentials.json");
  await fs.writeFile(credential, JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }));
  t.mock.method(globalThis, "fetch", async () => new Response("Account access unavailable", { status }));
  const accounts = new ClaudeAccounts({ home: root, dir: root, defaultConfigDir: directory });
  const catalog = createProviderCatalog({ HOME: root, STATE_DIR: root, CLAUDE: "not-launched", ADAPTER: "not-launched", claudeAccounts: accounts, log: () => {} });
  const agent = catalog.AGENTS[0];
  await assert.rejects(agent.limits(), /usage request failed/);
  assert.equal(agent.signedOut?.(), status === 403);
  assert.equal(catalog.claudeSignedOut(), false, "a rejected account is not falsely described as a user sign-out");
  if (status === 403) assert.throws(() => catalog.refuseSignedOut(agent), /account is unavailable/);
  await fs.writeFile(credential, JSON.stringify({ claudeAiOauth: { accessToken: "test-token-after-sign-in" } }));
  assert.equal(agent.signedOut?.(), false, "new credentials immediately clear the old rejection");
});

test("a known account rejection outweighs cached model names and usage", () => {
  const snapshot = providersSnapshot({ models: [{ model: "claude/opus" }], anthropic: { unavailable: true }, limits: { rateLimitsByLimitId: { claude: { limitId: "claude" } } } });
  assert.equal(snapshot.claude.state, "notConnected");
  assert.equal(snapshot.claude.signedOut, false);
  assert.deepEqual(snapshot.claude.models, []);
});
