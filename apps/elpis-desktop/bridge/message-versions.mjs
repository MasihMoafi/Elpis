import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** ChatGPT's ‹ 1/2 › on an edited message. Editing keeps the chat as it was in an archived copy (a native fork), so every
 * version of a message is a chat: `groups` lists them oldest first as { threadId, turnId }. `listed` holds chats the
 * engine does not list by itself (a fork has no first message of its own until its next turn). */
export class MessageVersions {
  constructor(file) { this.file = file; this.queue = Promise.resolve(); }
  async read() {
    const state = await fs.readFile(this.file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return { groups: Array.isArray(state?.groups) ? state.groups : [], listed: Array.isArray(state?.listed) ? state.listed : [] };
  }
  update(change) {
    const run = this.queue.then(async () => {
      const state = await this.read(); const result = change(state);
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await fs.rename(temporary, this.file);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
  /** `threadId`'s turn `turnId` was replaced by `newTurnId`; `copyId` now holds the turns `moved` from it (that turn on). */
  record(threadId, turnId, copyId, newTurnId, moved) {
    const movedIds = new Set(moved);
    return this.update(state => {
      for (const group of state.groups) for (const version of group) if (version.threadId === threadId && movedIds.has(version.turnId)) version.threadId = copyId;
      let group = state.groups.find(versions => versions.some(version => version.threadId === copyId && version.turnId === turnId));
      if (!group) { group = [{ threadId: copyId, turnId }]; state.groups.push(group); }
      if (newTurnId) group.push({ threadId, turnId: newTurnId });
    });
  }
  /** The versions shown under this chat's messages: [{ turnId, index, count, previous, next }]. */
  async of(threadId) {
    const { groups } = await this.read();
    return groups.flatMap(group => group.flatMap((version, at) => version.threadId === threadId ? [{ turnId: version.turnId, index: at + 1, count: group.length,
      ...(at > 0 ? { previous: group[at - 1].threadId } : {}), ...(at < group.length - 1 ? { next: group[at + 1].threadId } : {}) }] : []));
  }
  listed() { return this.read().then(state => state.listed); }
  list(id, shown) { return this.update(state => { state.listed = state.listed.filter(other => other !== id); if (shown) state.listed.push(id); }); }
}
