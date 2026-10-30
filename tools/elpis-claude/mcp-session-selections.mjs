import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const THREAD = /^[A-Za-z0-9_-]{1,128}$/;
const validServers = servers => Array.isArray(servers) && servers.length <= 100 && new Set(servers).size === servers.length && servers.every(name => typeof name === 'string' && NAME.test(name));

/** Durable per-thread MCP membership only. One file per chat avoids cross-client read/modify/write races. */
export class McpSessionSelections {
  #directory;

  constructor(directory) { this.#directory = directory; }

  #file(id) { return THREAD.test(id) ? path.join(this.#directory, `${id}.json`) : null; }

  get(id) {
    const file = this.#file(id);
    if (!file) return undefined;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      return saved?.version === 1 && saved.threadId === id && validServers(saved.servers) ? [...saved.servers] : undefined;
    } catch { return undefined; }
  }

  async set(id, servers) {
    const file = this.#file(id);
    if (!file || !validServers(servers)) throw new TypeError('Invalid per-thread MCP server names');
    await fsp.mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.pending`;
    try {
      await fsp.writeFile(temp, JSON.stringify({ version: 1, threadId: id, servers: [...servers].sort() }), { mode: 0o600 });
      await fsp.rename(temp, file);
    } catch (error) { await fsp.unlink(temp).catch(() => {}); throw error; }
  }

  async delete(id) {
    const file = this.#file(id);
    if (!file) return;
    await fsp.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
