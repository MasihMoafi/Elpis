import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './client.mjs';

/** Chats deleted from the sidebar. Deleting archives a chat at once (the engine can reverse that); Ctrl+Z unarchives
 * the newest deletion of this session; quitting the app deletes them for good. The list is kept in `file`, so after a
 * crash the next start deletes what was waiting, and an archived chat never stays hidden. Without `file` the list
 * lives only as long as the bridge. */
export async function createTrash({ client, file }) {
  /** One entry per deletion: the chats asked for (`ids`) and everything archiving them archived (`archived`, which
   * adds their agents that were not archived already). `earlier` entries come from a previous session's file. */
  let entries = [], writing = Promise.resolve();
  if (file) {
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      entries = (Array.isArray(saved?.entries) ? saved.entries : []).filter(entry => Array.isArray(entry?.ids) && Array.isArray(entry.archived))
        .map(({ ids, archived }) => ({ ids: ids.filter(id => typeof id === 'string'), archived: archived.filter(id => typeof id === 'string'), earlier: true }));
    } catch { /* No file, or one that cannot be read: nothing waits, and its chats stay archived. */ }
  }
  const save = () => {
    if (!file) return Promise.resolve();
    const content = JSON.stringify({ version: 1, entries: entries.map(({ ids, archived }) => ({ ids, archived })) });
    writing = writing.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, content, { mode: 0o600 }); await fs.rename(temp, file);
    });
    return writing;
  };
  /** The agents archiving `id` will archive with it: its descendants that are not archived yet. */
  async function liveDescendants(id) {
    const found = [];
    for (let cursor; ;) {
      const page = await client.listThreads({ ancestorThreadId: id, limit: 100, ...(cursor ? { cursor } : {}) });
      found.push(...page.data.map(thread => thread.id));
      if (!page.nextCursor || page.nextCursor === cursor) return found;
      cursor = page.nextCursor;
    }
  }
  return {
    has: id => entries.some(entry => entry.archived.includes(id)),
    async trash(threadIds) {
      if (!Array.isArray(threadIds) || !threadIds.length || threadIds.length > 100 || threadIds.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new BridgeError('Choose 1 through 100 chats to delete');
      const entry = { ids: [], archived: [] }, worktrees = [];
      try {
        for (const id of threadIds) {
          const agents = await liveDescendants(id);
          const result = await client.archiveThread(id, {});
          if (result.worktree?.kept) worktrees.push({ threadId: id, worktree: result.worktree });
          entry.ids.push(id); entry.archived.push(id, ...agents.filter(agent => !entry.archived.includes(agent)));
        }
      } finally { if (entry.ids.length) { entries.push(entry); await save(); } }
      return { trashed: entry.ids, ...(worktrees.length ? { worktrees } : {}) };
    },
    /** Brings back this session's newest deletion: `threads` are the chats asked for, `restored` every chat unarchived
     * (with their agents). An earlier session's deletions only wait to be deleted. */
    async undo() {
      const at = entries.findLastIndex(entry => !entry.earlier);
      if (at < 0) return { threads: [], restored: [] };
      const entry = entries[at], threads = [], back = new Set();
      for (const [index, id] of entry.archived.entries()) {
        // Unarchiving a chat brings back the agents archived with it (client.unarchiveThread); those are done.
        if (back.has(id)) continue;
        try {
          const result = await client.unarchiveThread(id, {});
          for (const restored of [id, ...(result.restored ?? [])]) back.add(restored);
          if (entry.ids.includes(id)) threads.push(result.thread);
        }
        catch (error) { entry.archived = entry.archived.slice(index).filter(chat => !back.has(chat)); entry.ids = entry.ids.filter(chat => entry.archived.includes(chat)); await save(); throw error; }
      }
      entries.splice(at, 1); await save();
      return { threads, restored: [...new Set([...entry.archived, ...back])] };
    },
    /** Deletes every waiting chat for good. A chat already gone is done; a failure waits for the next start. */
    async purge() {
      for (const entry of [...entries]) {
        const left = [];
        for (const id of entry.ids) {
          try { await client.deleteThread(id, {}); }
          catch (error) { if (!/thread not found/i.test(error.message)) left.push(id); }
        }
        entry.ids = left; if (!left.length) entries.splice(entries.indexOf(entry), 1);
      }
      await save();
    },
  };
}
