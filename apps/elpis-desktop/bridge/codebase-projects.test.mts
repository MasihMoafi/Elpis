// The Codebase page's project chooser (docs/specs/codebase-dashboard.md, D9). 13 Nov, Masih: "it says no git and I
// couldn't find any git projects which is odd!". His chats run in a folder of repositories that is not one itself, or
// in the router's folders; each kind of chat folder is made here and read as the page reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codebaseReport } from "./codebase.mts";
import { codebaseProjects, repositoryOf } from "./codebase-projects.mts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
function repo(root: string, committedAt = 1_700_000_000) {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "one\ntwo\n");
  const dated = { ...env, GIT_AUTHOR_DATE: `@${committedAt} +0000`, GIT_COMMITTER_DATE: `@${committedAt} +0000` };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) execFileSync("git", args, { cwd: root, env: dated });
}

/** His folders in small: a projects folder like ~/Desktop/p (an empty `.git/info` and repositories inside), a linked
 * worktree, and the router's chat and worker folders. */
function folders() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "codebase-projects-")));
  const p = join(top, "p"),
    elpis = join(p, "Elpis"),
    rustidian = join(p, "rustidian"),
    worktree = join(p, ".worktrees", "elpis-task"),
    router = join(top, "elpis-home", "router"),
    worker = join(router, "work", "ticket-1");
  mkdirSync(join(p, ".git", "info"), { recursive: true });
  writeFileSync(join(p, ".git", "info", "exclude"), "*\n");
  repo(elpis);
  repo(rustidian, 1_800_000_000);
  execFileSync("git", ["worktree", "add", "-q", "-b", "task", worktree], { cwd: elpis, env });
  mkdirSync(worker, { recursive: true });
  return { top, p, elpis, rustidian, worktree, router, worker, done: () => rmSync(top, { recursive: true, force: true }) };
}

test("each kind of chat folder: which have Git of their own and which repository they read", async t => {
  const f = folders();
  t.after(f.done);
  const home = join(f.top, "elpis-home");
  const says = async (folder: string) =>
    codebaseReport(folder, home).then(
      report => report.name,
      (error: Error & { stderr?: string }) =>
        /not a git repository/i.test(error.stderr ?? error.message) ? "no Git" : error.message,
    );
  // What the page read before the chooser: the chat's own folder. Three of his kinds of chat say "no Git".
  assert.deepEqual(
    {
      gitFolder: await says(f.elpis),
      subfolder: await says(join(f.elpis, "src")),
      worktree: await says(f.worktree),
      folderOfRepositories: await says(f.p),
      elpisChat: await says(f.router),
      workerChat: await says(f.worker),
    },
    {
      gitFolder: "Elpis",
      subfolder: "Elpis",
      worktree: "elpis-task",
      folderOfRepositories: "no Git",
      elpisChat: "no Git",
      workerChat: "no Git",
    },
  );
  // The chooser resolves each to its repository: a subfolder and a worktree to Elpis, the others to none.
  assert.equal(await repositoryOf(join(f.elpis, "src")), f.elpis);
  assert.equal(await repositoryOf(f.worktree), f.elpis);
  for (const folder of [f.p, f.router, f.worker, join(f.top, "gone")]) assert.equal(await repositoryOf(folder), null, folder);
});

test("the chooser lists each repository his chats use once, the most recently used first", async t => {
  const f = folders();
  t.after(f.done);
  const projects = await codebaseProjects([
    { cwd: f.router, usedAt: 900 },
    { cwd: f.worker, usedAt: 800 },
    { cwd: f.p, usedAt: 700 },
    { cwd: f.worktree, usedAt: 500 },
    { cwd: join(f.elpis, "src"), usedAt: 300 },
    { cwd: f.elpis, usedAt: 100 },
    { cwd: "relative/folder", usedAt: 1000 },
  ]);
  assert.deepEqual(projects, [
    { root: f.elpis, name: "Elpis", usedAt: 500, committedAt: 1_700_000_000 },
    // Found only inside the projects folder his chats run in. Its last commit (F3, 14 Nov: the page opened on the
    // first project by name) lets the page open on the most recently committed one.
    { root: f.rustidian, name: "rustidian", usedAt: 0, committedAt: 1_800_000_000 },
  ]);
  assert.deepEqual(await codebaseProjects([{ cwd: f.router, usedAt: 1 }, { cwd: f.worker }]), [], "no Git anywhere: an empty list");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: f.elpis }).toString(), "", "nothing was written in the project");
});
