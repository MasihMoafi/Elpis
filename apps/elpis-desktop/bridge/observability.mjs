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

/** Only metrics are read from the rollout. Human content comes from the same normalised turns as chat.
 * Stop after the last requested turn, so opening a long chat never reads its later transcript. */
async function rolloutMetrics(file, lastId) {
  let input = fs.createReadStream(file);
  if (file.endsWith('.zst')) {
    if (typeof zlib.createZstdDecompress !== 'function') { input.destroy(); throw new Error('zstd unsupported'); }
    input = input.pipe(zlib.createZstdDecompress());
  }
  const turns = new Map(), shares = Object.fromEntries(SHARE_KEYS.map(key => [key, 0]));
  let current = null, reliable = true;
  try {
    for await (const text of readline.createInterface({ input, crlfDelay: Infinity })) {
      if (!/"(task_started|turn_context|token_count|response_item|session_meta|compacted|thread_rolled_back)"/.test(text)) continue;
      const line = json(text), payload = line?.payload, at = string(line?.timestamp);
      if (line?.type === 'session_meta') { shares.systemInstructions = Math.ceil((typeof payload?.base_instructions?.text === 'string' ? Buffer.byteLength(payload.base_instructions.text) : 0) / 4); continue; }
      if (line?.type === 'compacted' || (line?.type === 'event_msg' && payload?.type === 'thread_rolled_back')) { reliable = false; continue; }
      const started = line?.type === 'turn_context' || (line?.type === 'event_msg' && payload?.type === 'task_started') ? string(payload?.turn_id) : null;
      if (started) {
        if (current?.turnId === lastId && started !== lastId) break;
        current = turns.get(started);
        if (!current) { current = { turnId: started, at, contextTokens: null, window: null, outputTokens: null, requests: 0, ledger: null, model: null }; turns.set(started, current); }
        if (line.type === 'turn_context') current.model = string(payload.model) ?? current.model;
      } else if (line?.type === 'response_item' && payload) {
        const [key, size] = sizedItem(payload); shares[key] += Math.ceil(size / 4);
      } else if (current && line?.type === 'event_msg' && payload?.type === 'token_count' && payload.info) {
        const last = payload.info.last_token_usage, used = number(last?.total_tokens);
        if (used === null) continue;
        current.contextTokens = used; current.window = number(payload.info.model_context_window) || current.window; current.requests++;
        current.outputTokens = (current.outputTokens ?? 0) + (number(last.output_tokens) ?? 0);
        current.ledger = reliable ? contextLedger({ last: { totalTokens: used }, modelContextWindow: current.window }, { ...shares }) : null;
      }
    }
    return turns;
  } finally { input.destroy(); }
}

/** Accept only one value per supported parameter; native cursors remain opaque. */
function query(params, overview = false) {
  const values = {};
  for (const [key, value] of params) {
    if (!(overview ? ['limit', 'cursor'] : ['limit', 'cursor', 'agent']).includes(key) || key in values) throw new BridgeError('Unsupported query parameter');
    values[key] = value;
  }
  if (values.limit !== undefined && !(/^\d{1,3}$/.test(values.limit) && +values.limit >= 1 && +values.limit <= 100)) throw new BridgeError('Limit must be 1 through 100');
  if (values.cursor !== undefined && !(overview ? /^\d{1,9}$/ : /^[A-Za-z0-9_:=+.-]{1,2048}$/).test(values.cursor)) throw new BridgeError('Invalid cursor');
  if (values.agent !== undefined) threadId(values.agent);
  return { limit: values.limit ? +values.limit : 20, cursor: values.cursor ?? null, agent: values.agent ?? null };
}

/** Active chat identities come from the engine, never from old Prune records. All routes are read-only. */
export function createObservability({ home = elpisHome(), chatOf, listChats, turnsOf, graphsOf }) {
  const dir = path.join(home, 'logs', 'smart-prune'), attemptsDir = path.join(dir, 'attempts'), admissionsDir = path.join(dir, 'admissions');
  const attempts = new Map(), admissions = new Map(), rollouts = new Map();
  let scanning = null, listing = null;

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

  async function listActive() {
    const active = new Map(), cursors = new Set(); let cursor;
    do {
      const page = await listChats({ limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data)) throw new BridgeError('Active chats could not be read. Try again.', 502);
      for (const thread of page.data) if (UUID.test(thread?.id ?? '') && !thread.archived && !thread.path?.split(path.sep).includes('archived_sessions')) active.set(thread.id, thread);
      cursor = page.nextCursor;
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw new BridgeError('Active chat pages could not be read. Try again.', 502);
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return active;
  }
  const activeChats = () => listing ??= listActive().finally(() => { listing = null; });
  const shownChat = thread => Object.fromEntries(CHAT_FIELDS.filter(key => thread[key] !== undefined).map(key => [key, thread[key]]));
  const rootOf = (id, active) => {
    const seen = new Set([id]); let current = active.get(id);
    while (active.has(current?.parentThreadId) && !seen.has(current.parentThreadId)) { seen.add(current.parentThreadId); current = active.get(current.parentThreadId); }
    return current?.id ?? id;
  };
  const familyOf = (id, active) => [active.get(id), ...[...active.values()].filter(thread => thread.id !== id && rootOf(thread.id, active) === id)].filter(Boolean);
  /** The chat's readable Markdown record, which the engine writes beside the audit (one file per chat, named by date and chat
   * title; core smart_prune_log.rs). Found by the chat's id or title in a `.md` file's name; the newest if several. */
  async function recordOf(found, id) {
    const flat = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const title = flat(found.chat?.name || found.chat?.preview), key = flat(id);
    const names = (await fsp.readdir(dir).catch(() => [])).filter(name => name.endsWith('.md') && (flat(name).includes(key) || (title.length >= 3 && flat(name).includes(title))));
    const dated = await Promise.all(names.map(async name => ({ file: path.join(dir, name), at: (await fsp.stat(path.join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })));
    return dated.filter(entry => entry.at).sort((a, b) => b.at - a.at)[0]?.file ?? null;
  }
  async function metrics(file, lastId) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.jsonl(\.zst)?$/.test(file)) return new Map();
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_ROLLOUT_BYTES) return new Map();
    const key = `${stat.size}:${stat.mtimeMs}`, cached = rollouts.get(file);
    if (cached?.key === key && cached.turns.has(lastId)) return cached.turns;
    try {
      const read = await rolloutMetrics(file, lastId);
      if (rollouts.size >= 32) rollouts.delete(rollouts.keys().next().value);
      rollouts.set(file, { key, turns: read }); return read;
    } catch { return new Map(); }
  }

  return {
    async overview(params) {
      const { limit, cursor } = query(params, true);
      const [{ available, list, unreadable }, active] = await Promise.all([records(), activeChats()]);
      const visible = list.filter(attempt => active.has(attempt.session));
      const groups = [...active.values()].filter(thread => rootOf(thread.id, active) === thread.id).map(thread => {
        const own = visible.filter(attempt => rootOf(attempt.session, active) === thread.id);
        const lastAt = own.reduce((last, attempt) => time(attempt.at) > time(last) ? attempt.at : last, null);
        return { id: thread.id, found: true, chat: shownChat(thread), lastAt, totals: totals(own, admissions) };
      }).sort((a, b) => time(b.lastAt) - time(a.lastAt) || a.id.localeCompare(b.id));
      const start = Number(cursor ?? 0);
      const shownDir = dir.startsWith(`${os.homedir()}${path.sep}`) ? `~${dir.slice(os.homedir().length)}` : dir;
      return { available, records: shownDir, totals: totals(visible, admissions), skipped: { unreadable },
        chats: { data: groups.slice(start, start + limit), nextCursor: start + limit < groups.length ? String(start + limit) : null } };
    },
    async chat(id, params) {
      threadId(id);
      const { limit, cursor, agent } = query(params);
      const active = await activeChats();
      if (!active.has(id)) throw new BridgeError('This chat is no longer active.', 404);
      const family = familyOf(id, active), agentId = agent ?? id;
      if (!family.some(thread => thread.id === agentId)) throw new BridgeError('This agent is no longer in this chat.', 404);
      const [audit, found, page, graphs] = await Promise.all([records(), chatOf(agentId), turnsOf(agentId, { limit, ...(cursor ? { cursor } : {}) }), graphsOf(id).catch(() => ({ data: [] }))]);
      if (!found?.thread || found.thread.archived || found.path?.split(path.sep).includes('archived_sessions')) throw new BridgeError('This chat is no longer active.', 404);
      if (!Array.isArray(page?.data) || page.data.some(turn => typeof turn?.id !== 'string' || !Array.isArray(turn.items))) throw new BridgeError('Chat turns could not be read. Try again.', 502);
      const own = audit.list.filter(attempt => attempt.session === agentId), measured = page.data.length ? await metrics(found.path, page.data.at(-1).id) : new Map();
      const record = await recordOf({ chat: found.thread }, agentId);
      const tasks = (graphs?.data ?? []).flatMap(graph => graph.tasks ?? []);
      const agents = family.map(thread => ({ id: thread.id, name: thread.id === id ? 'Mother' : thread.agentNickname || thread.workflowTaskTitle || thread.name || `Agent · ${thread.id.slice(-8)}`,
        model: thread.model ?? null, role: tasks.find(task => task.assignedThreadId === thread.id)?.kind ?? thread.agentRole ?? null }));
      // Older thread/list replies omit model; a turn context or thread/read can still report it.
      const selected = agents.find(row => row.id === agentId);
      selected.model ??= found.thread.model ?? [...measured.values()].findLast(turn => turn.model)?.model ?? null;
      const data = page.data.map(turn => {
        const prunes = own.filter(attempt => attempt.turnId === turn.id);
        return { turnId: turn.id, status: turn.status, error: turn.error ?? null, items: turn.items, at: number(turn.startedAt) !== null ? new Date(turn.startedAt * 1000).toISOString() : null,
          contextTokens: null, window: null, outputTokens: null, requests: 0, ledger: null, ...measured.get(turn.id),
          saved: prunes.reduce((sum, attempt) => sum + attempt.saved, 0), prunes: prunes.map(attempt => detail(attempt, admissions)) };
      });
      return { id, found: true, chat: shownChat(active.get(id)), agentId, agents, record, totals: totals(own, admissions), turns: { available: true, data, nextCursor: page.nextCursor ?? null } };
    },
  };
}
