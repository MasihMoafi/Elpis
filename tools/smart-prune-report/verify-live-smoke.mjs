// Offline verifier for the recorded single-tool, two-main-request Smart Prune smoke.
// This deliberately supports its Responses delta shape, not arbitrary agent runs.
import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { auditRoot } from './report.mjs';

class InvalidEvidence extends Error {}
const requireEvidence = (condition, code) => { if (!condition) throw new InvalidEvidence(code); };
const digest = (text) => createHash('sha256').update(text).digest('hex');
const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a, b) => canonical(a) === canonical(b);
const without = (value, key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const inside = (base, path) => {
  const name = relative(base, path);
  return !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`);
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0;

export async function verifyLiveSmoke(inputRoot) {
  requireEvidence(text(inputRoot), 'explicit_root_required');
  const root = await realpath(inputRoot);
  async function read(base, path) {
    requireEvidence(text(path) && !isAbsolute(path), 'invalid_artifact_path');
    const full = await realpath(resolve(base, path));
    requireEvidence(inside(base, full) && inside(root, full), 'artifact_outside_root');
    return readFile(full, 'utf8');
  }
  async function json(base, path) {
    const value = JSON.parse(await read(base, path));
    requireEvidence(object(value), 'invalid_json_object');
    return value;
  }
  async function onlyEntry(path, directory) {
    const folder = await realpath(resolve(root, path));
    requireEvidence(inside(root, folder), 'artifact_outside_root');
    const entries = (await readdir(folder, { withFileTypes: true }))
      .filter((entry) => directory ? entry.isDirectory() : entry.isFile() && entry.name.endsWith('.json'));
    requireEvidence(entries.length === 1, 'expected_one_artifact');
    return resolve(folder, entries[0].name);
  }
  const traceDir = await onlyEntry('trace', true);
  const traceText = await read(traceDir, 'trace.jsonl');
  const events = traceText.trim().split('\n').map((line) => JSON.parse(line));
  requireEvidence(events.length > 0 && events.every((event, index) =>
    event.schema_version === 1 && event.seq === index + 1 && object(event.payload)), 'invalid_trace_events');
  const select = (type) => events.filter((event) => event.payload.type === type);
  const one = (type) => {
    const found = select(type);
    requireEvidence(found.length === 1, `expected_one_${type}`);
    return found[0];
  };
  const starts = select('inference_started');
  const ends = select('inference_completed');
  requireEvidence(starts.length === 2 && ends.length === 2 &&
    !select('inference_failed').length && !select('inference_cancelled').length, 'main_inference_count');
  requireEvidence(new Set(starts.map((event) => event.payload.inference_call_id)).size === 2, 'duplicate_inference_id');
  requireEvidence(starts.every((event) => text(event.payload.inference_call_id)), 'missing_inference_id');
  const turn = one('codex_turn_started').payload;
  requireEvidence(text(turn.thread_id) && text(turn.codex_turn_id) &&
    one('codex_turn_ended').payload.status === 'completed', 'turn_incomplete');
  for (const event of [...starts, ...ends]) requireEvidence(event.thread_id === turn.thread_id &&
    event.codex_turn_id === turn.codex_turn_id, 'inference_turn_mismatch');
  const pairedEnds = starts.map((start) => {
    const matches = ends.filter((end) => end.payload.inference_call_id === start.payload.inference_call_id);
    requireEvidence(matches.length === 1 && matches[0].seq > start.seq, 'inference_pair_mismatch');
    return matches[0];
  });
  requireEvidence(pairedEnds[0].seq < starts[1].seq, 'inference_order_mismatch');
  async function payload(reference) {
    requireEvidence(object(reference) && /^payloads\/[A-Za-z0-9_.-]+\.json$/.test(reference.path), 'invalid_payload_reference');
    return json(traceDir, reference.path);
  }
  const [first, followup] = await Promise.all(starts.map((event) => payload(event.payload.request_payload)));
  const [firstResponse, finalResponse] = await Promise.all(pairedEnds.map((event) => payload(event.payload.response_payload)));
  requireEvidence(Array.isArray(first.input) && first.input.length > 0 &&
    Array.isArray(firstResponse.output_items) && Array.isArray(finalResponse.output_items), 'invalid_request_response_shape');
  requireEvidence(text(firstResponse.response_id) && followup.previous_response_id === firstResponse.response_id,
    'previous_response_mismatch');
  requireEvidence(pairedEnds.every((event, index) => event.payload.response_id ===
    [firstResponse, finalResponse][index].response_id), 'response_id_mismatch');
  requireEvidence(followup.type === 'response.create' && Array.isArray(followup.input) &&
    followup.input.length === 1 && followup.input[0]?.type === 'custom_tool_call_output', 'unsupported_delta_shape');
  const stableFields = ['model', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls',
    'reasoning', 'store', 'stream', 'include', 'prompt_cache_key', 'prompt_cache_options', 'text', 'service_tier'];
  requireEvidence(text(first.prompt_cache_key) && stableFields.every((field) => same(first[field], followup[field])),
    'main_request_options_changed');
  requireEvidence(first.model === 'gpt-5.6-luna' && first.reasoning?.effort === 'medium' &&
    starts.every((event) => event.payload.model === first.model && event.payload.provider_name === 'OpenAI'),
    'unexpected_smoke_model');

  const tool = one('tool_call_started');
  const toolEnd = one('tool_call_ended');
  const cell = one('code_cell_started');
  const cellEnd = one('code_cell_ended');
  requireEvidence(toolEnd.payload.tool_call_id === tool.payload.tool_call_id && toolEnd.payload.status === 'completed' &&
    cellEnd.payload.runtime_cell_id === cell.payload.runtime_cell_id && cellEnd.payload.status === 'completed' &&
    tool.seq < toolEnd.seq && toolEnd.seq <= cellEnd.seq && cellEnd.seq < starts[1].seq, 'tool_lifecycle_mismatch');
  const invocation = await payload(tool.payload.invocation_payload);
  requireEvidence(invocation.tool_name === 'shell_command' &&
    JSON.parse(invocation.payload?.arguments).command === 'node ./fixture.cjs', 'unexpected_tool_invocation');

  const auditDir = resolve(root, 'state/logs/smart-prune');
  const audit = await auditRoot(auditDir);
  requireEvidence(audit.receipts === 'COMPLETE' && audit.attempt_count === 1 && audit.admission_count === 1 &&
    audit.checked_item_count === 1 && audit.attempts_by_status.admitted === 1, 'receipt_audit_failed');
  const attemptPath = await onlyEntry('state/logs/smart-prune/attempts', false);
  const attempt = await json(root, relative(root, attemptPath));
  const admissionDir = await onlyEntry('state/logs/smart-prune/admissions', true);
  const manifest = await json(admissionDir, 'manifest.json');
  const item = manifest.items[0];
  requireEvidence(attempt.model === 'gpt-5.6-luna' && attempt.reasoning_effort === 'low' &&
    attempt.session_id === turn.thread_id && attempt.turn_id === turn.codex_turn_id &&
    attempt.candidate_outputs === 1 && attempt.admitted_outputs === 1, 'optimizer_identity_mismatch');
  for (const path of [item.source_artifact, item.admitted_artifact]) {
    requireEvidence(/^items\/[A-Za-z0-9_.-]+\.json$/.test(path), 'invalid_item_reference');
  }
  const source = await json(admissionDir, item.source_artifact);
  const admitted = await json(admissionDir, item.admitted_artifact);
  const optimizerInput = JSON.parse(attempt.input);
  requireEvidence(Array.isArray(optimizerInput.items) && optimizerInput.items.length === 1 &&
    same(optimizerInput.items[0].source_output, source), 'optimizer_source_mismatch');
  const ace = await json(admissionDir, 'ace.json');
  requireEvidence(ace.model === attempt.model && ace.input === attempt.input &&
    ace.raw_response === attempt.raw_response && same(ace.usage, attempt.usage), 'optimizer_receipt_mismatch');
  const decisions = JSON.parse(attempt.raw_response).items;
  requireEvidence(Array.isArray(decisions) && decisions.length === 1 && decisions[0].call_id === item.call_id &&
    decisions[0].decision === 'compact' && text(decisions[0].content), 'optimizer_decision_mismatch');
  const expectedBody = `${decisions[0].content.trim()}\n[ELPIS SMART PRUNE]\n` +
    `exact_source=smart-prune://${manifest.admission_id}/${item.call_id}\nsource_sha256=${item.source_sha256}`;
  requireEvidence(admitted.output === expectedBody, 'admitted_decision_mismatch');
  requireEvidence(same(without(source, 'output'), without(admitted, 'output')), 'admission_envelope_changed');
  // The runtime stamps this transport-only field after admission; existing semantic
  // assertions strip it too (core/tests/common/responses.rs::strip_metadata_from_json).
  const delta = without(followup.input[0], 'internal_chat_message_metadata_passthrough');
  requireEvidence(same(admitted, delta), 'admitted_delta_mismatch');
  const calls = firstResponse.output_items.filter((entry) => entry.type === 'custom_tool_call');
  requireEvidence(calls.length === 1 && calls[0].call_id === item.call_id &&
    cell.payload.model_visible_call_id === item.call_id, 'model_tool_call_mismatch');
  const requestLink = await json(admissionDir, 'request.json');
  const responseLink = await json(admissionDir, 'response.json');
  requireEvidence(requestLink.request_sequence === 2 &&
    requestLink.input_representation === 'logical_response_items_before_transport', 'request_linkage_mismatch');
  requireEvidence(responseLink.response_id === finalResponse.response_id &&
    same(responseLink.usage, finalResponse.token_usage), 'response_linkage_mismatch');

  const fixture = await read(root, 'workspace/fixture.cjs');
  const facts = [...fixture.matchAll(/AUDIT_CODE=([A-Za-z0-9_-]+)/g)];
  requireEvidence(facts.length === 1, 'fixture_fact_missing_or_ambiguous');
  const fact = facts[0][1];
  requireEvidence(!JSON.stringify(first).includes(fact) && !JSON.stringify(firstResponse).includes(fact),
    'fact_visible_before_tool');
  const answer = finalResponse.output_items.filter((entry) => entry.type === 'message' && entry.role === 'assistant')
    .flatMap((entry) => entry.content ?? []).map((part) => part.text ?? '').join('');
  const sourceText = typeof source.output === 'string' ? source.output :
    Array.isArray(source.output) && source.output.every((part) => part.type === 'input_text' && typeof part.text === 'string')
      ? source.output.map((part) => part.text).join('\n') : null;
  requireEvidence(sourceText !== null && sourceText.includes(fact) &&
    typeof admitted.output === 'string' && admitted.output.includes(fact) && answer.trim() === fact,
    'tool_fact_not_retained');

  // The reducer reconstructs a delta as prior request + prior response + new items
  // (rollout-trace/src/reducer/conversation.rs). This is semantic linkage evidence,
  // not an independently checked full wire prefix or provider-side cache execution.
  const normalizedPrefix = first.input.filter((entry) => entry.type !== 'additional_tools');
  return {
    schema_version: 1, verification: 'PASS_OBSERVED_SMOKE_LINKAGE',
    main_inference_count: starts.length, shell_tool_call_count: 1, code_cell_count: 1, optimizer_attempt_count: 1,
    main_model: first.model, main_effort: first.reasoning.effort, optimizer_model: attempt.model,
    optimizer_effort: attempt.reasoning_effort, optimizer_latency_ms: attempt.latency_ms,
    source_reduction: audit.source_reduction, optimizer_usage: audit.optimizer_usage,
    linked_main_usage: audit.linked_main_usage, cache_reuse: audit.cache_reuse,
    source_hash_matches_receipt: true, optimizer_source_matches_receipt: true,
    admitted_payload_matches_delta_without_transport_metadata: true, tool_only_fact_retained: true,
    normalized_logical_continuation: 'OBSERVED_PREVIOUS_RESPONSE_PLUS_NEW_OUTPUT',
    normalized_previous_request_items: normalizedPrefix.length,
    normalized_followup_items: normalizedPrefix.length + firstResponse.output_items.length + followup.input.length,
    stable_main_request_options: true, full_request_bytes: 'NOT_CHECKED_DELTA_REQUEST',
    logical_request_hash: 'PRESENT_NOT_INDEPENDENTLY_REPRODUCED',
    provider_cache_regression: 'NOT_TESTED', causal_cost_effect: 'NOT_TESTED',
    transport_retry_count: 'UNKNOWN',
    trace_sha256: digest(traceText), fixture_sha256: digest(fixture),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--root') {
    console.error('usage: node tools/smart-prune-report/verify-live-smoke.mjs --root EXPLICIT_SMOKE_ARCHIVE');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await verifyLiveSmoke(process.argv[3]), null, 2));
    } catch (error) {
      console.error(JSON.stringify({ verification: 'FAIL', reason: error instanceof InvalidEvidence
        ? error.message : 'missing_or_malformed_evidence' }));
      process.exitCode = 1;
    }
  }
}
