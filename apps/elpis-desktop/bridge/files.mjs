import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './client.mjs';
import { projectDirectory, skipped } from './folders.mjs';

const MAX_DEPTH = 4;
const MAX_ENTRIES = 2000;

/** Read-only: the project's files (never directories, dot entries or symlinks) as repository-relative paths, the
 * @-mention picker's list. A breadth-first walk, so the shallow files survive the cap; each level is in name order. */
export async function listFiles(cwd) {
  await projectDirectory(cwd);
  const found = [];
  let level = [''];
  for (let depth = 0; depth <= MAX_DEPTH && level.length && found.length < MAX_ENTRIES; depth++) {
    const next = [];
    for (const relative of level) {
      const entries = await fs.readdir(path.join(cwd, relative), { withFileTypes: true }).catch(() => {
        if (!relative) throw new BridgeError('cwd cannot be read');
        return [];
      });
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (skipped(entry.name)) continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isFile()) found.push(child);
        else if (entry.isDirectory()) next.push(child);
      }
    }
    level = next;
  }
  return { data: found.slice(0, MAX_ENTRIES) };
}
