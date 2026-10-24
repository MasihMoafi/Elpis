import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionCreators } from './session-creators.mjs';
import { agentParentId } from '../lib/agent-runs.mjs';

const ID = /^[a-f0-9-]{36}$/i;

/** The engine's create_thread tool starts a chat for the agent that calls it but records no parent for it, so the
 * sidebar would list the new chat on its own. The desktop remembers which chat made which (child → maker), in one small
 * file beside its other records, and shows the chat under its maker like any agent the engine spawned itself. */
export class SpawnLinks {
  #file; #makers = new Map(); #parents = new Map(); #history; #queue = Promise.resolve(); #writes = Promise.resolve();
  constructor(file, options) {
    this.#file = file;
    this.#history = new SessionCreators(`${file}.history`, options);
    try {
      for (const [child, maker] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) if (this.#canLink(child, maker)) this.#makers.set(child, maker);
    } catch { /* No record yet, or an unreadable one: chats are linked again as their makers are seen creating them. */ }
  }
  makerOf(child) { const maker = this.#makers.get(child); return maker && this.#canLink(child, maker) ? maker : null; }
  madeBy(maker) { return [...this.#makers.keys()].filter(child => this.makerOf(child) === maker); }
  #canLink(child, maker) {
    if (!ID.test(child) || !ID.test(maker)) return false;
    const seen = new Set([child]);
    for (let id = maker; id; id = this.#parents.get(id) ?? this.#makers.get(id)) {
      if (seen.has(id)) return false;
      seen.add(id);
    }
    return true;
  }
  recover(threads, list) {
    const work = async () => {
      for (const thread of threads) {
        const parent = agentParentId(thread);
        if (parent) this.#parents.set(thread.id, parent); else this.#parents.delete(thread.id);
      }
      const unlinked = threads.filter(thread => !this.makerOf(thread.id));
      if (!unlinked.length) return;
      for (const { child, maker } of await this.#history.recover(unlinked, list, new Set(this.#makers.keys()))) if (!this.makerOf(child)) await this.record(child, maker);
    };
    this.#queue = this.#queue.catch(() => {}).then(work); return this.#queue;
  }
  thread(id) { return this.#history.thread(id); }
  /** Whether this is a link not seen before. */
  async record(child, maker) {
    if (!this.#canLink(child, maker) || this.#makers.get(child) === maker) return false;
    this.#makers.set(child, maker);
    this.#writes = this.#writes.catch(() => {}).then(async () => {
      await fs.promises.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      const temporary = `${this.#file}.${randomUUID()}.pending`;
      await fs.promises.writeFile(temporary, JSON.stringify(Object.fromEntries(this.#makers)), { mode: 0o600 });
      await fs.promises.rename(temporary, this.#file);
    });
    await this.#writes;
    return true;
  }
}

/** The chat a finished create_thread call started, or null for any other item. */
export function createdThread(item) {
  if (item?.type !== 'mcpToolCall' || item.server !== 'codex_tui' || item.tool !== 'create_thread' || item.status !== 'completed') return null;
  for (const part of item.result?.content ?? []) {
    try { const id = JSON.parse(part?.text)?.threadId; if (typeof id === 'string') return id; } catch { /* Not the call's JSON answer. */ }
  }
  return null;
}
