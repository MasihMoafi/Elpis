import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';

export type Runtime = 'elpis' | 'codex' | 'claude' | 'gemini';
export type SessionState = 'live' | 'idle' | 'closed' | 'unreachable';
export type Session = { runtime: Runtime; id: string; name: string | null; cwd: string | null; lastActivity: string | null; state: SessionState; evidence: string; subject: string | null };
export type SessionSettings = { runtimes: Runtime[]; idleMs: number };
export const defaultSessionSettings: SessionSettings = { runtimes: ['elpis', 'codex', 'claude', 'gemini'], idleMs: 10 * 60_000 };
export async function sessionSettings(home: string): Promise<SessionSettings> {
  try {
    const data: unknown = JSON.parse(await fs.readFile(path.join(home, 'matilda', 'settings.json'), 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid Matilda settings.');
    const value = data as Record<string, unknown>, allowed: Runtime[] = ['elpis', 'codex', 'claude', 'gemini'];
    if (value.runtimes !== undefined && (!Array.isArray(value.runtimes) || !value.runtimes.every(item => allowed.includes(item)))) throw Error('Invalid Matilda runtimes.');
    if (value.idleMs !== undefined && (typeof value.idleMs !== 'number' || !Number.isSafeInteger(value.idleMs) || value.idleMs < 0)) throw Error('Invalid Matilda idle time.');
    return { runtimes: (value.runtimes as Runtime[] | undefined) ?? defaultSessionSettings.runtimes, idleMs: (value.idleMs as number | undefined) ?? defaultSessionSettings.idleMs };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSessionSettings; throw error; }
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown): string | null => typeof v === 'string' && v.length ? v : null;
const parse = (s: string): Obj => { try { return obj(JSON.parse(s)); } catch { return {}; } };
async function entries(dir: string) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function paths(root: string, depth: number, match: RegExp): Promise<string[]> {
  const items = await entries(root), result: string[] = [];
  for (const item of items) {
    const file = path.join(root, item.name);
    if (depth && item.isDirectory()) result.push(...await paths(file, depth - 1, match));
    else if (!depth && item.isFile() && match.test(item.name)) result.push(file);
  }
  return result;
}
async function headAndTail(file: string): Promise<{ lines: Obj[]; headCount: number; modified: number }> {
  const f = await fs.open(file, 'r');
  try {
    const stat = await f.stat(), size = Math.min(stat.size, 256 * 1024), first = Buffer.alloc(size);
    await f.read(first, 0, size, 0);
    const tailSize = Math.min(stat.size - size, 64 * 1024), tail = Buffer.alloc(Math.max(0, tailSize));
    if (tail.length) await f.read(tail, 0, tail.length, stat.size - tail.length);
    const headLines = first.toString('utf8').split('\n'); if (size < stat.size) headLines.pop();
    const tailLines = tail.toString('utf8').split('\n'); if (tail.length) tailLines.shift();
    return { lines: [...headLines, ...tailLines].map(parse), headCount: headLines.length, modified: stat.mtimeMs };
  } finally { await f.close(); }
}
async function indexNames(file: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) { const data = parse(line), id = str(data.id), name = str(data.thread_name); if (id && name) names.set(id, name); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return names;
}
async function openRollouts(): Promise<{ files: Set<string>; complete: boolean }> {
  const files = new Set<string>(); let complete = true;
  let pids;
  try { pids = await fs.readdir('/proc'); } catch { return { files, complete: false }; }
  for (const pid of pids.filter(value => /^\d+$/.test(value))) {
    let fds: string[];
    try { fds = await fs.readdir(`/proc/${pid}/fd`); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) complete = false; continue; }
    for (const fd of fds) {
      try { const target = await fs.readlink(`/proc/${pid}/fd/${fd}`); if (target.includes('/rollout-') && target.endsWith('.jsonl')) files.add(target); }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) complete = false; }
    }
  }
  return { files, complete };
}
async function claudeProcesses(root: string): Promise<{ live: Set<string>; unknown: Set<string>; complete: boolean }> {
  const live = new Set<string>(), unknown = new Set<string>(); let complete = true;
  for (const entry of await entries(path.join(root, 'sessions'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const data = parse(await fs.readFile(path.join(root, 'sessions', entry.name), 'utf8')), id = str(data.sessionId), pid = data.pid;
      if (!id || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) { complete = false; continue; }
      try { process.kill(pid, 0); live.add(id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') unknown.add(id); }
    } catch { complete = false; }
  }
  return { live, unknown, complete };
}
export async function listSessions(options: { home: string; elpisHome: string; claudeHome: string; settings: SessionSettings }): Promise<Session[]> {
  const { home, elpisHome, claudeHome, settings } = options, rows: Session[] = [];
  const rollouts = settings.runtimes.some(r => r !== 'claude') ? await openRollouts() : { files: new Set<string>(), complete: true };
  const names = settings.runtimes.includes('elpis') ? await indexNames(path.join(elpisHome, 'session_index.jsonl')) : new Map<string, string>();
  const claude = settings.runtimes.includes('claude') ? await claudeProcesses(claudeHome) : { live: new Set<string>(), unknown: new Set<string>(), complete: true };
  for (const runtime of settings.runtimes) {
    if (runtime === 'gemini') continue; // ACP sessions are indexed by the bridge below, not Claude's transcript layout.
    const root = runtime === 'elpis' ? path.join(elpisHome, 'sessions') : runtime === 'codex' ? path.join(home, '.codex', 'sessions') : path.join(claudeHome, 'projects');
    const files = await paths(root, runtime === 'claude' ? 1 : 3, runtime === 'claude' ? /\.jsonl$/ : /^rollout-.*\.jsonl$/);
    for (const file of files) {
      const fallback = runtime === 'claude' ? path.basename(file, '.jsonl') : path.basename(file, '.jsonl').slice(-36);
      let data;
      try { data = await headAndTail(file); } catch { rows.push({ runtime, id: fallback, name: null, cwd: null, lastActivity: null, state: 'unreachable', evidence: 'Transcript cannot be read.', subject: null }); continue; }
      let id = fallback, cwd: string | null = null, kind = '', name: string | null = null, subject: string | null = null;
      for (const [index, line] of data.lines.entries()) {
        const payload = obj(line.payload), p = Object.keys(payload).length ? payload : line;
        if (runtime === 'claude') {
          cwd ??= str(line.cwd); kind ||= str(line.entrypoint) ?? ''; name = str(line.customTitle) ?? name;
          const content = obj(line.message).content;
          if (index < data.headCount && !subject && line.type === 'user' && typeof content === 'string' && !content.startsWith('<')) subject = content;
        } else {
          if (line.type === 'session_meta' || p.originator) { id = str(p.id) ?? id; cwd = str(p.cwd) ?? cwd; const source = p.source; kind = `${str(p.originator) ?? ''}${source ? `/${typeof source === 'string' ? source : 'subagent'}` : ''}`; }
          if (index < data.headCount && !subject && (p.type === 'user_message' || line.type === 'user_message')) { const message = p.message ?? line.message; if (typeof message === 'string' && !message.startsWith('<')) subject = message; }
        }
      }
      if (cwd === '/tmp' || cwd?.startsWith('/tmp/') || kind.includes('/subagent') || (runtime === 'claude' && !['cli', 'claude-desktop'].includes(kind)) || (runtime === 'codex' && /^(bb|codex_exec)/.test(kind)) || (runtime === 'elpis' && kind.startsWith('elpis-agents'))) continue;
      const held = runtime === 'claude' ? claude.live.has(id) : rollouts.files.has(file);
      const uncertain = runtime === 'claude' ? claude.unknown.has(id) || !claude.complete : !rollouts.complete;
      const state: SessionState = held ? Date.now() - data.modified > settings.idleMs ? 'idle' : 'live' : uncertain ? 'unreachable' : 'closed';
      rows.push({ runtime, id, name: runtime === 'elpis' ? names.get(id) ?? null : name, cwd, lastActivity: new Date(data.modified).toISOString(), state, evidence: held ? 'Process evidence and transcript modification time.' : uncertain ? 'Process evidence is incomplete.' : 'No live process evidence found.', subject: subject?.trim().slice(0, 240) || null });
    }
  }
  if (settings.runtimes.includes('gemini')) {
    let saved: Obj = {};
    try { saved = parse(await fs.readFile(path.join(elpisHome, 'elpis-claude', 'sessions.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const [id, raw] of Object.entries(saved)) {
      const entry = obj(raw);
      if (id.startsWith('_') || !(entry.agent === 'agy' || str(entry.model)?.startsWith('agy/'))) continue;
      const active = obj(entry.active), thread = obj(entry.thread), existing = rows.find(row => row.runtime === 'elpis' && row.id === id);
      const turns = Array.isArray(entry.turns) ? entry.turns : [], last = obj(turns.at(-1));
      const at = typeof active.startedAt === 'number' ? active.startedAt : typeof last.completedAt === 'number' ? last.completedAt : null;
      let state: SessionState = 'unreachable', evidence = 'Saved ACP session; live state needs the bridge.';
      if (typeof active.pid === 'number' && Number.isSafeInteger(active.pid) && active.pid > 0) {
        try { process.kill(active.pid, 0); state = at !== null && Date.now() - at * 1000 > settings.idleMs ? 'idle' : 'live'; evidence = 'ACP process evidence and turn timestamp.'; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { state = 'closed'; evidence = 'The recorded ACP process ended.'; } }
      }
      if (existing) rows.splice(rows.indexOf(existing), 1);
      rows.push({ runtime: 'gemini', id, name: existing?.name ?? str(thread.name), cwd: existing?.cwd ?? str(active.cwd) ?? str(thread.cwd),
        lastActivity: at !== null ? new Date(at * 1000).toISOString() : existing?.lastActivity ?? null, state, evidence, subject: existing?.subject ?? str(active.preview) });
    }
  }
  return rows.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
}
