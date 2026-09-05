import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { auditRoot } from './report.mjs';

const usage = { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20,
  reasoning_output_tokens: 5, total_tokens: 120 };
const source = { type: 'function_call_output', call_id: 'call-1', output: 'PRIVATE_SOURCE' };
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const write = async (root, path, value) => writeFile(join(root, path), JSON.stringify(value, null, 2));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'elpis-prune-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'attempts'));
  await mkdir(join(root, 'admissions/admission-1/items'), { recursive: true });
  const attempt = { schema_version: 1, attempt_id: 'attempt-1', admission_id: 'admission-1',
    session_id: 'session-1', turn_id: 'turn-1', status: 'admitted', latency_ms: 10,
    candidate_outputs: 1, admitted_outputs: 1, saved_tokens: 800, usage,
    input: 'PRIVATE_INPUT', raw_response: 'PRIVATE_RESPONSE', error: null };
  const item = { call_id: 'call-1', source_sha256: digest(source),
    source_artifact: 'items/source.json', admitted_artifact: 'items/admitted.json',
    source_tokens: 1000, admitted_tokens: 200, saved_tokens: 800 };
  const manifest = { schema_version: 1, admission_id: 'admission-1', session_id: 'session-1',
    turn_id: 'turn-1', ace_conversation: 'ace.json', source_tokens: 1000, admitted_tokens: 200, saved_tokens: 800, items: [item] };
  await write(root, 'attempts/attempt-1.json', attempt);
  await write(root, 'admissions/admission-1/manifest.json', manifest);
  await write(root, 'admissions/admission-1/ace.json', { input: 'PRIVATE_ACE_INPUT', raw_response: 'PRIVATE_ACE_REPLY', usage });
  await write(root, 'admissions/admission-1/items/source.json', source);
  await write(root, 'admissions/admission-1/items/admitted.json', { ...source, output: 'PRIVATE_ADMITTED' });
  await write(root, 'admissions/admission-1/request.json', { schema_version: 1,
    admission_id: 'admission-1', request_sequence: 2, request_input_sha256: 'a'.repeat(64) });
  await write(root, 'admissions/admission-1/response.json', { schema_version: 1,
    admission_id: 'admission-1', response_id: 'response-1', usage });
  return { root, attempt, manifest };
}

test('complete receipts report observed savings/reuse without claiming causal proof', async (t) => {
  const { root } = await fixture(t);
  const result = await auditRoot(root);
  assert.equal(result.receipts, 'COMPLETE');
  assert.equal(result.source_reduction.saved_tokens_estimate, 800);
  assert.equal(result.optimizer_usage.input_tokens.total, 100);
  assert.equal(result.optimizer_usage.cache_write_tokens.total, null);
  assert.equal(result.cache_reuse, 'OBSERVED_REUSE');
  assert.equal(result.cache_prefix_preservation, 'NOT_TESTED');
  assert.equal(result.causal_cost_effect, 'NOT_TESTED');
  assert.equal(result.admitted_body_integrity, 'UNVERIFIABLE_NO_RECORDED_HASH');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|session-1|turn-1|call-1|response-1/);
});

test('timeout usage remains unknown while reported usage remains inspectable', async (t) => {
  const { root, attempt } = await fixture(t);
  await write(root, 'attempts/timeout.json', { ...attempt, attempt_id: 'timeout', admission_id: null,
    status: 'timed_out', admitted_outputs: 0, saved_tokens: 0, usage: null, latency_ms: 60000 });
  const result = await auditRoot(root);
  assert.equal(result.optimizer_usage.input_tokens.total, null);
  assert.equal(result.optimizer_usage.input_tokens.known_sum, 100);
  assert.equal(result.optimizer_usage.input_tokens.unknown_records, 1);
  assert.equal(result.optimizer_latency_ms, 60010);
});

test('a changed source fails integrity and contributes no verified savings', async (t) => {
  const { root } = await fixture(t);
  await write(root, 'admissions/admission-1/items/source.json', { ...source, output: 'tampered' });
  const result = await auditRoot(root);
  assert.equal(result.receipts, 'INCOMPLETE');
  assert.equal(result.issues.source_hash_mismatch, 1);
  assert.equal(result.source_reduction.saved_tokens_estimate, 0);
});

test('missing or malformed linkage stays incomplete', async (t) => {
  const { root } = await fixture(t);
  await rm(join(root, 'admissions/admission-1/request.json'));
  await writeFile(join(root, 'admissions/admission-1/response.json'), '{broken');
  const result = await auditRoot(root);
  assert.equal(result.receipts, 'INCOMPLETE');
  assert.equal(result.cache_reuse, 'UNKNOWN');
});

test('duplicate attempts are counted once, cumulative usage is never summed', async (t) => {
  const { root, attempt } = await fixture(t);
  await write(root, 'attempts/duplicate.json', attempt);
  await write(root, 'attempts/cumulative.json', { ...attempt, attempt_id: 'cumulative',
    admission_id: null, status: 'unchanged', admitted_outputs: 0, saved_tokens: 0,
    usage: { total_token_usage: usage } });
  const result = await auditRoot(root);
  assert.equal(result.attempt_count, 2);
  assert.equal(result.optimizer_usage.input_tokens.known_sum, 100);
  assert.equal(result.optimizer_usage.input_tokens.total, null);
  assert.equal(result.issues.cumulative_usage_rejected, 1);
});

test('one response shared by two admissions contributes usage once', async (t) => {
  const { root, attempt } = await fixture(t);
  await mkdir(join(root, 'admissions/admission-2/items'), { recursive: true });
  for (const name of ['manifest.json', 'ace.json', 'request.json', 'response.json', 'items/source.json', 'items/admitted.json']) {
    const value = JSON.parse(await readFile(join(root, 'admissions/admission-1', name), 'utf8'));
    if (value.admission_id) value.admission_id = 'admission-2';
    await write(root, `admissions/admission-2/${name}`, value);
  }
  await write(root, 'attempts/attempt-2.json', { ...attempt, attempt_id: 'attempt-2', admission_id: 'admission-2' });
  const result = await auditRoot(root);
  assert.equal(result.linked_response_count, 1);
  assert.equal(result.linked_main_usage.input_tokens.total, 100);
});

test('an artifact reference outside its admission and a null receipt are incomplete', async (t) => {
  const { root, manifest } = await fixture(t);
  manifest.items[0].source_artifact = '../../attempts/attempt-1.json';
  await write(root, 'admissions/admission-1/manifest.json', manifest);
  await write(root, 'admissions/admission-1/request.json', null);
  const result = await auditRoot(root);
  assert.equal(result.receipts, 'INCOMPLETE');
  assert.equal(result.issues.source_missing_or_invalid, 1);
  assert.equal(result.issues.request_missing_or_invalid, 1);
});

test('CLI requires explicit input and never substitutes fixtures', () => {
  const result = spawnSync(process.execPath, [new URL('./report.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--root/);
});
