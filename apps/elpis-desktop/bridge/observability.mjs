// The Observability page's data, read-only: what Smart Prune did, from the records the engine writes under
// <home>/logs/smart-prune (codex-rs/core/src/session/smart_prune_audit.rs), and each chat's context use over its
// turns, from the `token_count` events of its rollout. Nothing here writes, creates or deletes a file.
//
// attempts/<id>.json   one per pruner run: status, the candidate outputs (`input`, a JSON string), the pruner's
//                      decision manifest (`raw_response`, a JSON string), saved tokens, the pruner's own usage, and
//                      `admission_id` when shortened text was admitted.
// admissions/<id>/     manifest.json (each admitted output's source and admitted tokens), request.json (the main-model
//                      request that first carried them).
// Records are written once (write_json_new), so each is read once and kept; a half-written one is read again later.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { BridgeError, elpisHome, threadId } from './client.mjs';
import { contextLedger, sizedItem, SHARE_KEYS } from './elpis-features.mjs';

const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const OUTCOMES = ['compacted', 'unchanged', 'failed'];
const MAX_ROLLOUT_BYTES = 256 * 1024 * 1024;
// Only what a chat's title needs (lib/api.ts `title`); never its folder or record paths.
const CHAT_FIELDS = ['id', 'name', 'preview', 'workflowTaskTitle', 'source', 'parentThreadId', 'agentNickname', 'agentRole'];

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const string = value => typeof value === 'string' ? value : null;
const json = text => { if (typeof text !== 'string') return null; try { return JSON.parse(text); } catch { return null; } };
const outcomeOf = status => status === 'admitted' ? 'compacted' : status === 'unchanged' ? 'unchanged' : 'failed';
const time = value => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : 0; };
const missing = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
async function pool(items, size, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) await work(items[next++]); }));
}

/** An attempt record as the page needs it, or null when it is not a schema 1 attempt. Its text (instructions, input,
 * the pruner's answer) stays here; only call ids, tools, token estimates and decisions are kept. */
function summarize(record) {
  if (record?.schema_version !== 1 || ![record.attempt_id, record.session_id, record.status].every(value => typeof value === 'string')) return null;
  const decisions = json(record.raw_response)?.items, input = json(record.input)?.items;
  const decided = new Map((Array.isArray(decisions) ? decisions : []).filter(item => typeof item?.call_id === 'string')
    .map(item => [item.call_id, ['compact', 'unchanged'].includes(item.decision) ? item.decision : null]));
  const items = (Array.isArray(input) ? input : []).filter(item => typeof item?.call_id === 'string').map(item => ({
    callId: item.call_id, tool: string(item.invocation?.name), sourceTokens: number(item.source_tokens_estimate), decision: decided.get(item.call_id) ?? null }));
  return { id: record.attempt_id, session: record.session_id, turnId: string(record.turn_id), at: string(record.timestamp), status: record.status, outcome: outcomeOf(record.status),
    model: string(record.model), effort: string(record.reasoning_effort), candidates: number(record.candidate_outputs) ?? items.length, shortened: number(record.admitted_outputs) ?? 0,
    saved: number(record.saved_tokens) ?? 0, latencyMs: number(record.latency_ms), prunerTokens: number(record.usage?.total_tokens), error: string(record.error)?.slice(0, 2000) ?? null,
    admissionId: RECORD_ID.test(record.admission_id ?? '') ? record.admission_id : null, items };
}

function manifestOf(record, admissionId) {
  if (record?.schema_version !== 1 || record.admission_id !== admissionId || !Array.isArray(record.items)) return null;
  return { before: number(record.source_tokens) ?? 0, after: number(record.admitted_tokens) ?? 0, saved: number(record.saved_tokens) ?? 0,
    items: new Map(record.items.filter(item => typeof item?.call_id === 'string').map(item => [item.call_id, { admitted: number(item.admitted_tokens), saved: number(item.saved_tokens) }])) };
}

/** Counts and token sums over some attempts. `before`/`after` are the admitted outputs' manifest tokens; `unlinked`
 * counts compacted runs whose manifest could not be read, so their before and after are unknown. */
function totals(attempts, admissions) {
  const sum = { attempts: 0, compacted: 0, unchanged: 0, failed: 0, examined: 0, shortened: 0, before: 0, after: 0, saved: 0, unlinked: 0, prunerTokens: 0, prunerRuns: 0 };
  for (const attempt of attempts) {
    sum.attempts++; sum[attempt.outcome]++; sum.examined += attempt.candidates; sum.shortened += attempt.shortened; sum.saved += attempt.saved;
    if (attempt.prunerTokens !== null) { sum.prunerTokens += attempt.prunerTokens; sum.prunerRuns++; }
    if (attempt.outcome !== 'compacted') continue;
    const manifest = admissions.get(attempt.admissionId)?.manifest;
    if (manifest) { sum.before += manifest.before; sum.after += manifest.after; } else sum.unlinked++;
  }
  return sum;
}

/** One run for the page: each candidate output with the pruner's decision and, when admitted, its tokens. */
function detail(attempt, admissions) {
  const { session, admissionId, items, ...shown } = attempt;
  const admission = attempt.outcome === 'compacted' ? admissions.get(admissionId) : null, manifest = admission?.manifest ?? null;
  return { ...shown,
    items: items.map(item => { const admitted = manifest?.items.get(item.callId); return { ...item, admitted: !!admitted, admittedTokens: admitted?.admitted ?? null, saved: admitted?.saved ?? null }; }),
    admission: manifest ? { id: admissionId, before: manifest.before, after: manifest.after, saved: manifest.saved, requestSequence: admission.requestSequence } : null };
}

const MAX_STEPS = 400;
const CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call']);
const clip = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 120) : null;
/** What a tool call was, in a few words: its name and, when its arguments say so, the command, path or query. */
function callOf(payload) {
  const name = string(payload.name) ?? { local_shell_call: 'shell', web_search_call: 'web search', tool_search_call: 'tool search' }[payload.type] ?? payload.type;
  const args = json(payload.arguments);
  return { name, detail: clip(args?.cmd ?? args?.command ?? args?.path ?? args?.file_path ?? args?.query ?? args?.url) };
}

/** Each turn of a rollout in order: when it started, its steps (every model request with its tokens, every tool call),
 * its last measured request (the context it ended with) and the Ledger's categories for that context, estimated from the
 * saved items as `rolloutShares` does; `ledger` is null once a compaction or rollback makes the saved items unreliable. */
async function rolloutTurns(file) {
  let input = fs.createReadStream(file);
  if (file.endsWith('.zst')) {
    if (typeof zlib.createZstdDecompress !== 'function') { input.destroy(); throw new Error('zstd unsupported'); }
    input = input.pipe(zlib.createZstdDecompress());
  }
  const turns = [], byId = new Map(), shares = Object.fromEntries(SHARE_KEYS.map(key => [key, 0]));
  let current = null, reliable = true;
  const add = item => { const [key, size] = sizedItem(item); shares[key] += Math.ceil(size / 4); };
  const step = (at, value) => { if (!current) return; if (current.steps.length < MAX_STEPS) current.steps.push({ at, ...value }); else current.stepsMore++; };
  for await (const text of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (!/"(task_started|turn_context|token_count|response_item|session_meta|compacted|thread_rolled_back)"/.test(text)) continue;
    const line = json(text), payload = line?.payload, at = string(line?.timestamp);
    if (line?.type === 'session_meta') { shares.systemInstructions = Math.ceil((typeof payload?.base_instructions?.text === 'string' ? Buffer.byteLength(payload.base_instructions.text) : 0) / 4); continue; }
    if (line?.type === 'compacted') { reliable = false; continue; }
    if (line?.type === 'event_msg' && payload?.type === 'thread_rolled_back') { reliable = false; continue; }
    const started = line?.type === 'turn_context' || (line?.type === 'event_msg' && payload?.type === 'task_started') ? string(payload?.turn_id) : null;
    if (started) {
      current = byId.get(started);
      if (!current) { current = { turnId: started, at, contextTokens: null, window: null, requests: 0, steps: [], stepsMore: 0, ledger: null }; byId.set(started, current); turns.push(current); }
    } else if (line?.type === 'response_item' && payload) {
      add(payload);
      if (CALLS.has(payload.type)) step(at, { kind: 'tool', ...callOf(payload) });
    } else if (current && line?.type === 'event_msg' && payload?.type === 'token_count' && payload.info) {
      const last = payload.info.last_token_usage, used = number(last?.total_tokens);
      if (used === null) continue;
      const window = number(payload.info.model_context_window);
      current.contextTokens = used; current.window = window || current.window; current.requests++;
      step(at, { kind: 'model', input: number(last.input_tokens), cached: number(last.cached_input_tokens), output: number(last.output_tokens), context: used });
      current.ledger = reliable ? contextLedger({ last: { totalTokens: used }, modelContextWindow: current.window }, { ...shares }) : null;
    }
  }
  return turns;
}

/** Strict query parameters: each at most once, `limit` 1 through 100, a cursor of the given form. */
function query(params, { limit, cursor, status = false }) {
  const values = {};
  for (const [key, value] of params) {
    if (!['limit', 'cursor', ...(status ? ['status'] : [])].includes(key) || key in values) throw new BridgeError('Unsupported query parameter');
    values[key] = value;
  }
  if (values.limit !== undefined && !(/^\d{1,3}$/.test(values.limit) && +values.limit >= 1 && +values.limit <= 100)) throw new BridgeError('Limit must be 1 through 100');
  if (values.cursor !== undefined && !cursor.test(values.cursor)) throw new BridgeError('Invalid cursor');
  if (values.status !== undefined && !OUTCOMES.includes(values.status)) throw new BridgeError('Status must be compacted, unchanged or failed');
  return { limit: values.limit ? +values.limit : limit, cursor: values.cursor ?? null, status: values.status ?? null };
}

/** The Observability routes over `home` (the Elpis home the bridge's runtime uses). `chatOf(id)` asks Elpis for a chat:
 * `{ thread, path }`, or null when Elpis no longer has it; when it cannot be asked, the chat's name is unknown. */
export function createObservability({ home = elpisHome(), chatOf }) {
  const dir = path.join(home, 'logs', 'smart-prune'), attemptsDir = path.join(dir, 'attempts'), admissionsDir = path.join(dir, 'admissions');
  const attempts = new Map(), admissions = new Map(), rollouts = new Map();
  let scanning = null;

  async function readAdmission(id) {
    const known = admissions.get(id);
    if (known?.manifest && known.requestSequence !== null) return;
    const read = async name => json(await fsp.readFile(path.join(admissionsDir, id, name), 'utf8').catch(() => null));
    const manifest = known?.manifest ?? manifestOf(await read('manifest.json'), id);
    const request = await read('request.json');
    admissions.set(id, { manifest, requestSequence: request?.admission_id === id ? number(request.request_sequence) : null });
  }
  async function scan() {
    let names;
    try { names = (await fsp.readdir(attemptsDir)).filter(name => name.endsWith('.json')); }
    catch (error) { if (missing(error)) return { available: false, list: [], unreadable: 0, unlinkedAdmissions: 0 }; throw error; }
    const present = new Set(names);
    for (const name of attempts.keys()) if (!present.has(name)) attempts.delete(name);
    let unreadable = 0;
    await pool(names.filter(name => !attempts.has(name)), 32, async name => {
      const summary = summarize(json(await fsp.readFile(path.join(attemptsDir, name), 'utf8').catch(() => null)));
      if (summary) attempts.set(name, summary); else unreadable++;
    });
    const list = [...attempts.values()], linked = new Set(list.map(attempt => attempt.admissionId).filter(Boolean));
    await pool([...linked], 32, readAdmission);
    const folders = await fsp.readdir(admissionsDir).catch(error => { if (missing(error)) return []; throw error; });
    return { available: true, list, unreadable, unlinkedAdmissions: folders.filter(name => !name.startsWith('.') && !linked.has(name)).length };
  }
  // Requests that arrive together share one scan.
  const records = () => scanning ??= scan().finally(() => { scanning = null; });

  async function chat(id) {
    if (!UUID.test(id)) return { found: null, chat: null, path: null };
    try {
      const summary = await chatOf(id);
      if (!summary?.thread) return { found: false, chat: null, path: null };
      return { found: true, chat: Object.fromEntries(CHAT_FIELDS.filter(key => summary.thread[key] !== undefined).map(key => [key, summary.thread[key]])), path: summary.path ?? null };
    } catch { return { found: null, chat: null, path: null }; }
  }
  /** The chat's readable Markdown record, which the engine writes beside the audit (one file per chat, named by date and chat
   * title; core smart_prune_log.rs). Found by the chat's id or title in a `.md` file's name; the newest if several. */
  async function recordOf(found, id) {
    const flat = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const title = flat(found.chat?.name || found.chat?.preview), key = flat(id);
    const names = (await fsp.readdir(dir).catch(() => [])).filter(name => name.endsWith('.md') && (flat(name).includes(key) || (title.length >= 3 && flat(name).includes(title))));
    const dated = await Promise.all(names.map(async name => ({ file: path.join(dir, name), at: (await fsp.stat(path.join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })));
    return dated.filter(entry => entry.at).sort((a, b) => b.at - a.at)[0]?.file ?? null;
  }
  async function turns(found, file, list) {
    if (found.found !== true) return { available: false, reason: found.found === false ? 'chat-missing' : 'unknown' };
    if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.jsonl(\.zst)?$/.test(file)) return { available: false, reason: 'no-rollout' };
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) return { available: false, reason: 'no-rollout' };
    if (stat.size > MAX_ROLLOUT_BYTES) return { available: false, reason: 'too-large' };
    const key = `${stat.size}:${stat.mtimeMs}`;
    let read = rollouts.get(file);
    if (read?.key !== key) {
      try { read = { key, turns: await rolloutTurns(file) }; } catch { return { available: false, reason: 'unreadable' }; }
      rollouts.set(file, read);
    }
    const saved = new Map();
    for (const attempt of list) if (attempt.turnId) saved.set(attempt.turnId, (saved.get(attempt.turnId) ?? 0) + attempt.saved);
    return { available: true, data: read.turns.map(turn => ({ ...turn, saved: saved.get(turn.turnId) ?? 0 })) };
  }

  return {
    /** Every record's totals, and one page of chats with records, the most recently pruned first. */
    async overview(params) {
      const { limit, cursor } = query(params, { limit: 20, cursor: /^\d{1,6}$/ });
      const { available, list, unreadable, unlinkedAdmissions } = await records();
      const sessions = new Map();
      for (const attempt of list) { if (!sessions.has(attempt.session)) sessions.set(attempt.session, []); sessions.get(attempt.session).push(attempt); }
      const rows = [...sessions].map(([id, own]) => ({ id, own, lastAt: own.reduce((last, attempt) => time(attempt.at) > time(last) ? attempt.at : last, own[0].at) }))
        .sort((a, b) => time(b.lastAt) - time(a.lastAt) || (a.id < b.id ? -1 : 1));
      const start = cursor ? Number(cursor) : 0, page = rows.slice(start, start + limit);
      const data = await Promise.all(page.map(async ({ id, own, lastAt }) => { const { found, chat: shown } = await chat(id); return { id, found, chat: shown, lastAt, totals: totals(own, admissions) }; }));
      const shownDir = dir.startsWith(`${os.homedir()}${path.sep}`) ? `~${dir.slice(os.homedir().length)}` : dir;
      return { available, records: shownDir, totals: totals(list, admissions), skipped: { unreadable, unlinkedAdmissions },
        chats: { data, nextCursor: start + limit < rows.length ? String(start + limit) : null } };
    },
    /** One chat: its totals, its context over the turns, and a page of its runs, newest first (ids are UUIDv7). */
    async chat(id, params) {
      threadId(id);
      const { limit, cursor, status } = query(params, { limit: 25, cursor: RECORD_ID, status: true });
      const { list } = await records();
      const own = list.filter(attempt => attempt.session === id).sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
      const found = await chat(id);
      const matching = own.filter(attempt => (!status || attempt.outcome === status) && (!cursor || attempt.id < cursor));
      const page = matching.slice(0, limit);
      return { id, found: found.found, chat: found.chat, record: await recordOf(found, id), totals: totals(own, admissions), turns: await turns(found, found.path, own),
        attempts: { data: page.map(attempt => detail(attempt, admissions)), nextCursor: matching.length > limit ? page.at(-1).id : null } };
    },
  };
}
