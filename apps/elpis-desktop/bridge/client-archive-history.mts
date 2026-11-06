import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type ArchiveRow = { id: string; archivedAt?: number | null | undefined; archiveReason?: string | null | undefined; [key: string]: unknown };
export type ArchiveRecord = { archivedAt: number; archiveReason: string; agents?: unknown };
export type ArchiveOptions = { limit?: number | undefined; cursor?: string | null | undefined; archived?: boolean | undefined; [key: string]: unknown };

const archiveOrder = (a: ArchiveRow, b: ArchiveRow) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || b.id.localeCompare(a.id);

/** Archive events are independent of a conversation's creation and last activity. */
export class ArchiveHistory {
  directory: string;
  constructor(directory: string) { this.directory = directory; }
  file(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw Error('Invalid archived conversation ID');
    return path.join(this.directory, `${id}.json`);
  }
  async read(id: string): Promise<ArchiveRecord | null> {
    try {
      const info = JSON.parse(await fs.promises.readFile(this.file(id), 'utf8')) as ArchiveRecord;
      if (!Number.isFinite(info.archivedAt) || typeof info.archiveReason !== 'string') throw Error('Could not read the saved archive date and reason.');
      return info;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async record(id: string, archiveReason: string, agents: string[] = []) {
    const info = { archivedAt: Date.now(), archiveReason, ...(agents.length ? { agents } : {}) };
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(id), temporary = `${file}.${randomUUID()}.pending`;
    await fs.promises.writeFile(temporary, JSON.stringify(info), { mode: 0o600 });
    await fs.promises.rename(temporary, file);
  }
  async forget(id: string) { await fs.promises.unlink(this.file(id)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
  async page<T extends ArchiveRow>(options: ArchiveOptions, list: (options: ArchiveOptions) => Promise<{ data: T[]; nextCursor?: string | null | undefined }>) {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Choose an archive page size from 1 to 100.');
    let boundary: ArchiveRow | undefined;
    if (options.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(options.cursor, 'base64url').toString()) as ArchiveRow;
        if (!Number.isFinite(parsed.archivedAt) || typeof parsed.id !== 'string') throw Error();
        boundary = parsed;
      } catch { throw Error('Invalid archive page cursor.'); }
    }
    const rows = new Map<string, T>(), seen = new Set<string>();
    let cursor: string | null | undefined;
    do {
      const result = await list({ ...options, archived: true, limit: 100, cursor });
      for (const row of result.data) rows.set(row.id, row);
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) throw Error('Could not load every archived conversation.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    const data = (await Promise.all([...rows.values()].map(async row => ({ ...row, ...(await this.read(row.id).then(info => info && { archivedAt: info.archivedAt, archiveReason: info.archiveReason }) ?? {
      archivedAt: row.archivedAt ?? null, archiveReason: row.archiveReason ?? 'Reason unavailable for this older archive.',
    }) })))).sort(archiveOrder).filter(row => !boundary || archiveOrder(row, boundary) > 0);
    const page = data.slice(0, limit), last = page.at(-1);
    return { data: page, nextCursor: data.length > limit && last ? Buffer.from(JSON.stringify({ archivedAt: last.archivedAt ?? 0, id: last.id })).toString('base64url') : null };
  }
}
