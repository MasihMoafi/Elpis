#!/usr/bin/env node
// pre-install.mjs: runs every fast, bridge and desktop test file, one at a time at low priority, and lists each file that fails.
// Run it before every install (22 Oct: an install shipped without a module the package list lacked, and two tests had drifted).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const root = new URL('../', import.meta.url).pathname;
const inventory = JSON.parse(fs.readFileSync(new URL('../test-inventory.json', import.meta.url), 'utf8'));
const files = ['fast', 'bridge', 'desktop'].flatMap(tier => inventory[tier]).filter(file => /\.test\./.test(file));
const failed = [];
for (const file of files) {
  const run = spawnSync('nice', ['-n', '19', process.execPath, '--test', '--test-reporter=tap', file], { cwd: root, encoding: 'utf8', timeout: 300_000 });
  const fail = /^# fail (\d+)/m.exec(run.stdout)?.[1];
  if (run.status !== 0 || fail !== '0') failed.push(`${file} (${fail ?? 'did not finish'} failing)`);
}
console.log(`${files.length - failed.length} of ${files.length} files pass`);
for (const file of failed) console.log(`FAILED ${file}`);
process.exit(failed.length ? 1 : 0);
