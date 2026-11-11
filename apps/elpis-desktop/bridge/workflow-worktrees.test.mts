import { createTestTempDir, removeTestTempDir } from "../tests/temp-root.cts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { workflowWorktrees } from "./workflow-worktrees.mts";

function fixture(t: TestContext) {
  const root = createTestTempDir(path.join(os.tmpdir(), "workflow-worktrees-"));
  const dir = path.join(root, "project");
  fs.mkdirSync(dir);
  t.after(() => removeTestTempDir(root));
  return { dir };
}
const task = (id: string) => ({
  id,
  title: id,
  instruction: "Seed workflow-acp-739",
  kind: "explore",
  dependsOn: [],
  writeScopes: [],
  acceptanceCriteria: ["Return evidence"],
});

test("isolation rejects staged changes outside scope even when the working file was restored", async t => {
  const f = fixture(t);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
      { cwd, encoding: "utf8" },
    ).trim();
  git(f.dir, "init", "-q");
  fs.mkdirSync(path.join(f.dir, "src"));
  fs.writeFileSync(path.join(f.dir, "outside"), "original");
  fs.writeFileSync(path.join(f.dir, "src/seed"), "seed");
  git(f.dir, "add", "outside", "src/seed");
  git(f.dir, "commit", "-qm", "baseline");
  const isolation = await workflowWorktrees(f.dir, "staged-scope-eval");
  const writer = { ...task("writer"), kind: "implement", writeScopes: ["src"] };
  const cwd = await isolation.prepare(writer, 1);
  fs.writeFileSync(path.join(cwd, "outside"), "unwanted staged edit");
  git(cwd, "add", "outside");
  fs.writeFileSync(path.join(cwd, "outside"), "original");
  await assert.rejects(isolation.complete(writer, 1), /outside its write scopes: outside/);
  assert.equal(fs.readFileSync(path.join(f.dir, "outside"), "utf8"), "original");
});

// 1 Nov live run: a step that runs again in the same round (its check's findings, the Mother's retry, a misplaced file) failed
// with "a branch named …/candidate-…-r1 already exists". The second completion replaces the first candidate.
test("a step completed again in the same round replaces its candidate instead of failing", async t => {
  const f = fixture(t);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
      { cwd, encoding: "utf8" },
    ).trim();
  git(f.dir, "init", "-q");
  fs.mkdirSync(path.join(f.dir, "src"));
  fs.writeFileSync(path.join(f.dir, "src/seed"), "seed");
  git(f.dir, "add", "src/seed");
  git(f.dir, "commit", "-qm", "baseline");
  const isolation = await workflowWorktrees(f.dir, "second-completion");
  const writer = { ...task("writer"), kind: "implement", writeScopes: ["src"] };
  const cwd = await isolation.prepare(writer, 1);
  fs.writeFileSync(path.join(cwd, "src/answer.md"), "first");
  await isolation.complete(writer, 1);
  fs.writeFileSync(path.join(cwd, "src/answer.md"), "fixed after its check");
  const second = await isolation.complete(writer, 1);
  assert.match(second.stat ?? "", /answer\.md/);
  assert.equal(
    git(f.dir, "show", "elpis/second-completion/candidate-writer-r1:src/answer.md"),
    "fixed after its check",
  );
});

// A review stopped after its integration worktree was made (a cancel, a cherry-pick conflict) leaves
// elpis/<run>/integration behind; recovering the run built it again with `worktree add -b` and failed with
// "a branch named …/integration already exists". The rebuild replaces its own branch; other branches stay.
test("a recovered run rebuilds its own integration branch; branches outside elpis/<run>/ are left alone", async t => {
  const f = fixture(t);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
      { cwd, encoding: "utf8" },
    ).trim();
  git(f.dir, "init", "-q");
  fs.mkdirSync(path.join(f.dir, "src"));
  fs.writeFileSync(path.join(f.dir, "src/seed"), "seed");
  git(f.dir, "add", "src/seed");
  git(f.dir, "commit", "-qm", "baseline");
  const id = "0b2d6c1e-5f3a-4c7e-9a10-2b3c4d5e6f70",
    other = "1c3e7d2f-6a4b-4d8f-8b21-3c4d5e6f7a81";
  const base = git(f.dir, "rev-parse", "HEAD");
  for (const foreign of [`elpis/${other}/integration`, `mine/${id}/integration`]) git(f.dir, "branch", foreign);
  const isolation = await workflowWorktrees(f.dir, id);
  const writer = { ...task("writer"), kind: "implement", writeScopes: ["src"] };
  fs.writeFileSync(path.join(await isolation.prepare(writer, 1), "src/answer.md"), "answer");
  const done = await isolation.complete(writer, 1);
  assert.ok("candidateCommit" in done);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(isolation.review(stopped.signal), /cancelled before integration/);
  assert.ok(git(f.dir, "branch", "--list", `elpis/${id}/integration`), "the stopped review left its branch");
  const recovered = await workflowWorktrees(f.dir, id, {
    worktreeBase: isolation.base,
    worktrees: isolation.paths(),
    tasks: [{ ...writer, status: "succeeded", result: { candidateCommit: done.candidateCommit } }],
  });
  const review = await recovered.review();
  assert.equal(review.status, "ready");
  assert.equal(git(f.dir, "show", `${review.commit}:src/answer.md`), "answer");
  for (const foreign of [`elpis/${other}/integration`, `mine/${id}/integration`])
    assert.equal(git(f.dir, "rev-parse", foreign), base, `${foreign} is not Elpis's for this run`);
});
