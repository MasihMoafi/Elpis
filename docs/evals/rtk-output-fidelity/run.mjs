import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Child stdout is archived before RTK/Elpis can transform the outer tool result.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const spec = 'docs/evals/rq3/PRUNING_ABLATION_DRAFT.md';
const hash = value => createHash('sha256').update(value).digest('hex');
const lines = value => value.split('\n').map(line => line.trim()).filter(Boolean);
const missing = (expected, actual) => expected.filter(line => !actual.includes(line));
const content = line => line.replace(/^\d+:\s*/, '').trim();
const missingFacts = (expected, actual) => expected.filter(line => !actual.includes(content(line)));

const positive = ['essential fact alpha', 'essential fact beta'];
assert.deepEqual(missing(positive, positive.join('\n')), []);
assert.deepEqual(missing(positive, positive[0]), [positive[1]]);
assert.deepEqual(missing(positive, ''), positive);
assert.deepEqual(missingFacts(['12:  essential fact alpha'], '12:essential fact alpha'), []);
assert.deepEqual(missingFacts(['12:  essential fact alpha'], '12:essential fact ...'),
  ['12:  essential fact alpha']);
if (process.argv.includes('--self-test')) {
  console.log('PASS: intact/reformatted output accepted; deleted, shortened, and empty facts rejected');
  process.exit(0);
}

function capture(argv) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
  });
  return {
    argv, status: result.status, signal: result.signal,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? '', stderr: result.stderr ?? '',
  };
}

const cases = [
  {
    id: 'checkpoint-heading', file: 'ES.md',
    task: 'Read the current execution-state heading and intent before editing it.',
    raw: ['head', '-12', 'ES.md'], filtered: ['rtk', 'read', 'ES.md', '--max-lines', '12'],
    critical: /Execution State|Intent:|not implement or run it/,
  },
  {
    id: 'complete-protocol', file: spec,
    task: 'Review the entire experiment protocol, including recovery and approval limits.',
    raw: ['cat', spec], filtered: ['rtk', 'read', spec],
    critical: /NOT APPROVED|one fresh replacement pair|Missing final output|two active Elpis processes|capped calibration batch/,
  },
  {
    id: 'pruning-cache-audit', file: spec,
    task: 'Find all pruning/cache references to audit the experiment controls.',
    raw: ['rg', '-n', 'prun|cache', spec], filtered: ['rtk', 'rg', '-n', 'prun|cache', spec],
    critical: /isolation cannot|independence|cost differences|one pruning pass|pruning model/,
  },
];

const destination = join(root, 'docs/evals/rtk-output-fidelity/runs',
  new Date().toISOString().replaceAll(':', '-') + `-${process.pid}`);
mkdirSync(destination, { recursive: true, mode: 0o700 });
const save = (name, value) => writeFileSync(join(destination, name), value, {
  flag: 'wx', mode: 0o600,
});
const metadata = {
  timestamp: new Date().toISOString(), root, node: process.version,
  rtk: capture(['rtk', '--version']),
  sourceCommit: capture(['git', 'rev-parse', 'HEAD']),
  harnessSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  controls: 'intact accepted; deleted fact and empty output detected before captures',
  scope: 'RTK child-output fidelity, not model behavior or downstream Elpis admission',
};
save('metadata.json', JSON.stringify(metadata, null, 2));
const results = [];
for (const item of cases) {
  const original = readFileSync(join(root, item.file));
  save(`${item.id}.source`, original);
  const raw = capture(item.raw);
  const filtered = capture(item.filtered);
  save(`${item.id}.raw.json`, JSON.stringify(raw, null, 2));
  save(`${item.id}.rtk.json`, JSON.stringify(filtered, null, 2));
  assert.equal(hash(readFileSync(join(root, item.file))), hash(original), 'source changed');
  assert.equal(raw.status, 0, `raw command failed: ${raw.stderr}`);
  assert.equal(filtered.status, 0, `RTK command failed: ${filtered.stderr}`);
  const expected = lines(raw.stdout);
  const important = expected.filter(line => item.critical.test(line));
  assert.ok(important.length > 0, `no critical checks for ${item.id}`);
  const missingCritical = missingFacts(important, filtered.stdout);
  let recovery = null;
  if (missingCritical.length) {
    // One real fallback read, not a predicted count of future agent tool calls.
    recovery = capture(item.raw);
    save(`${item.id}.recovery.json`, JSON.stringify(recovery, null, 2));
    assert.equal(recovery.status, 0);
    assert.deepEqual(missingFacts(important, recovery.stdout), []);
  }
  results.push({
    id: item.id, task: item.task, sourceSha256: hash(original),
    rawSha256: hash(raw.stdout), rtkSha256: hash(filtered.stdout),
    rawBytes: Buffer.byteLength(raw.stdout), rtkBytes: Buffer.byteLength(filtered.stdout),
    byteIdentical: raw.stdout === filtered.stdout,
    nonemptyRawLines: expected.length,
    missingExactLines: missing(expected, filtered.stdout),
    criticalChecks: important.length, missingCritical,
    recoveryReads: recovery ? 1 : 0,
  });
  save(`${item.id}.result.json`, JSON.stringify(results.at(-1), null, 2));
}
save('results.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify({
  evidence: destination,
  cases: results.map(({ id, rawBytes, rtkBytes, byteIdentical, missingExactLines,
    criticalChecks, missingCritical, recoveryReads }) => ({
    id, rawBytes, rtkBytes, byteIdentical, missingExactLines: missingExactLines.length,
    criticalChecks, missingCritical, recoveryReads,
  })),
}, null, 2));
