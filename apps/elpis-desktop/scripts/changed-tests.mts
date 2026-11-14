#!/usr/bin/env node
// Runs, here and before a push, the small unit test files (the fast tier) the unpushed commits changed (5 Nov, Masih:
// "add lints to help you catch issues before CI failures"; a test that read a fixture field that does not exist reached
// GitHub twice). Nothing heavy runs on his laptop (Masih: "Please don't do builds locally"; its fans): no build, no
// browser, no bridge or desktop tier. GitHub's "Elpis desktop" run tests those after the push to build/**.
// Usage: node scripts/changed-tests.mts [BASE] (default: the branch's upstream). Exit 0 when nothing ran or all passed.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
// A hook runs with GIT_DIR set, which makes git take the working directory for the repository's top: every path then
// kept its apps/elpis-desktop/ prefix and no changed test was ever found. Let git find the checkout itself.
const gitEnv = { ...process.env };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete gitEnv[name];
const git = (...args: string[]) => execFileSync('git', args, { cwd: app, encoding: 'utf8', env: gitEnv }).trim();
const base = process.argv[2] || (() => { try { return git('merge-base', 'HEAD', '@{upstream}'); } catch { return 'HEAD~1'; } })();
const prefix = git('rev-parse', '--show-prefix');
const changed = git('diff', '--name-only', `${base}..HEAD`, '--', '.').split('\n').filter(Boolean).map(file => file.slice(prefix.length));
const inventory = JSON.parse(fs.readFileSync(path.join(app, 'test-inventory.json'), 'utf8')) as Record<string, string[]>;
const tierOf = new Map(Object.entries(inventory).flatMap(([tier, files]) => files.map(file => [file, tier])));
const all = changed.filter(file => tierOf.has(file) && tierOf.get(file) !== 'opt-in' && fs.existsSync(path.join(app, file)));
if (!all.length) { console.log('changed-tests: no changed desktop test files'); process.exit(0); }

const tests = all.filter(file => tierOf.get(file) === 'fast');
const left = all.length - tests.length;
if (left) console.log(`changed-tests: GitHub runs the other ${left} changed test file(s) (bridge, desktop, browser); none run here.`);
if (!tests.length) process.exit(0);
console.log(`changed-tests: ${tests.length} file(s): ${tests.join(' ')}`);
const run = spawnSync('nice', ['-n', '19', process.execPath, '--test', '--test-concurrency=1', ...tests],
  { cwd: app, stdio: 'inherit', env: { ...gitEnv, NODE_NO_WARNINGS: '1' } });
process.exit(run.status ?? 1);
