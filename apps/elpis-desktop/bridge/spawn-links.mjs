import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ID = /^[a-f0-9-]{36}$/i;

/** The engine's create_thread tool starts a chat for the agent that calls it but records no parent for it, so the
 * sidebar would list the new chat on its own. The desktop remembers which chat made which (child → maker), in one small
 * file beside its other records, and shows the chat under its maker like any agent the engine spawned itself. */
export class SpawnLinks {
  #file; #makers = new Map();
  constructor(file) {
    this.#file = file;
    try {
      for (const [child, maker] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) if (ID.test(child) && ID.test(maker)) this.#makers.set(child, maker);
    } catch { /* No record yet, or an unreadable one: chats are linked again as their makers are seen creating them. */ }
  }
  makerOf(child) { return this.#makers.get(child) ?? null; }
  madeBy(maker) { return [...this.#makers].filter(([, owner]) => owner === maker).map(([child]) => child); }
  /** Whether this is a link not seen before. */
  async record(child, maker) {
    if (!ID.test(child) || !ID.test(maker) || child === maker || this.#makers.get(child) === maker) return false;
    this.#makers.set(child, maker);
    await fs.promises.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.pending`;
    await fs.promises.writeFile(temporary, JSON.stringify(Object.fromEntries(this.#makers)), { mode: 0o600 });
    await fs.promises.rename(temporary, this.#file);
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
