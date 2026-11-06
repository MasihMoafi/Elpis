import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** @typedef {{ id: string, archivedAt?: number | null, archiveReason?: string | null }} ArchiveRow */
/** @typedef {{ archivedAt: number, archiveReason: string, agents?: unknown }} ArchiveRecord */
/** @typedef {{ limit?: number, cursor?: string | null | undefined, archived?: boolean }} ArchiveOptions */
/** @param {ArchiveRow} a @param {ArchiveRow} b */
const archiveOrder = (a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || b.id.localeCompare(a.id);

/** Archive events are independent of a conversation's creation and last activity. */
export class ArchiveHistory {
  /** @param {string} directory */
  constructor(directory) { this.directory = directory; }
  /** @param {string} id */
  file(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('Invalid archived conversation ID');
    return path.join(this.directory, `${id}.json`);
  }
  /** @param {string} id @returns {Promise<ArchiveRecord | null>} */
  async read(id) {
    try {
      const info = JSON.parse(await fs.promises.readFile(this.file(id), 'utf8'));
      if (!Number.isFinite(info.archivedAt) || typeof info.archiveReason !== 'string') throw Error('Could not read the saved archive date and reason.');
      return info;
    } catch (error) { if ((/** @type {NodeJS.ErrnoException} */ (error)).code === 'ENOENT') return null; throw error; }
  }
  /** @param {string} id @param {string} archiveReason @param {string[]} [agents] */
  async record(id, archiveReason, agents = []) {
    const info = { archivedAt: Date.now(), archiveReason, ...(agents.length ? { agents } : {}) };
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(id), temporary = `${file}.${randomUUID()}.pending`;
    await fs.promises.writeFile(temporary, JSON.stringify(info), { mode: 0o600 });
    await fs.promises.rename(temporary, file);
  }
  /** @param {string} id */
  async forget(id) { await fs.promises.unlink(this.file(id)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  /**
   * @param {ArchiveOptions} options
   * @param {(options: ArchiveOptions) => Promise<{ data: ArchiveRow[], nextCursor?: string | null }>} list
   */
  async page(options, list) {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Choose an archive page size from 1 to 100.');
    /** @type {ArchiveRow | undefined} */ let boundary;
    if (options.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(options.cursor, 'base64url').toString());
        if (!Number.isFinite(parsed.archivedAt) || typeof parsed.id !== 'string') throw Error();
        boundary = parsed;
      } catch { throw Error('Invalid archive page cursor.'); }
    }
    const rows = new Map(), seen = new Set();
    /** @type {string | null | undefined} */ let cursor;
    do {
      const result = await list({ ...options, archived: true, limit: 100, cursor });
      for (const row of result.data) rows.set(row.id, row);
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) throw Error('Could not load every archived conversation.');
      seen.add(cursor);
    } while (cursor);
    const data = (await Promise.all([...rows.values()].map(async row => ({ ...row, ...(await this.read(row.id).then(info => info && { archivedAt: info.archivedAt, archiveReason: info.archiveReason }) ?? {
      archivedAt: row.archivedAt ?? null, archiveReason: row.archiveReason ?? 'Reason unavailable for this older archive.',
    }) })))).sort(archiveOrder).filter(row => !boundary || archiveOrder(row, boundary) > 0);
    const page = data.slice(0, limit), last = page.at(-1);
    return { data: page, nextCursor: data.length > limit ? Buffer.from(JSON.stringify({ archivedAt: last.archivedAt ?? 0, id: last.id })).toString('base64url') : null };
  }
}
