// What tests/canvas-live.runtime.mts leaves behind, decided without a live run (tests/canvas-live-cleanup.test.mts).
import path from 'node:path';

/** The folders a live run owns: its throwaway project and the `<project>-elpis` folder that holds its worktrees. */
const owned = (project: string) => [path.resolve(project), `${path.resolve(project)}-elpis`];
const inside = (folder: string, project: string) =>
  owned(project).some(root => folder === root || folder.startsWith(`${root}/`));

/** Every listed chat whose folder lies in the run's own folders: the Mother's, each agent's and each check's chat. */
export function runChats(threads: readonly { id: string; cwd?: unknown }[], project: string) {
  return threads.filter(thread => typeof thread.cwd === 'string' && inside(path.resolve(thread.cwd), project)).map(thread => thread.id);
}

/** config.toml without the `[projects."<folder>"]` tables the engine wrote for the run's own folders; every other line
 * stays as it was. A table runs from its header to the next header. */
export function withoutRunTrust(text: string, project: string) {
  const lines = text.split('\n'), kept: string[] = [], removed: string[] = [];
  let dropping = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      const header = /^\s*\[projects\.("(?:[^"\\]|\\.)*")\]\s*(?:#.*)?$/.exec(line);
      let key: unknown = null;
      try { key = header?.[1] ? JSON.parse(header[1]) : null; } catch { key = null; }
      dropping = typeof key === 'string' && path.isAbsolute(key) && inside(path.resolve(key), project);
      if (dropping) removed.push(key as string);
    }
    if (!dropping) kept.push(line);
  }
  return { text: kept.join('\n'), removed };
}
