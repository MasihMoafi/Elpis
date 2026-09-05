import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyLiveSmoke } from './verify-live-smoke.mjs';

const fact = 'PRIVATE_FACT_731';
const usage = { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10,
  reasoning_output_tokens: 2, total_tokens: 110 };
const write = (root, path, value) => writeFile(join(root, path), JSON.stringify(value, null, 2));
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cli = new URL('./verify-live-smoke.mjs', import.meta.url).pathname;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'elpis-live-verify-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trace = 'trace/recorded';
  const admission = 'state/logs/smart-prune/admissions/admission-1';
  for (const path of [`${trace}/payloads`, `${admission}/items`,
    'state/logs/smart-prune/attempts', 'workspace']) await mkdir(join(root, path), { recursive: true });
  const source = { type: 'custom_tool_call_output', call_id: 'call-1', output: [
    { type: 'input_text', text: 'PRIVATE_TOOL_ENVELOPE' },
    { type: 'input_text', text: `PRIVATE_NOISE\nAUDIT_CODE=${fact}` },
  ] };
  const content = `AUDIT_CODE=${fact}`;
  const admitted = { ...source, output: `${content}\n[ELPIS SMART PRUNE]\n` +
    `exact_source=smart-prune://admission-1/call-1\nsource_sha256=${sha(source)}` };
  const input = JSON.stringify({ items: [{ source_output: source, call_id: 'call-1' }] });
  const raw_response = JSON.stringify({ items: [{ call_id: 'call-1', decision: 'compact', content }] });
  const attempt = { schema_version: 1, attempt_id: 'attempt-1', admission_id: 'admission-1',
    session_id: 'thread-1', turn_id: 'turn-1', status: 'admitted', model: 'gpt-5.6-luna', reasoning_effort: 'low',
    candidate_outputs: 1, admitted_outputs: 1, saved_tokens: 1900, latency_ms: 5, input, raw_response, usage };
  await write(root, 'state/logs/smart-prune/attempts/attempt-1.json', attempt);
  await write(root, `${admission}/manifest.json`, { schema_version: 1, admission_id: 'admission-1',
    session_id: 'thread-1', turn_id: 'turn-1', ace_conversation: 'ace.json', source_tokens: 2000,
    admitted_tokens: 100, saved_tokens: 1900, items: [{ call_id: 'call-1', source_sha256: sha(source),
      source_artifact: 'items/source.json', admitted_artifact: 'items/admitted.json',
      source_tokens: 2000, admitted_tokens: 100, saved_tokens: 1900 }] });
  await write(root, `${admission}/ace.json`, { model: attempt.model, input, raw_response, usage });
  await write(root, `${admission}/items/source.json`, source);
  await write(root, `${admission}/items/admitted.json`, admitted);
  await write(root, `${admission}/request.json`, { schema_version: 1, admission_id: 'admission-1',
    request_sequence: 2, request_input_sha256: 'a'.repeat(64), input_representation: 'logical_response_items_before_transport' });
  await write(root, `${admission}/response.json`, { schema_version: 1, admission_id: 'admission-1', response_id: 'response-2', usage });
  await writeFile(join(root, 'workspace/fixture.cjs'), `process.stdout.write("Z".repeat(12000) + "\\nAUDIT_CODE=${fact}\\n");\n`);

  const first = { model: 'gpt-5.6-luna', reasoning: { effort: 'medium' }, prompt_cache_key: 'PRIVATE_CACHE_KEY',
    input: [{ type: 'additional_tools', tools: [] }, { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'Run node ./fixture.cjs and report the result.' }] }] };
  const firstResponse = { response_id: 'response-1', token_usage: usage,
    output_items: [{ type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: 'node ./fixture.cjs' }] };
  const followup = { ...first, type: 'response.create', previous_response_id: 'response-1',
    input: [{ ...admitted, internal_chat_message_metadata_passthrough: { PRIVATE_METADATA: true } }] };
  const finalResponse = { response_id: 'response-2', token_usage: usage,
    output_items: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: fact }] }] };
  for (const [name, value] of Object.entries({ first, firstResponse, followup, finalResponse,
    invocation: { tool_name: 'shell_command', payload: { arguments: JSON.stringify({ command: 'node ./fixture.cjs' }) } } })) {
    await write(root, `${trace}/payloads/${name}.json`, value);
  }
  const ref = (name) => ({ path: `payloads/${name}.json` });
  const events = [
    { type: 'codex_turn_started', thread_id: 'thread-1', codex_turn_id: 'turn-1' },
    { type: 'inference_started', inference_call_id: 'inference-1', model: first.model, provider_name: 'OpenAI', request_payload: ref('first') },
    { type: 'code_cell_started', runtime_cell_id: 'cell-1', model_visible_call_id: 'call-1' },
    { type: 'tool_call_started', tool_call_id: 'tool-1', invocation_payload: ref('invocation') },
    { type: 'tool_call_ended', tool_call_id: 'tool-1', status: 'completed' },
    { type: 'code_cell_ended', runtime_cell_id: 'cell-1', status: 'completed' },
    { type: 'inference_completed', inference_call_id: 'inference-1', response_id: 'response-1', response_payload: ref('firstResponse') },
    { type: 'inference_started', inference_call_id: 'inference-2', model: first.model, provider_name: 'OpenAI', request_payload: ref('followup') },
    { type: 'inference_completed', inference_call_id: 'inference-2', response_id: 'response-2', response_payload: ref('finalResponse') },
    { type: 'codex_turn_ended', status: 'completed' },
  ].map((payload, index) => ({ schema_version: 1, seq: index + 1, thread_id: 'thread-1', codex_turn_id: 'turn-1', payload }));
  await writeFile(join(root, `${trace}/trace.jsonl`), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  return { root, trace, admission, followup, admitted, first };
}

test('observed linkage and fact retention pass without causal or byte-prefix claims', async (t) => {
  const { root } = await fixture(t);
  const result = await verifyLiveSmoke(root);
  assert.equal(result.verification, 'PASS_OBSERVED_SMOKE_LINKAGE');
  assert.equal(result.main_inference_count, 2);
  assert.equal(result.shell_tool_call_count, 1);
  assert.equal(result.optimizer_attempt_count, 1);
  assert.equal(result.tool_only_fact_retained, true);
  assert.equal(result.cache_reuse, 'OBSERVED_REUSE');
  assert.equal(result.normalized_previous_request_items, 1);
  assert.equal(result.normalized_followup_items, 3);
  assert.equal(result.provider_cache_regression, 'NOT_TESTED');
  assert.equal(result.causal_cost_effect, 'NOT_TESTED');
  assert.equal(result.full_request_bytes, 'NOT_CHECKED_DELTA_REQUEST');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|thread-1|call-1|response-1/);
});

test('broken previous-response reference fails verification', async (t) => {
  const { root, trace, followup } = await fixture(t);
  await write(root, `${trace}/payloads/followup.json`, { ...followup, previous_response_id: 'wrong-response' });
  await assert.rejects(verifyLiveSmoke(root), /previous_response_mismatch/);
});

test('tampered admitted artifact fails instead of retaining a passing prose verdict', async (t) => {
  const { root, admission, admitted } = await fixture(t);
  await write(root, `${admission}/items/admitted.json`, { ...admitted, output: 'PRIVATE_TAMPERED' });
  await assert.rejects(verifyLiveSmoke(root), /admitted_decision_mismatch/);
});

test('changed transmitted delta fails even when receipt and model decision agree', async (t) => {
  const { root, trace, followup } = await fixture(t);
  followup.input[0].output = 'PRIVATE_TAMPERED_DELTA';
  await write(root, `${trace}/payloads/followup.json`, followup);
  await assert.rejects(verifyLiveSmoke(root), /admitted_delta_mismatch/);
});

test('fact leaked into the first request is not called tool-only evidence', async (t) => {
  const { root, trace, first } = await fixture(t);
  first.input.push({ type: 'message', role: 'user', content: [{ text: fact }] });
  await write(root, `${trace}/payloads/first.json`, first);
  await assert.rejects(verifyLiveSmoke(root), /fact_visible_before_tool/);
});

test('CLI requires explicit archive and returns a sanitized failure for malformed data', async (t) => {
  const missing = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--root/);
  const { root, trace } = await fixture(t);
  await writeFile(join(root, `${trace}/payloads/followup.json`), '{PRIVATE_BROKEN');
  const broken = spawnSync(process.execPath, [cli, '--root', root], { encoding: 'utf8' });
  assert.equal(broken.status, 1);
  assert.equal(JSON.parse(broken.stderr).reason, 'missing_or_malformed_evidence');
  assert.doesNotMatch(broken.stdout + broken.stderr, /PRIVATE_|elpis-live-verify-/);
});

test('out-of-scope payload paths are rejected before reading them', async (t) => {
  const { root, trace } = await fixture(t);
  const file = join(root, `${trace}/trace.jsonl`);
  const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  rows[1].payload.request_payload.path = '../../credentials.json';
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await assert.rejects(verifyLiveSmoke(root), /invalid_payload_reference/);
});
