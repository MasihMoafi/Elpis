#!/usr/bin/env node
// Runs, here and before a push, every desktop test file the unpushed commits changed (5 Nov, Masih: "add lints to help you
// catch issues before CI failures"; a test that read a fixture field that does not exist reached GitHub twice). The UI
// tests among them run against a fresh build of out/ when the renderer changed. Usage: node scripts/changed-tests.mjs [BASE]
// (default: the branch's upstream). Exit 0 when nothing changed or everything passed.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: app, encoding: 'utf8' }).trim();
const base = process.argv[2] || (() => { try { return git('merge-base', 'HEAD', '@{upstream}'); } catch { return 'HEAD~1'; } })();
const prefix = git('rev-parse', '--show-prefix');
const changed = git('diff', '--name-only', `${base}..HEAD`, '--', '.').split('\n').filter(Boolean).map(file => file.slice(prefix.length));
const inventory = JSON.parse(fs.readFileSync(path.join(app, 'test-inventory.json'), 'utf8'));
const tierOf = new Map(Object.entries(inventory).flatMap(([tier, files]) => files.map(file => [file, tier])));
const tests = changed.filter(file => tierOf.has(file) && tierOf.get(file) !== 'opt-in' && fs.existsSync(path.join(app, file)));
if (!tests.length) { console.log('changed-tests: no changed desktop test files'); process.exit(0); }

const env = { ...process.env, NODE_NO_WARNINGS: '1' };
const ui = tests.filter(file => tierOf.get(file) === 'ui');
if (ui.length) {
  env.ELPIS_PLAYWRIGHT_PACKAGE ||= path.join(os.homedir(), 'Desktop/p/skills/web-dev/ui-check/node_modules/playwright-core');
  env.LOVE_SPOT_TEST_STATIC_DIR ||= path.join(app, 'out'); env.ELPIS_RENDERER_OUT ||= env.LOVE_SPOT_TEST_STATIC_DIR;
  // The UI tests read the built renderer: build it unless it is already this commit's.
  let built = ''; try { built = fs.readFileSync(path.join(app, 'out/.commit'), 'utf8').trim(); } catch {}
  if (built !== git('rev-parse', 'HEAD')) {
    console.log('changed-tests: building the renderer for the UI tests');
    if (spawnSync('npm', ['run', 'build'], { cwd: app, stdio: 'inherit', env }).status !== 0) { console.error('changed-tests: the build failed'); process.exit(1); }
  }
}
console.log(`changed-tests: ${tests.length} file(s): ${tests.join(' ')}`);
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: app, stdio: 'inherit', env });
process.exit(run.status ?? 1);
