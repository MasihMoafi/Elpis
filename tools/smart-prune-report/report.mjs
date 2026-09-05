import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const statuses = new Set(['admitted', 'unchanged', 'timed_out', 'model_error',
  'malformed_response', 'source_error', 'audit_error', 'cancelled']);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const id = (value) => typeof value === 'string' && value.length > 0;
const hash = (value) => createHash('sha256').update(value).digest('hex');
// Rust hashes compact serialization. Strip only JSON whitespace, preserving its
// field order, number representation, and string escapes from the receipt file.
const compact = (text) => text.replace(/"(?:\\.|[^"\\])*"|\s+/g, (part) => part.startsWith('"') ? part : '');

function summarizeUsage(records) {
  return Object.fromEntries(fields.map((field) => {
    const known = records.map((record) => record?.[field]).filter(count);
    const known_sum = known.reduce((sum, value) => sum + value, 0);
    return [field, { known_sum, unknown_records: records.length - known.length,
      total: records.length > 0 && known.length === records.length ? known_sum : null }];
  }));
}

export async function auditRoot(inputRoot) {
  if (!id(inputRoot)) throw new Error('explicit --root is required');
  const root = await realpath(inputRoot);
  const issues = {};
  const issue = (code) => { issues[code] = (issues[code] ?? 0) + 1; };
  const contained = (base, path) => {
    const rel = relative(base, path);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  };
  async function read(base, path, kind) {
    try {
      if (!id(path) || isAbsolute(path)) throw new Error('invalid path');
      const full = await realpath(resolve(base, path));
      if (!contained(base, full) || !contained(root, full)) throw new Error('escaped path');
      const text = await readFile(full, 'utf8');
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid receipt');
      return { value, text };
    } catch {
      issue(`${kind}_missing_or_invalid`);
      return null;
    }
  }
  async function list(folder, directories) {
    try {
      const full = await realpath(resolve(root, folder));
      if (!contained(root, full)) throw new Error('escaped directory');
      return (await readdir(full, { withFileTypes: true }))
        .filter((entry) => !entry.name.startsWith('.') && (directories
          ? entry.isDirectory() : entry.isFile() && entry.name.endsWith('.json')))
        .map((entry) => entry.name).sort();
    } catch (error) {
      if (error.code !== 'ENOENT') issue(`${folder}_unreadable`);
      return [];
    }
  }
  function usage(value) {
    if (value?.total_token_usage || value?.last_token_usage) {
      issue('cumulative_usage_rejected');
      return null;
    }
    if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
      issue('usage_invalid');
      return null;
    }
    return value ?? null;
  }

  const attempts = new Map();
  const attemptUsage = [];
  const byStatus = {};
  let optimizerLatency = 0;
  for (const name of await list('attempts', false)) {
    const receipt = await read(root, `attempts/${name}`, 'attempt');
    const a = receipt?.value;
    if (!a) continue;
    if (a.schema_version !== 1 || !id(a.attempt_id) || !id(a.session_id) || !id(a.turn_id) || !statuses.has(a.status)
      || !count(a.latency_ms) || !count(a.candidate_outputs) || !count(a.admitted_outputs)
      || !count(a.saved_tokens)) { issue('attempt_schema_invalid'); continue; }
    if (attempts.has(a.attempt_id)) {
      if (JSON.stringify(attempts.get(a.attempt_id)) !== JSON.stringify(a)) issue('conflicting_attempt_receipts');
      continue;
    }
    attempts.set(a.attempt_id, a);
    byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    optimizerLatency += a.latency_ms;
    attemptUsage.push(usage(a.usage));
  }

  const admissions = new Set();
  const responses = new Map();
  const responseUsage = [];
  const reduction = { source_tokens_estimate: 0, admitted_tokens_estimate: 0, saved_tokens_estimate: 0 };
  let checkedItems = 0;
  let admittedHashesMissing = 0;
  for (const name of await list('admissions', true)) {
    const folder = resolve(root, 'admissions', name);
    const m = (await read(folder, 'manifest.json', 'manifest'))?.value;
    if (!m) continue;
    if (m.schema_version !== 1 || m.admission_id !== name || !id(m.session_id) || !id(m.turn_id) || !Array.isArray(m.items)
      || !m.items.length || ![m.source_tokens, m.admitted_tokens, m.saved_tokens].every(count)) {
      issue('manifest_schema_invalid'); continue;
    }
    admissions.add(name);
    let valid = Boolean(await read(folder, m.ace_conversation, 'optimizer_conversation'));
    const sums = { source_tokens: 0, admitted_tokens: 0, saved_tokens: 0 };
    for (const item of m.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        issue('item_receipt_inconsistent'); valid = false; continue;
      }
      const source = await read(folder, item.source_artifact, 'source');
      const admitted = await read(folder, item.admitted_artifact, 'admitted');
      if (!source || !admitted) { valid = false; continue; }
      if (hash(compact(source.text)) !== item.source_sha256) {
        issue('source_hash_mismatch'); valid = false;
      }
      if (item.admitted_sha256) {
        if (hash(compact(admitted.text)) !== item.admitted_sha256) {
          issue('admitted_hash_mismatch'); valid = false;
        }
      } else admittedHashesMissing += 1;
      if (!id(item.call_id) || source.value?.call_id !== item.call_id || admitted.value?.call_id !== item.call_id
        || ![item.source_tokens, item.admitted_tokens, item.saved_tokens].every(count)
        || item.source_tokens - item.admitted_tokens !== item.saved_tokens) {
        issue('item_receipt_inconsistent'); valid = false; continue;
      }
      for (const key of Object.keys(sums)) sums[key] += item[key];
      checkedItems += 1;
    }
    if (Object.keys(sums).some((key) => sums[key] !== m[key])) {
      issue('manifest_totals_inconsistent'); valid = false;
    }
    if (valid) for (const key of Object.keys(sums)) reduction[`${key}_estimate`] += sums[key];

    const linkedAttempts = [...attempts.values()].filter((a) => a.admission_id === name);
    if (!linkedAttempts.length) issue('admission_without_attempt_receipt');
    if (linkedAttempts.some((a) => a.session_id !== m.session_id || a.turn_id !== m.turn_id
      || a.status !== 'admitted' || a.saved_tokens !== m.saved_tokens || a.admitted_outputs !== m.items.length)) {
      issue('attempt_admission_mismatch');
    }
    const request = (await read(folder, 'request.json', 'request'))?.value;
    if (request && (request.schema_version !== 1 || request.admission_id !== name
      || !count(request.request_sequence) || !/^[a-f0-9]{64}$/.test(request.request_input_sha256))) {
      issue('request_linkage_invalid');
    }
    const response = (await read(folder, 'response.json', 'response'))?.value;
    if (response) {
      if (response.schema_version !== 1 || response.admission_id !== name || !id(response.response_id)) {
        issue('response_linkage_invalid'); continue;
      }
      const key = `${m.session_id}:${response.response_id}`;
      if (responses.has(key)) {
        if (JSON.stringify(responses.get(key)) !== JSON.stringify(response.usage)) issue('conflicting_response_usage');
      } else {
        responses.set(key, response.usage);
        responseUsage.push(usage(response.usage));
      }
    }
  }
  for (const a of attempts.values()) {
    if (a.status === 'admitted' && !admissions.has(a.admission_id)) issue('missing_admission_receipt');
  }
  if (!attempts.size && !admissions.size) issue('no_receipts');
  const mainUsage = summarizeUsage(responseUsage);
  const cached = mainUsage.cached_input_tokens;
  return {
    schema_version: 1, evidence: 'EXPLICIT_LOCAL_RECEIPTS',
    receipts: Object.keys(issues).length ? 'INCOMPLETE' : 'COMPLETE', issues,
    attempt_count: attempts.size, attempts_by_status: byStatus,
    admission_count: admissions.size, checked_item_count: checkedItems,
    source_reduction: reduction,
    optimizer_latency_ms: optimizerLatency,
    optimizer_usage: summarizeUsage(attemptUsage),
    linked_response_count: responses.size, linked_main_usage: mainUsage,
    admitted_body_integrity: !checkedItems ? 'NOT_CHECKED'
      : admittedHashesMissing ? 'UNVERIFIABLE_NO_RECORDED_HASH' : 'RECORDED_HASHES_CHECKED',
    cache_reuse: cached.known_sum > 0 ? 'OBSERVED_REUSE'
      : cached.total === 0 ? 'NO_REUSE_OBSERVED' : 'UNKNOWN',
    cache_prefix_preservation: 'NOT_TESTED', causal_cost_effect: 'NOT_TESTED',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--root') {
    console.error('usage: node tools/smart-prune-report/report.mjs --root SMART_PRUNE_DIRECTORY');
    process.exitCode = 2;
  } else {
    try {
      const report = await auditRoot(process.argv[3]);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.receipts === 'COMPLETE' ? 0 : 1;
    } catch {
      console.error('Cannot read the explicit Smart Prune root; no evidence substituted.');
      process.exitCode = 2;
    }
  }
}
