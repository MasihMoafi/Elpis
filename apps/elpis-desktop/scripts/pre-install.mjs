#!/usr/bin/env node
// pre-install.mjs: runs every fast, bridge and desktop test file, a few at a time at low priority, and lists each file that fails.
// Run it before an install, not after every change (22 Oct: an install shipped without a module the package list lacked, and two tests had drifted;
// Masih: "I don't like those full test suites. Don't do them too often."). ELPIS_CHECK_JOBS sets how many files run at once (default 4).
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const root = new URL('../', import.meta.url).pathname;
const inventory = JSON.parse(fs.readFileSync(new URL('../test-inventory.json', import.meta.url), 'utf8'));
const files = ['fast', 'bridge', 'desktop'].flatMap(tier => inventory[tier]).filter(file => /\.test\./.test(file));
const jobs = Math.max(1, Number(process.env.ELPIS_CHECK_JOBS) || 4);

const check = file => new Promise(resolve => {
  const started = Date.now();
  let output = '';
  const child = spawn('nice', ['-n', '19', process.execPath, '--test', '--test-reporter=tap', file], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
  child.stdout.on('data', chunk => { output += chunk; });
  child.on('close', status => {
    clearTimeout(timer);
    const fail = /^# fail (\d+)/m.exec(output)?.[1];
    resolve({ file, seconds: (Date.now() - started) / 1000, failure: status !== 0 || fail !== '0' ? `${file} (${fail ?? 'did not finish'} failing)` : null });
  });
});

const started = Date.now(), queue = [...files], results = new Map();
await Promise.all(Array.from({ length: jobs }, async () => { for (let file; (file = queue.shift());) results.set(file, await check(file)); }));

const failed = files.map(file => results.get(file).failure).filter(Boolean);
console.log(`${files.length - failed.length} of ${files.length} files pass, in ${Math.round((Date.now() - started) / 1000)} s, ${jobs} at a time`);
console.log(`slowest: ${[...results.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 5).map(({ file, seconds }) => `${file} ${Math.round(seconds)} s`).join(', ')}`);
for (const failure of failed) console.log(`FAILED ${failure}`);
process.exit(failed.length ? 1 : 0);
