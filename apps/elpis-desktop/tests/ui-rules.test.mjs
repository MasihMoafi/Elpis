// Enforces the shared UI rules checker in the maintainer workspace: fails on any source violation not already
// recorded in ui-check.known.json. Skipped where the shared checker is absent (CI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checker = join(homedir(), "Desktop/p/skills/web-dev/ui-check/ui-check.mjs");

test("UI source follows UI-RULES.md", { skip: !existsSync(checker) }, () => {
  const run = spawnSync(process.execPath, [checker, fileURLToPath(new URL("..", import.meta.url)), "--static"], { encoding: "utf8" });
  assert.match(run.stdout, /^ui-check: pass/, run.stdout);
});
