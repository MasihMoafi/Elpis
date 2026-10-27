import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './client.mjs';

const MAX_DEPTH = 2;
const MAX_ENTRIES = 400;
const SKIPPED = new Set(['node_modules', 'target', 'dist', 'build', 'out', '.next', '__pycache__', 'venv']);
/** The project directories this bridge lists (folders.mjs, files.mjs) skip: dot entries (unless `hidden` asks for them,
 * and never `.git`), tools and generated output. */
export const skipped = (name, hidden = false) => (!hidden && name.startsWith('.')) || name === '.git' || SKIPPED.has(name);

/** A project's folder as the renderer names it: an absolute path to an existing directory, else a 400. */
export async function projectDirectory(cwd) {
  if (typeof cwd !== 'string' || !cwd || cwd.length > 4096) throw new BridgeError('cwd must be an absolute directory path');
  if (!path.isAbsolute(cwd)) throw new BridgeError('cwd must be an absolute path');
  const info = await fs.stat(cwd).catch(() => null);
  if (!info?.isDirectory()) throw new BridgeError('cwd must be an existing directory');
  return cwd;
}

/** The profile's persistent workspace for workflows with no selected project. */
export async function workflowWorkspace(home) {
  const cwd = path.join(home, 'workflows', 'sandbox');
  try {
    await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
    await fs.chmod(cwd, 0o700);
  } catch {
    throw new BridgeError('Elpis could not create the workflow sandbox. Check that the profile folder is writable.', 500);
  }
  return { cwd };
}

/** Read-only: the project's directories (never files, never symlinks) as sorted repository-relative paths. */
export async function listFolders(cwd) {
  await projectDirectory(cwd);
  const found = [];
  const walk = async (relative, depth) => {
    const entries = await fs.readdir(path.join(cwd, relative), { withFileTypes: true }).catch(() => {
      if (!relative) throw new BridgeError('cwd cannot be read');
      return [];
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || skipped(entry.name)) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      found.push(child);
      if (depth < MAX_DEPTH) await walk(child, depth + 1);
    }
  };
  await walk('', 1);
  return { data: found.sort().slice(0, MAX_ENTRIES) };
}
