import fs from 'node:fs/promises';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number };
type Metrics = { timingRecorded: boolean; stepStartTime: number | null; firstTokenTime: number | null; completedTime: number | null; usageProvided: boolean; outputTokens: number };
type Cell = { index: number; kind: string; text: string; timeSeconds: number | null; sourceSeq?: number | undefined; inputDetail?: string | undefined; outputDetail?: string | undefined; thinkingDetail?: string | undefined; systemPromptDetail?: string | undefined; opensTurn?: boolean | undefined; callId?: string | undefined; toolName?: string | undefined; startedAt?: number | undefined; result?: string | undefined; isError?: boolean | undefined; assistantMetrics?: Metrics | undefined; input?: number | undefined; cacheRead?: number | undefined; cacheWrite?: number | undefined; output?: number | undefined; think?: number | undefined };
type Group = { title: string; cells: Cell[]; description?: string };
type Turn = { turn: number | null; groups: Group[] };
type Document = { version: number; threadId: string; turns: Turn[]; requestNumbers: Record<string, unknown>[]; cwd?: string; provider?: string; model?: string; contextWindow?: number; truncated?: boolean };
type Payload = { id?: unknown; cwd?: unknown; model_provider?: unknown; base_instructions?: { text?: unknown } | null; model?: unknown; full?: boolean; state?: unknown; usage?: unknown; type?: string; started_at?: unknown; model_context_window?: unknown; time_to_first_token_ms?: unknown; info?: { last_token_usage?: unknown } | null; item?: { id?: unknown } | null; started_at_ms?: unknown; completed_at_ms?: unknown; role?: string; content?: unknown; summary?: unknown; name?: unknown; arguments?: unknown; input?: unknown; action?: unknown; call_id?: unknown; output?: unknown; tools?: unknown; message?: unknown };
type Row = { timestamp?: unknown; type?: string; payload?: Payload | null };

// Port of codex-rs/elpis-trajectory/src/projection.rs. Times and usage come from the rollout.
const CACHE_DROP_POINTS = 20;
const IDLE_REPORT_MS = 300_000;
const PRUNE_PREFIX = 'elpis.context-prune.v1:';
const USAGE_RECORD = '"type":"token_usage_record"';
const str = (value: unknown) => typeof value === 'string' ? value : undefined;
const integer = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) ? value : undefined;
const present = <T extends Record<string, unknown>>(entries: T): T => Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)) as T;
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted((value as Record<string, unknown>)[k])])) : value;
const json = (value: unknown): string => JSON.stringify(sorted(value)) as string;
const textOf = (parts: unknown) => Array.isArray(parts) ? (parts as unknown[]).map(p => str((p as { text?: unknown } | null)?.text)).filter(v => v !== undefined).join('\n') : '';
const summary = (text: string) => {
  const line = (text.split(/\r?\n/).find(s => s.trim()) ?? '').trim();
  const chars = Array.from(line);
  return chars.length > 160 ? `${chars.slice(0, 160).join('')}…` : line;
};
function timestamp(value: unknown) {
  if (typeof value !== 'string' || !value.endsWith('Z')) return undefined;
  const match = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)(?:\.(.*))?Z$/.exec(value);
  if (!match) return undefined;
  const [, y, m, d, h, min, s, fraction = '0'] = match;
  const ms = (fraction + '000').slice(0, 3);
  if (!/^\d{3}$/.test(ms)) return undefined;
  let year = Number(y); const month = Number(m);
  year -= month <= 2 ? 1 : 0;
  const era = Math.trunc((year >= 0 ? year : year - 399) / 400);
  const yoe = year - era * 400, mp = (month + 9) % 12;
  const doy = Math.trunc((153 * mp + 2) / 5) + Number(d) - 1;
  const days = era * 146097 + yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy - 719468;
  return ((days * 24 + Number(h)) * 60 + Number(min)) * 60000 + Number(s) * 1000 + Number(ms);
}
function engineUsage(value: unknown) {
  if (value == null || typeof value !== 'object' || !Object.hasOwn(value, 'input_tokens')) return undefined;
  const num = (key: string) => Math.max(integer((value as Record<string, unknown>)[key]) ?? 0, 0);
  const cacheRead = num('cached_input_tokens'), cacheWrite = num('cache_write_input_tokens');
  return { input: Math.max(num('input_tokens') - cacheRead - cacheWrite, 0), cacheRead, cacheWrite, output: num('output_tokens'), reasoning: num('reasoning_output_tokens') };
}
function outputFailed(output: string) {
  const start = output.trimStart();
  if (start.startsWith('Error') || start.startsWith('error:')) return true;
  try {
    const object = JSON.parse(start);
    if (object && typeof object === 'object' && !Array.isArray(object)) {
      if (object.success === false) return true;
      const code = integer(object.metadata?.exit_code ?? object.exit_code);
      if (code !== undefined) return code !== 0;
    }
  } catch { /* Not a JSON result. */ }
  const exit = start.split(/\r?\n/).find(line => line.startsWith('Exit code: '));
  const code = exit?.slice(11).trim();
  return code !== undefined && /^[+-]?\d+$/.test(code) && Number(code) !== 0;
}
const cell = (kind: string, text: string, extra: Partial<Cell> = {}): Cell => present({ index: 0, kind, text, timeSeconds: null, ...extra }) as Cell;
const injected = (text: string) => ['<environment_context>', '<user_instructions>', '# AGENTS.md instructions', '## Elpis Admitted Context', '<turn_aborted>', '<user_shell_command>', '<permissions instructions>', '<skill>'].some(marker => text.trimStart().startsWith(marker));

class Builder {
  doc: Document; usesUsage: boolean; turn: number; step: number; count: number;
  pendingText: string[]; pendingReasoning: string[]; pendingTools: Cell[]; pendingCalls: Map<string, Cell>; placedCalls: Map<string, Cell>;
  cumulative: Usage; changes: string[]; worldSeen: boolean; model?: string | undefined; pendingSeq?: number | undefined; systemPrompt?: [number, string] | undefined;
  turnStarted?: number | undefined; stepStarted?: number | undefined; ttft?: number | undefined; previousHit?: number | undefined; previousEnd?: number | undefined;
  constructor(usesUsage: boolean) {
    this.doc = { version: 1, threadId: '', turns: [], requestNumbers: [] };
    this.usesUsage = usesUsage;
    this.turn = 0; this.step = 0; this.count = 0;
    this.pendingText = []; this.pendingReasoning = []; this.pendingTools = [];
    this.pendingCalls = new Map(); this.placedCalls = new Map();
    this.cumulative = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    this.changes = []; this.worldSeen = false;
  }
  currentTurn() {
    if (this.doc.turns.at(-1)?.turn == null) this.doc.turns.push({ turn: ++this.turn, groups: [] });
    return this.doc.turns.at(-1)!;
  }
  messageGroup() {
    const turn = this.currentTurn();
    if (turn.groups.at(-1)?.title !== 'Message') turn.groups.push({ title: 'Message', cells: [] });
    return turn.groups.at(-1)!;
  }
  line(seq: number, row: Row) {
    const at = timestamp(row?.timestamp), p = row?.payload ?? {};
    switch (row?.type) {
      case 'session_meta':
        this.doc.threadId = str(p.id) ?? '';
        for (const [key, value] of [['cwd', p.cwd], ['provider', p.model_provider]] as const) {
          const normalized = str(value);
          if (normalized !== undefined) this.doc[key] = normalized; else delete this.doc[key];
        }
        if (str(p.base_instructions?.text) !== undefined) this.systemPrompt = [seq, str(p.base_instructions?.text)!];
        break;
      case 'turn_context': {
        const model = str(p.model);
        if (this.model !== undefined && model !== undefined && this.model !== model) this.changes.push(`model change: ${this.model} → ${model}`);
        if (model !== undefined) this.doc.model = this.model = model;
        break;
      }
      case 'world_state':
        if (this.worldSeen && p.full === false && p.state && typeof p.state === 'object' && !Array.isArray(p.state)) {
          for (const section of Object.keys(p.state).sort()) {
            const change = ({ agents_md: 'AGENTS.md changed', elpis_continuity: 'admitted context changed', collaboration_mode: 'collaboration mode changed' } as Record<string, string>)[section] ?? `${section} changed`;
            if (!this.changes.includes(change)) this.changes.push(change);
          }
        }
        this.worldSeen = true; break;
      case 'compacted': this.compaction(seq, p, at); break;
      case 'response_item': this.response(seq, p, at); break;
      case 'token_usage_record': {
        const usage = this.usesUsage && engineUsage(p.usage);
        if (usage) this.requestEnd(seq, usage, at);
        break;
      }
      case 'event_msg': this.event(seq, p, at); break;
    }
  }
  event(seq: number, p: Payload, at: number | undefined) {
    switch (p.type) {
      case 'task_started': {
        this.flush(at); this.doc.turns.push({ turn: ++this.turn, groups: [] }); this.step = 0;
        const start = integer(p.started_at);
        this.turnStarted = start === undefined ? at : start * 1000;
        this.stepStarted = this.turnStarted; this.ttft = undefined;
        const window = integer(p.model_context_window); if (window !== undefined) this.doc.contextWindow = window;
        if (this.turn === 1 && this.systemPrompt) {
          const [sourceSeq, prompt] = this.systemPrompt; this.systemPrompt = undefined;
          this.messageGroup().cells.push(cell('system', summary(prompt), { sourceSeq, systemPromptDetail: prompt }));
        }
        break;
      }
      case 'task_complete': case 'turn_aborted':
        const firstToken = integer(p.time_to_first_token_ms);
        if (firstToken !== undefined) {
          this.ttft = firstToken;
          const turn = this.doc.turns.findLast(t => t.turn === this.turn);
          const metrics = turn?.groups.find(g => g.title === 'Step 1')?.cells[0]?.assistantMetrics;
          if (metrics && this.turnStarted !== undefined) metrics.firstTokenTime = this.turnStarted + this.ttft;
        }
        if (p.type === 'turn_aborted') this.flush(at);
        break;
      case 'token_count': {
        const usage = !this.usesUsage && engineUsage(p.info?.last_token_usage);
        if (usage) this.requestEnd(seq, usage, at);
        break;
      }
      case 'item_completed': {
        const target = this.callCell(str(p.item?.id));
        const start = integer(p.started_at_ms), end = integer(p.completed_at_ms);
        if (target && start !== undefined && end !== undefined) { target.startedAt = start; target.timeSeconds = Math.max(end - start, 0) / 1000; }
        break;
      }
    }
  }
  callCell(id: string | undefined) { return id === undefined ? undefined : this.placedCalls.get(id) ?? this.pendingCalls.get(id); }
  response(seq: number, p: Payload, at: number | undefined) {
    const kind = p.type;
    if (kind === 'message') {
      const text = textOf(p.content);
      if (p.role === 'assistant') { this.pendingSeq ??= seq; this.pendingText.push(text); }
      else if (['user', 'developer', 'system'].includes(p.role as string)) {
        const isInjected = p.role !== 'user' || injected(text);
        const opens = !isInjected && !this.messageGroup().cells.some(c => c.kind === 'user');
        if (!isInjected && at !== undefined) this.stepStarted ??= at;
        this.messageGroup().cells.push(cell(isInjected ? 'context' : 'user', summary(text), { opensTurn: opens ? true : undefined, sourceSeq: seq, inputDetail: text, startedAt: at }));
      }
    } else if (kind === 'reasoning') {
      this.pendingSeq ??= seq; const text = textOf(p.summary); if (text) this.pendingReasoning.push(text);
    } else if (['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call', 'image_generation_call'].includes(kind as string)) {
      this.pendingSeq ??= seq;
      const name = str(p.name) ?? ({ local_shell_call: 'shell', web_search_call: 'web_search', tool_search_call: 'tool_search', image_generation_call: 'image_generation' } as Record<string, string>)[kind as string] ?? 'tool';
      const raw = Object.hasOwn(p, 'arguments') ? p.arguments : Object.hasOwn(p, 'input') ? p.input : p.action;
      const input = raw === undefined ? '' : str(raw) ?? json(raw);
      const id = str(Object.hasOwn(p, 'call_id') ? p.call_id : p.id);
      const tool = cell('tool', `${name} ${summary(input)}`.trimEnd(), { sourceSeq: seq, inputDetail: input, callId: id, toolName: name, startedAt: at });
      if (id !== undefined) this.pendingCalls.set(id, tool);
      this.pendingTools.push(tool);
    } else if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(kind as string)) {
      const raw = Object.hasOwn(p, 'output') ? p.output : p.tools;
      const output = raw === undefined ? '' : str(raw) ?? (raw && typeof raw === 'object' && !Array.isArray(raw) ? str((raw as Record<string, unknown>).body) ?? json(raw) : json(raw));
      const target = this.callCell(str(p.call_id));
      if (target) {
        if (target.timeSeconds === null && target.startedAt !== undefined && at !== undefined) target.timeSeconds = Math.max(at - target.startedAt, 0) / 1000;
        target.result = summary(output); target.outputDetail = output;
        if (outputFailed(output)) target.isError = true; else delete target.isError;
      }
      if (at !== undefined) this.stepStarted = at;
    }
  }
  requestEnd(seq: number, usage: Usage, at: number | undefined) {
    const step = ++this.step, title = `Step ${step}`, started = this.stepStarted, text = this.pendingText.join('\n\n'), calls = this.pendingTools.length;
    ++this.count;
    const firstToken = step === 1 && this.turnStarted !== undefined && this.ttft !== undefined ? this.turnStarted + this.ttft : null;
    const assistant = cell('message', text.trim() ? summary(text) : calls ? `${calls} tool call${calls === 1 ? '' : 's'}` : '(no visible output)', {
      sourceSeq: this.pendingSeq ?? seq, outputDetail: text || undefined, thinkingDetail: this.pendingReasoning.length ? this.pendingReasoning.join('\n\n') : undefined,
      assistantMetrics: { timingRecorded: started !== undefined && at !== undefined, stepStartTime: started ?? null, firstTokenTime: firstToken, completedTime: at ?? null, usageProvided: true, outputTokens: usage.output },
      timeSeconds: started !== undefined && at !== undefined ? Math.max(at - started, 0) / 1000 : null, startedAt: started,
      input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output, think: usage.reasoning,
    });
    this.pendingText = []; this.pendingReasoning = []; this.pendingSeq = undefined;
    const tools = this.pendingTools; this.pendingTools = []; this.pendingCalls.clear();
    const turn = this.currentTurn();
    for (const tool of tools) if (tool.callId !== undefined) this.placedCalls.set(tool.callId, tool);
    turn.groups.push({ title, cells: [assistant, ...tools] });
    for (const key of Object.keys(this.cumulative) as (keyof Usage)[]) this.cumulative[key] += usage[key];
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    const hit = prompt > 0 ? Math.round(usage.cacheRead * 100 / prompt) : undefined;
    let cause;
    if (this.previousHit !== undefined && hit !== undefined && hit + CACHE_DROP_POINTS < this.previousHit) {
      const causes = [...this.changes];
      if (this.previousEnd !== undefined && started !== undefined && started - this.previousEnd >= IDLE_REPORT_MS) causes.push(`idle ${Math.trunc((started - this.previousEnd) / 60000)} min since the previous request`);
      cause = causes.length ? causes.join('; ') : 'cause not recorded';
    }
    this.changes = [];
    this.doc.requestNumbers.push(present({ group: title, number: this.count, purpose: 'assistant', seq, turn: this.turn, step, status: 'complete', startedAt: started, completedAt: at ?? null, provider: this.doc.provider, model: this.model, usage, cumulativeUsage: { ...this.cumulative }, cache: hit === undefined ? undefined : present({ hitPercent: hit, cause }) }));
    if (hit !== undefined) this.previousHit = hit;
    this.previousEnd = at ?? this.previousEnd; this.stepStarted = at;
  }
  flush(at: number | undefined) {
    if (!this.pendingText.length && !this.pendingTools.length && !this.pendingReasoning.length) return;
    const title = `Step ${++this.step}`; ++this.count;
    const text = this.pendingText.join('\n\n');
    const assistant = cell('message', text.trim() ? summary(text) : '(interrupted)', { sourceSeq: this.pendingSeq, outputDetail: text || undefined, isError: true, startedAt: this.stepStarted });
    const tools = this.pendingTools; this.pendingTools = []; this.pendingText = []; this.pendingReasoning = []; this.pendingCalls.clear(); this.pendingSeq = undefined;
    this.currentTurn().groups.push({ title, cells: [assistant, ...tools] });
    this.doc.requestNumbers.push(present({ group: title, number: this.count, purpose: 'assistant', turn: this.turn, step: this.step, status: at !== undefined ? 'error' : 'running', startedAt: this.stepStarted, completedAt: null, provider: this.doc.provider, model: this.model }));
  }
  compaction(seq: number, p: Payload, at: number | undefined) {
    this.flush(at);
    let text = str(p.message) ?? ''; const prune = text.startsWith(PRUNE_PREFIX);
    if (prune) text = text.slice(PRUNE_PREFIX.length).trimStart();
    this.doc.turns.push({ turn: null, groups: [{ title: `${prune ? 'Smart Prune' : 'Compaction'} ${seq}`, cells: [cell('compacted', prune ? 'Smart Prune checkpoint' : text ? summary(text) : 'History compacted', { sourceSeq: seq, outputDetail: text || undefined, startedAt: at })] }] });
    this.changes.push(prune ? 'Smart Prune' : 'compaction');
  }
  finish() {
    this.flush(undefined); let index = 0;
    for (const turn of this.doc.turns) for (const group of turn.groups) {
      let first, last;
      for (const c of group.cells) {
        c.index = ++index;
        if (c.startedAt !== undefined) { first = Math.min(first ?? c.startedAt, c.startedAt); last = Math.max(last ?? -Infinity, c.startedAt + Math.trunc((c.timeSeconds ?? 0) * 1000)); }
      }
      if (group.title !== 'Message' && first !== undefined) group.description = `${String(Math.max(last! - first, 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ms`;
    }
    return this.doc;
  }
}

export function project(text: string) {
  const builder = new Builder(text.includes(USAGE_RECORD));
  // As in Rust: a line that is not JSON ends the projection there, marked truncated.
  for (const [seq, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { builder.doc.truncated = true; break; }
    builder.line(seq, row as Row);
  }
  return builder.finish();
}

/** Project a stable file prefix without keeping the rollout string or its split lines.
 * Usage format is detected in a bounded first pass so mixed older logs keep their accounting. */
export async function projectFile(file: string) {
  const handle = await fs.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    if (!size) return project('');
    const input = () => {
      // Each pass has its own cursor. Destroying an iterator must not close the
      // shared descriptor or switch to a replacement file between the passes.
      const source = Readable.from((async function* () {
        for (let offset = 0; offset < size;) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset));
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          yield chunk.subarray(0, bytesRead);
        }
      })(), { objectMode: false });
      if (!file.endsWith('.zst')) return source;
      const decoded = source.pipe(zlib.createZstdDecompress());
      source.on('error', error => decoded.destroy(error));
      decoded.once('close', () => source.destroy());
      return decoded;
    };
    let usesUsage = false, suffix = '';
    const detection = input();
    try {
      for await (const raw of detection) {
        const text = suffix + (Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
        if (text.includes(USAGE_RECORD)) { usesUsage = true; break; }
        suffix = text.slice(-(USAGE_RECORD.length - 1));
      }
    } finally { detection.destroy(); }
    const builder = new Builder(usesUsage), stream = input();
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let seq = 0;
    try {
      for await (const line of lines) {
        const index = seq++;
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { builder.doc.truncated = true; break; }
        builder.line(index, row as Row);
      }
    } finally { lines.close(); stream.destroy(); }
    return builder.finish();
  } finally { await handle.close(); }
}
