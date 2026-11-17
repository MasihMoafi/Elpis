import type { Entry } from './api.ts';

export type BackgroundProcess = { itemId: string; processId: string; command: string; cwd: string };
export class BackgroundProcessesDisabled extends Error {}

/** A partial list is not a complete list, especially if the runtime fails on a later page. */
export async function listBackgroundProcesses(read: (cursor?: string) => Promise<unknown>): Promise<BackgroundProcess[]> {
  const rows: BackgroundProcess[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read(cursor) as { data?: unknown; nextCursor?: unknown };
    if (page && (page as { state?: unknown }).state === 'disabled') {
      if (cursor) throw new Error('Background process status changed during pagination');
      throw new BackgroundProcessesDisabled();
    }
    if (!page || !Array.isArray(page.data) || (page.nextCursor != null && typeof page.nextCursor !== 'string'))
      throw new Error('Invalid background process list');
    for (const row of page.data) {
      if (!row || typeof row.itemId !== 'string' || typeof row.processId !== 'string' ||
          typeof row.command !== 'string' || typeof row.cwd !== 'string') throw new Error('Invalid background process');
      rows.push(row as BackgroundProcess);
    }
    cursor = page.nextCursor || undefined;
    if (cursor && seen.has(cursor)) throw new Error('Repeated background process page');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}

export function processView(processes: BackgroundProcess[], entries: Entry[]) {
  return processes.map(process => {
    const item = entries.find(entry => entry.item.id === process.itemId && entry.item.type === 'commandExecution')?.item;
    return { ...process, output: typeof item?.aggregatedOutput === 'string' ? item.aggregatedOutput : '' };
  });
}
