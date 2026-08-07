This repository is a fork of the OpenAI Codex CLI. Large parts of the inherited code are
not used by this product. Your task is to delete them.

**Goal: remove as many lines of code as you can without changing what the application
does.** This is a first-principles deletion pass — question whether a thing needs to exist
at all before you consider keeping it.

**Rules**

1. The workspace must still compile when you stop.
2. Any test that passes now must still pass. Record the failing set before you start; it is
   already red at HEAD and those failures are not yours to fix or to claim.
3. Deletion only. No renaming, no reformatting, no refactoring, no moving code between
   files. Moved code is not deleted code and will not be counted.
4. Do not delete or weaken a test to make a deletion possible. If you delete a module, its
   own tests may go with it — that is fine, and those lines do not count toward your score.
   Deleting a test whose subject still exists disqualifies that change.
5. Commit as you go, in small commits, each one compiling. Uncommitted work at the end is
   not scored.

**Scoring**

Your score is the net number of source lines removed, counted only across commits where
the crate compiles and the test baseline is unchanged. A change that breaks the build or a
previously-passing test scores zero for that commit. There is no partial credit for
intentions, plans, or notes.

**Build discipline — read before running anything**

- Set `CODEX_SKIP_BWRAP_BUILD=1` for every cargo invocation.
- Scope every command to one crate: `cargo check -p <crate>`. **Never** `cargo build`,
  bare `cargo test`, or `--all`. Never `cargo fmt --all`.
- Prefer `cargo check` while iterating. Run tests only when you have something to test.
- The workspace `target/` directory has reached 246 GB before. Do not add build artifacts
  outside it.

**Time limit: 2 hours.** Work until the time is up. Do not stop early, do not wait to be
asked to continue, and do not spend the budget writing a plan. When the time is up, make
sure your last commit compiles.
