#!/usr/bin/env node
// Runs, here and before a push, every desktop test file the unpushed commits changed (5 Nov, Masih: "add lints to help you
// catch issues before CI failures"; a test that read a fixture field that does not exist reached GitHub twice). It never
// builds (Masih: "Please don't do builds locally"): the browser (UI) tests among them run here only when out/ is already
// a build of exactly HEAD (scripts/actions-build.mts fetches GitHub's); otherwise GitHub runs them after the push.
// Usage: node scripts/changed-tests.mts [BASE] (default: the branch's upstream). Exit 0 when nothing ran or all passed.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
const git = (...args: string[]) => execFileSync('git', args, { cwd: app, encoding: 'utf8' }).trim();
const base = process.argv[2] || (() => { try { return git('merge-base', 'HEAD', '@{upstream}'); } catch { return 'HEAD~1'; } })();
const prefix = git('rev-parse', '--show-prefix');
const changed = git('diff', '--name-only', `${base}..HEAD`, '--', '.').split('\n').filter(Boolean).map(file => file.slice(prefix.length));
const inventory = JSON.parse(fs.readFileSync(path.join(app, 'test-inventory.json'), 'utf8')) as Record<string, string[]>;
const tierOf = new Map(Object.entries(inventory).flatMap(([tier, files]) => files.map(file => [file, tier])));
let tests = changed.filter(file => tierOf.has(file) && tierOf.get(file) !== 'opt-in' && fs.existsSync(path.join(app, file)));
if (!tests.length) { console.log('changed-tests: no changed desktop test files'); process.exit(0); }

const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
const ui = tests.filter(file => tierOf.get(file) === 'ui');
if (ui.length) {
  let built = ''; try { built = fs.readFileSync(path.join(app, 'out/.commit'), 'utf8').trim(); } catch {}
  const head = git('rev-parse', 'HEAD');
  if (built === head) {
    env.ELPIS_PLAYWRIGHT_PACKAGE ||= path.join(os.homedir(), 'Desktop/p/skills/web-dev/ui-check/node_modules/playwright-core');
    env.LOVE_SPOT_TEST_STATIC_DIR ||= path.join(app, 'out'); env.ELPIS_RENDERER_OUT ||= env.LOVE_SPOT_TEST_STATIC_DIR;
  } else {
    console.log(`changed-tests: GitHub runs the ${ui.length} changed browser test(s); there is no build of ${head.slice(0, 9)} here.`);
    tests = tests.filter(file => !ui.includes(file));
    if (!tests.length) process.exit(0);
  }
}
console.log(`changed-tests: ${tests.length} file(s): ${tests.join(' ')}`);
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: app, stdio: 'inherit', env });
process.exit(run.status ?? 1);
