import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** Native forks retain model-visible tool history. Only one checkpoint is visible at a time. Undo/redo swaps
 * conversations, never files, until another turn is sent. */
export class RewindHistory {
  constructor(home, rpc) { this.home = home; this.rpc = rpc; }
  file(id) { return path.join(this.home, 'history', `${createHash('sha256').update(id).digest('hex')}.json`); }
  async read(id) { return JSON.parse(await fs.readFile(this.file(id), 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error; })); }
  async save(state) {
    await fs.mkdir(path.join(this.home, 'history'), { recursive: true, mode: 0o700 });
    for (const id of [state.original, state.prefix]) {
      const file = this.file(id), temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await fs.rename(temporary, file);
    }
  }
  async tip(id) {
    const page = await this.rpc('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    if (!Array.isArray(page.data)) throw new Error('Could not verify the conversation checkpoint.');
    if (page.data[0]?.status === 'inProgress') throw new Error('Rewind is unavailable while Elpis is working.');
    return page.data[0]?.id ?? null;
  }
  async status(id) {
    const state = await this.read(id); if (!state || state.invalid || state.current !== id) return null;
    if (await this.tip(id) !== state.tips[id]) return null;
    return { action: state.action };
  }
  async invalidate(id) { const state = await this.read(id); if (state && !state.invalid) { state.invalid = true; await this.save(state); } }
  async hide(id, hidden) { const state = await this.read(id); if (state && state.current === id) { state.hidden = hidden; await this.save(state); } }
  async currentIds() {
    const directory = path.join(this.home, 'history'), ids = new Set();
    const files = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const file of files.filter(name => name.endsWith('.json'))) {
      const state = await fs.readFile(path.join(directory, file), 'utf8').then(JSON.parse).catch(() => null);
      if (typeof state?.current !== 'string' || ids.has(state.current)) continue;
      const current = await this.read(state.current).catch(() => null);
      if (current?.current === state.current && !current.hidden) ids.add(state.current);
    }
    return [...ids];
  }
  async restore(thread, beforeTurnId, restoreFiles) {
    const tip = await this.tip(thread.id);
    const fork = await this.rpc('thread/fork', { threadId: thread.id, beforeTurnId,
      ...(thread.model ? { model: thread.model } : {}), ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}) });
    if (!fork.thread?.id || fork.thread.id === thread.id) throw new Error('Could not preserve this conversation for Undo rewind.');
    try {
      const name = thread.name?.trim() || String(thread.preview || 'Chat').split('\n')[0].slice(0, 120);
      await this.rpc('thread/name/set', { threadId: fork.thread.id, name }); fork.thread.name = name;
      const prefixTip = await this.tip(fork.thread.id);
      if (await this.tip(thread.id) !== tip) throw new Error('The conversation changed. Close Rewind and try again.');
      await restoreFiles(fork.thread.id);
      const state = { original: thread.id, prefix: fork.thread.id, current: fork.thread.id, action: 'undo', tips: { [thread.id]: tip, [fork.thread.id]: prefixTip } };
      await this.save(state); await this.rpc('thread/archive', { threadId: thread.id });
      return { thread: fork.thread, undo: 'undo' };
    } catch (error) { await this.rpc('thread/archive', { threadId: fork.thread.id }).catch(() => {}); throw error; }
  }
  async toggle(id, action) {
    const state = await this.read(id);
    if (!state || state.invalid || state.current !== id || state.action !== action) throw new Error('This rewind is no longer available.');
    if (await this.tip(id) !== state.tips[id]) throw new Error('Couldn’t undo this rewind because a message was sent after it.');
    const target = action === 'undo' ? state.original : state.prefix;
    if (await this.tip(target) !== state.tips[target]) throw new Error('The saved conversation changed. This rewind is no longer available.');
    const result = await this.rpc('thread/unarchive', { threadId: target });
    try { await this.rpc('thread/archive', { threadId: id }); }
    catch (error) { await this.rpc('thread/archive', { threadId: target }).catch(() => {}); throw error; }
    state.current = target; state.action = action === 'undo' ? 'redo' : 'undo'; await this.save(state);
    return { thread: result.thread, undo: state.action };
  }
}
