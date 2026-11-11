// The Codebase page's data (docs/specs/codebase-dashboard.md), read from a small Git project made for the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codebaseReport } from "./codebase.mts";

function project() {
  const root = mkdtempSync(join(tmpdir(), "codebase-")),
    home = mkdtempSync(join(tmpdir(), "codebase-home-"));
  const git = (date: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `${date}T12:00:00Z`,
        GIT_COMMITTER_DATE: `${date}T12:00:00Z`,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.test",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.test",
      },
    });
  const write = (file: string, text: string) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  git("2026-01-10", "init", "-q", "-b", "main");
  write("src/a.ts", "one\ntwo\nthree\n");
  write("src/copy.ts", "one\ntwo\nthree\n");
  write("tests/a.test.ts", "check\n");
  write("docs/guide.md", "# Guide\n\nline\nline\nline\n");
  write("README.md", "# Project\n");
  write("package.json", JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }));
  write("package-lock.json", "{}\n");
  git("2026-01-10", "add", "-A");
  git("2026-01-10", "commit", "-q", "-m", "first");
  write("src/a.ts", "one\nTWO\nthree\nfour\n");
  git("2026-06-10", "add", "-A");
  git("2026-06-10", "commit", "-q", "-m", "second");
  return { root, home, git, write, done: () => [root, home].forEach(dir => rmSync(dir, { recursive: true, force: true })) };
}

test("a project's code, docs, churn, copies and readiness are read from its Git, and nothing is written in it", async t => {
  const p = project();
  t.after(p.done);
  const report = await codebaseReport(join(p.root, "src"), p.home);
  assert.deepEqual(
    report.code.map(row => [row.k, row.v, row.d]),
    [
      ["src", 7, "2 files"],
      ["tests", 1, "1 files"],
      ["(top level)", 0, "1 files"],
    ],
    "lock files and Markdown are left out; the folder inside the project still reads the whole project",
  );
  assert.deepEqual(report.docs, [
    ["docs", 1, 5],
    ["(top level)", 1, 1],
  ]);
  const churnOf = (from: string, to: string) =>
    report.churnLog
      .filter(([date]) => date >= from && date <= to)
      .flatMap(([, changes]) => changes.map(([file, lines]) => [report.churnFiles[file]![0], lines]));
  assert.deepEqual(churnOf("2026-06-01", "2026-12-31"), [["src/a.ts", 3]], "only the June commit: one line changed, one added");
  assert.equal(churnOf("2026-01-01", "2026-01-31").length, 3, "the January commit added three code files");
  assert.deepEqual(report.dups, [], "the copy stopped being a copy when the first file changed");
  assert.equal(report.worktrees.length, 1);
  assert.deepEqual(report.worktrees[0]!.slice(2), ["main", "2026-06-10", 0]);
  const checks = new Map(report.pillars.flatMap(([, list]) => list.map(([name, met, evidence]): [string, [number, string]] => [name, [met, evidence]])));
  assert.deepEqual(checks.get("A README"), [1, "README.md"]);
  assert.deepEqual(checks.get("Tests exist"), [1, "1 test files"]);
  assert.deepEqual(checks.get("A test command is written down"), [1, "package.json: npm run test"]);
  assert.deepEqual(checks.get("Agent instructions are in Git"), [0, "no AGENTS.md or CLAUDE.md in Git: a fresh clone has none"]);
  assert.deepEqual([report.changed, report.previous], [[], null], "a first report has nothing to compare with");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: p.root }).toString(), "", "nothing was written in the project");
});

test("the next report says which checks moved, and two identical files are one set of copies", async t => {
  const p = project();
  t.after(p.done);
  await codebaseReport(p.root, p.home);
  p.git("2026-07-01", "rm", "-q", "README.md");
  p.write("src/a.ts", "one\ntwo\nthree\n");
  p.write("AGENTS.md", "# Rules\n");
  p.git("2026-07-01", "add", "-A");
  p.git("2026-07-01", "commit", "-q", "-m", "third");
  const report = await codebaseReport(p.root, p.home);
  assert.deepEqual(
    report.changed.sort((a, b) => a.check.localeCompare(b.check)),
    [
      { check: "A README", from: 1, to: 0 },
      { check: "Agent instructions are in Git", from: 0, to: 1 },
      { check: "No exact copies of code or data", from: 1, to: 0 },
    ],
  );
  assert.match(report.previous ?? "", /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(
    report.dups.map(dup => [dup.files, dup.kind]),
    [[["src/a.ts", "src/copy.ts"], "other"]],
  );
  const again = await codebaseReport(p.root, p.home);
  assert.deepEqual(again.changed.length, 3, "a report that says the same keeps comparing with the one before the change");
});

test("a folder that is not a Git project is refused", async t => {
  const folder = mkdtempSync(join(tmpdir(), "codebase-none-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  await assert.rejects(codebaseReport(folder, folder), /not a git repository/i);
});
