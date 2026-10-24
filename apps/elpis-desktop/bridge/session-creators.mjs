import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { agentParentId } from '../lib/agent-runs.mjs';

const IDS = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const seconds = value => typeof value === 'number' ? (value > 1e12 ? value / 1000 : value) : Date.parse(value) / 1000;
// Rewritten rollouts can replace createdAt. Engine UUIDv7s retain the original creation millisecond.
const createdAt = thread => {
  const saved = seconds(thread.createdAt);
  const original = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(thread.id)
    ? Number.parseInt(thread.id.replaceAll('-', '').slice(0, 12), 16) / 1000 : saved;
  return Math.min(saved, original);
};
const readJson = async file => { try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return {}; } };

/** Index timestamped ID references once, then only appended bytes. No transcript content is retained or written.
 * The small desktop-owned index survives restarts, including negative lookups. */
export class SessionCreators {
  #file; #home; #appHome; #scans; #catalog = new Map(); #store = {}; #storeKey;
  constructor(file, { home = path.dirname(file), appHome = os.homedir() } = {}) {
    this.#file = file; this.#home = home; this.#appHome = appHome;
  }
  thread(id) { return this.#catalog.get(id); }
  async recover(listed, list, linked = new Set()) {
    const fresh = listed.some(thread => !this.#catalog.has(thread.id) && thread.threadSource !== 'user' && !agentParentId(thread) && Number.isFinite(seconds(thread.createdAt)));
    for (const thread of listed) this.#catalog.set(thread.id, thread);
    if (fresh) {
      const cursors = new Set(); let cursor;
      do {
        const page = await list(cursor);
        for (const thread of page.data) this.#catalog.set(thread.id, thread);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) break;
        cursors.add(cursor);
      } while (cursor);
    }
    const threads = [...this.#catalog.values()];
    const children = threads.filter(thread => !linked.has(thread.id) && thread.threadSource !== 'user' && !agentParentId(thread) && Number.isFinite(seconds(thread.createdAt)));
    if (!children.length) return [];
    this.#scans ??= (await readJson(this.#file)).scans ?? {};
    const parents = threads.filter(thread => thread.threadSource === 'user' && !agentParentId(thread));
    if (parents.some(thread => thread.model?.startsWith('claude/'))) {
      const file = path.join(this.#home, 'elpis-claude/sessions.json');
      const stat = await fs.promises.stat(file).catch(() => null), key = stat && `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (key !== this.#storeKey) { this.#store = key ? await readJson(file) : {}; this.#storeKey = key; }
    }
    const store = this.#store;
    const found = new Map(); let changed = false;
    for (const parent of parents) {
      const files = [parent.path];
      const saved = store[parent.id];
      if (saved?.session && /^(?:claude\/|claude$)/.test(saved.model ?? parent.model ?? '')) {
        const account = saved.claudeAccountId;
        const config = account && account !== 'default' ? path.join(this.#home, 'elpis-claude/claude-accounts', account)
          : process.env.CLAUDE_CONFIG_DIR ?? path.join(this.#appHome, '.claude');
        files.push(path.join(config, 'projects', (parent.cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-'), `${saved.session}.jsonl`));
      }
      for (const file of files.filter(file => typeof file === 'string' && path.isAbsolute(file))) {
        let scan;
        try {
          const stat = await fs.promises.stat(file);
          scan = this.#scans[file];
          if (!scan || scan.ino !== stat.ino || scan.offset > stat.size || scan.size === stat.size && scan.mtime !== stat.mtimeMs) {
            scan = { ino: stat.ino, offset: 0, refs: {} }; this.#scans[file] = scan;
          }
          if (scan.offset < stat.size && (scan.size !== stat.size || scan.mtime !== stat.mtimeMs)) {
            let tail = Buffer.alloc(0);
            for await (const chunk of fs.createReadStream(file, { start: scan.offset, end: stat.size - 1 })) {
              tail = Buffer.concat([tail, chunk]); let start = 0, end;
              while ((end = tail.indexOf(10, start)) !== -1) {
                const line = tail.subarray(start, end).toString('utf8');
                const ids = line.match(IDS);
                if (ids) try {
                  const record = JSON.parse(line), at = seconds(record.timestamp);
                  // Copied/compacted history has no creation-time timestamp of its own.
                  if (Number.isFinite(at) && !['session_meta', 'compacted'].includes(record.type)) for (const id of new Set(ids)) {
                    const times = scan.refs[id.toLowerCase()] ??= [];
                    if (times.at(-1) !== at) times.push(at);
                  }
                } catch { /* A partial or non-JSON line supplies no evidence. */ }
                scan.offset += end + 1 - start; start = end + 1;
              }
              tail = tail.subarray(start);
            }
            changed = true;
          }
          scan.size = stat.size; scan.mtime = stat.mtimeMs;
        } catch { continue; /* An unavailable transcript must never hide a chat. */ }
        for (const child of children) {
          const created = createdAt(child);
          if (child.id === parent.id || createdAt(parent) > created) continue;
          // Creation output can arrive a little after the engine creates a batch of chats.
          const at = scan.refs[child.id]?.find(at => at >= created - 5 && at <= created + 120);
          if (at === undefined) continue;
          const prior = found.get(child.id);
          if (!prior || at < prior.at) found.set(child.id, { child: child.id, maker: parent.id, at });
        }
      }
    }
    if (changed) {
      await fs.promises.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      const temporary = `${this.#file}.${randomUUID()}.pending`;
      await fs.promises.writeFile(temporary, JSON.stringify({ scans: this.#scans }), { mode: 0o600 });
      await fs.promises.rename(temporary, this.#file);
    }
    return [...found.values()];
  }
}
