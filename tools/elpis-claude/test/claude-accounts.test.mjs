import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { once } from "node:events";
import { createTestTempDir, removeTestTempDir } from "./temp-root.mjs";
import { ClaudeAccounts } from "../claude-accounts.mjs";

function fixture(t) {
  const root = createTestTempDir(path.join(os.tmpdir(), "elpis-claude-accounts-"));
  t.after(() => removeTestTempDir(root));
  const home = path.join(root, "home"), dir = path.join(root, "state");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "primary-secret", subscriptionType: "max" } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "first@example.com" } }));
  const accounts = new ClaudeAccounts({ home, dir, claudeBin: "/does-not-exist" });
  t.after(() => accounts.close());
  return { home, dir, accounts };
}

test("two isolated Claude logins persist and select the correct credentials without exposing them", t => {
  const { home, dir, accounts } = fixture(t);
  const original = fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8");
  assert.equal(accounts.snapshot().accounts[0].email, "first@example.com");
  const second = accounts.add();
  assert.notEqual(accounts.configDir(second.id), path.join(home, ".claude"));
  assert.throws(() => accounts.select(second.id), /Sign in/);
  fs.writeFileSync(path.join(accounts.configDir(second.id), ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "second-secret", subscriptionType: "pro" } }));
  fs.writeFileSync(path.join(accounts.configDir(second.id), ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "second@example.com" } }));
  accounts.select(second.id);
  assert.equal(accounts.snapshot().activeId, second.id);
  assert.equal(accounts.credentials().accessToken, "second-secret");
  assert.equal(accounts.snapshot().accounts[1].email, "second@example.com");
  assert.equal(fs.statSync(accounts.configDir()).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "claude-accounts.json")).mode & 0o777, 0o600);
  assert.equal(new ClaudeAccounts({ home, dir }).snapshot().activeId, second.id);
  assert.doesNotMatch(JSON.stringify(accounts.snapshot()), /primary-secret|second-secret|accessToken/);
  accounts.select("default");
  assert.equal(accounts.credentials().accessToken, "primary-secret");
  assert.equal(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8"), original);
});

test("unknown accounts, malformed state and extra accounts never fall back to another login", t => {
  const { dir, accounts } = fixture(t);
  assert.throws(() => accounts.select("../../elsewhere"), /Unknown/);
  accounts.add();
  assert.throws(() => accounts.add(), /two Claude accounts/);
  fs.writeFileSync(path.join(dir, "claude-accounts.json"), "broken");
  assert.throws(() => accounts.snapshot(), /Claude account settings/);
});

test("signing into the same account twice cannot masquerade as a second usage allowance", t => {
  const { home, accounts } = fixture(t), second = accounts.add();
  fs.writeFileSync(path.join(home, ".claude", ".claude.json"), "{}");
  assert.equal(accounts.account("default").email, "first@example.com", "an unrelated config does not mask the original login identity");
  fs.writeFileSync(path.join(accounts.configDir(second.id), ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "different-token-same-account" } }));
  fs.writeFileSync(path.join(accounts.configDir(second.id), ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "FIRST@example.com" } }));
  assert.equal(accounts.snapshot().accounts[1].duplicate, true);
  assert.throws(() => accounts.select(second.id), /same Claude account and share its limit/);
  assert.equal(accounts.activeId(), "default");
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "first@example.com", organizationUuid: "personal" } }));
  fs.writeFileSync(path.join(accounts.configDir(second.id), ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "first@example.com", organizationUuid: "work" } }));
  assert.equal(accounts.snapshot().accounts[1].duplicate, false, "distinct organizations can have separate subscriptions under the same email");
  accounts.select(second.id);
});

test("Claude's actual CLI sign-in flow accepts a browser code into the isolated account", async t => {
  const { dir, accounts } = fixture(t), second = accounts.add();
  const cli = path.join(dir, "fake-claude.mjs");
  fs.writeFileSync(cli, `#!${process.execPath}\nimport fs from 'node:fs'; import readline from 'node:readline'; console.log('Opening browser: https://claude.com/cai/oauth/authorize?state=fixture'); readline.createInterface({input:process.stdin}).once('line',code=>{ if(code!=='fixture-code')process.exit(1); fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR+'/.credentials.json',JSON.stringify({claudeAiOauth:{accessToken:'authenticated-fixture-token'}}),{mode:0o600}); process.exit(0); });\n`, { mode: 0o700 });
  accounts.claudeBin = cli;
  const result = await accounts.login(second.id);
  assert.equal(result.authUrl, "https://claude.com/cai/oauth/authorize?state=fixture");
  assert.equal(accounts.snapshot().accounts[1].signingIn, true);
  assert.equal(accounts.activeId(), "default", "opening sign-in does not silently switch the current account");
  const job = accounts.logins.get(second.id), exited = once(job.child, "exit");
  job.child.stdin.write("fixture-code\n"); await exited;
  assert.equal(accounts.snapshot().accounts[1].authenticated, true);
  assert.equal(accounts.snapshot().accounts[1].signingIn, false);
  assert.doesNotMatch(JSON.stringify(accounts.snapshot()), /authenticated-fixture-token/);
  accounts.select(second.id);
  assert.equal(accounts.environment().CLAUDE_CONFIG_DIR, accounts.configDir(second.id));
  assert.equal(accounts.environment().ANTHROPIC_API_KEY, undefined);
});
