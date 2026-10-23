#!/usr/bin/env node
// pre-install.mjs: runs every fast, bridge and desktop test file, a few at a time at low priority, and lists each file that fails.
// Run it before an install, not after every change (22 Oct: an install shipped without a module the package list lacked, and two tests had drifted;
// Masih: "I don't like those full test suites. Don't do them too often."). ELPIS_CHECK_JOBS sets how many run at once (default 8). Installs must be quick
// (Masih, 23 Oct: "it's unacceptable for your builds to take long. period."): the one file that took 100 s alone runs as four shards of its tests.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const inventory = JSON.parse(fs.readFileSync(new URL('../test-inventory.json', import.meta.url), 'utf8'));
// ELPIS_CHECK_FILES (comma-separated) runs only those files: the check's own test uses it.
const files = process.env.ELPIS_CHECK_FILES ? process.env.ELPIS_CHECK_FILES.split(',') : ['fast', 'bridge', 'desktop'].flatMap(tier => inventory[tier]).filter(file => /\.test\./.test(file));
const jobs = Math.max(1, Number(process.env.ELPIS_CHECK_JOBS) || 8);
// A file whose tests each start their own processes: split its tests by name over several runs of the same file.
const SHARDED = { 'bridge/claude-turn-delivery.test.mjs': { sources: ['../../../tools/elpis-claude/test/turn-delivery.test.mjs', '../../../tools/elpis-claude/test/claude-turn-record.test.mjs'], ways: 4 } };
const escape = name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shardsOf = file => {
  const shard = SHARDED[file];
  if (!shard) return [{ file, args: [] }];
  const names = shard.sources.flatMap(source => [...fs.readFileSync(new URL(source, new URL('../bridge/', import.meta.url)), 'utf8').matchAll(/^test\((["'`])((?:\\.|(?!\1).)*)\1/gm)].map(match => match[2]));
  return Array.from({ length: shard.ways }, (_, way) => ({ file, args: names.filter((_, index) => index % shard.ways === way).flatMap(name => ['--test-name-pattern', escape(name)]) }));
};

// Each file runs in its own process group, and the whole group goes when the file ends, times out or this check is stopped. Killing only the
// runner left the file's own process (and anything it started) running: six such leftovers ran for up to 24 h on 23 Oct.
const groups = new Set();
const stopGroup = pid => { try { process.kill(-pid, 'SIGKILL'); } catch {} };
process.on('exit', () => { for (const pid of groups) stopGroup(pid); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(130));

const check = ({ file, args }) => new Promise(resolve => {
  const started = Date.now();
  let output = '';
  const child = spawn('nice', ['-n', '19', process.execPath, '--test', '--test-reporter=tap', ...args, file], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  groups.add(child.pid);
  const timer = setTimeout(() => stopGroup(child.pid), 300_000);
  child.stdout.on('data', chunk => { output += chunk; });
  child.on('close', status => {
    clearTimeout(timer); stopGroup(child.pid); groups.delete(child.pid);
    const fail = /^# fail (\d+)/m.exec(output)?.[1];
    resolve({ file, seconds: (Date.now() - started) / 1000, failure: status !== 0 || fail !== '0' ? `${file} (${fail ?? 'did not finish'} failing)` : null });
  });
});

const started = Date.now(), queue = files.flatMap(shardsOf).sort((a, b) => (b.args.length ? 1 : 0) - (a.args.length ? 1 : 0)), results = new Map();
await Promise.all(Array.from({ length: jobs }, async () => { for (let job; (job = queue.shift());) { const done = await check(job); const was = results.get(job.file); results.set(job.file, { file: job.file, seconds: Math.max(done.seconds, was?.seconds ?? 0), failure: was?.failure ?? done.failure }); } }));

const failed = files.map(file => results.get(file).failure).filter(Boolean);
console.log(`${files.length - failed.length} of ${files.length} files pass, in ${Math.round((Date.now() - started) / 1000)} s, ${jobs} at a time`);
console.log(`slowest: ${[...results.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 5).map(({ file, seconds }) => `${file} ${Math.round(seconds)} s`).join(', ')}`);
for (const failure of failed) console.log(`FAILED ${failure}`);
process.exit(failed.length ? 1 : 0);
