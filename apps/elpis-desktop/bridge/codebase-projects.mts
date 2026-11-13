/**
 * The Git projects his chats use, for the Codebase page's project chooser (docs/specs/codebase-dashboard.md, D9).
 * Most of his chats run in a folder that holds repositories without being one (`~/Desktop/p`), or in the router's
 * folders, which have no Git; reading only the chat's own folder left him on "not a Git project" (13 Nov). A chat's
 * folder counts as its repository, a subfolder and a linked worktree count as the repository they belong to, and a
 * folder outside Git counts the repositories directly inside it. Nothing is written.
 */
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
/** A folder holding more repositories than this is not a projects folder (a home folder, say); the rest are skipped. */
const MAX_CHILDREN = 200;

export type CodebaseProject = { root: string; name: string; usedAt: number };
export type ChatFolder = { cwd?: unknown; usedAt?: unknown };

/** The main checkout of the repository that holds `folder`, or null when `folder` is not inside a Git work tree. */
export async function repositoryOf(folder: string): Promise<string | null> {
  try {
    const [inside = "", top = "", common = ""] = (
      await run("git", ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], {
        cwd: folder,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        timeout: 10_000,
      })
    ).stdout
      .trim()
      .split("\n");
    if (inside !== "true" || !top) return null;
    // A linked worktree shares the main checkout's `.git`; a submodule's lives under its parent's, so it stays itself.
    const main = path.basename(common) === ".git" ? path.dirname(common) : top;
    return (await stat(main).then(info => info.isDirectory(), () => false)) ? main : top;
  } catch {
    return null;
  }
}

/** The repositories directly inside a folder that is not one itself. */
async function repositoriesIn(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const children = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).slice(0, MAX_CHILDREN);
  const found = await Promise.all(
    children.map(async entry => {
      const child = path.join(folder, entry.name);
      const marked = await stat(path.join(child, ".git")).then(() => true, () => false);
      return marked ? repositoryOf(child) : null;
    }),
  );
  return found.filter((root): root is string => Boolean(root));
}

/**
 * Each repository his chats use, once, most recently used first. A repository a chat works in directly carries that
 * chat's time; one found only inside a chat's folder ranks after them, by name.
 */
export async function codebaseProjects(chats: ChatFolder[]): Promise<CodebaseProject[]> {
  const latest = new Map<string, number>();
  for (const chat of chats) {
    if (typeof chat.cwd !== "string" || !path.isAbsolute(chat.cwd)) continue;
    const at = typeof chat.usedAt === "number" && Number.isFinite(chat.usedAt) ? chat.usedAt : 0;
    latest.set(chat.cwd, Math.max(latest.get(chat.cwd) ?? 0, at));
  }
  const used = new Map<string, number>();
  const nested = new Set<string>();
  await Promise.all(
    [...latest].map(async ([cwd, at]) => {
      const root = await repositoryOf(cwd);
      if (root) used.set(root, Math.max(used.get(root) ?? 0, at));
      else for (const inner of await repositoriesIn(cwd)) nested.add(inner);
    }),
  );
  const projects = [...used].map(([root, usedAt]) => ({ root, name: path.basename(root), usedAt }));
  for (const root of nested) if (!used.has(root)) projects.push({ root, name: path.basename(root), usedAt: 0 });
  return projects.sort((a, b) => b.usedAt - a.usedAt || a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
}
