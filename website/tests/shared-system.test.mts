// The site takes the shared parts of ~/Desktop/p/shared-system (skills/shared-system, requirements 1, 6 and 7).
// The UI lint is the desktop app's generated copy (one copy per repository); ui-check.json names what it reads
// (styles.css and technical.html are build output, candidates/, prototypes/ and evidence/ are not served pages).
// Today's findings are listed in ui-check.known.json; the list may only shrink.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { lint, readConfig } from "../../apps/elpis-desktop/scripts/ui-lint.generated.mjs";

const site = path.resolve(import.meta.dirname, "..");

test("the UI lint finds nothing beyond the known findings", async () => {
  const findings: { rule: string; file: string; line: number; msg: string }[] = await lint(site, await readConfig(site));
  const budget = new Map<string, number>(Object.entries(JSON.parse(fs.readFileSync(path.join(site, "ui-check.known.json"), "utf8"))));
  const fresh = findings.filter(f => {
    const key = `${f.rule}|${f.file}|${f.msg}`, left = budget.get(key) ?? 0;
    budget.set(key, left - 1);
    return left <= 0;
  });
  assert.deepEqual(fresh.map(f => `${f.rule} ${f.file}:${f.line} ${f.msg}`), [], "new UI-rule findings; fix them (a fixed known one: lower its count in ui-check.known.json)");
});

test("the generated copy of the UI lint matches its source", () => {
  const sync = spawnSync(process.execPath, [path.join(site, "../apps/elpis-desktop/scripts/ui-lint-sync.mts"), "--check"], { encoding: "utf8" });
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
});
