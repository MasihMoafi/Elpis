# SPEC: Codebase dashboard

Goal: in the Elpis app, one page shows what a project's code holds, how it changes and how ready it is for coding agents. It works for any project that has Git. Masih asked for it on 5, 6 and 7 November, and on 11 November asked to "see that to the end". His dated words are collected in `~/.cache/elpis-workers/readiness/find-dashboard-reqs.out`.

What exists: a prototype page with Elpis's own numbers (`~/Work/tries/elpis-metrics/dashboard.html`, built by `build.py`), and a paused readiness spec on the branch `feature/readiness-20261106`.

Invariants: the page reads a project and writes nothing in it. A project without Git gets a plain message, not an empty chart.

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| D1 | The page is in the app, for the project of the chat he picks. | Observability, then Codebase, for a chat in a Git folder: the sections show that project's numbers. | doing: built; proven in the window test with a stand-in project (`tests/codebase-page.test.cts`). Not yet seen in his app |
| D2 | Code by area: lines of code and data in each top-level folder. Markdown, lock files, media and build output are left out. | In a test repository the numbers equal the line counts of its tracked files. | done: `bridge/codebase.test.mts`; on Elpis itself it read 2.33 million lines under codex-rs and 246,438 under apps in about 11 seconds |
| D3 | Documents by folder: Markdown lines. | Same test repository. | done: same test |
| D4 | Churn: lines added and removed in each file, for all time, six months, three months or two dates he picks. | A test repository with dated commits: a range counts only the commits inside it. | done: same test for the dates; the window test picks 30 days and All time |
| D5 | Copies on disk: every worktree with its size, branch, last commit and unsaved files. | Same numbers as `git worktree list` and `du`. | done: same test; on Elpis it measured 9,510 MB for the one checkout |
| D6 | Exact copies among tracked files, the largest first. | Two identical files in the test repository are listed as one set. | done: same test; on Elpis it found 42 sets |
| D7 | Readiness checks: yes or no, each with its evidence, grouped by pillar, with the pass rate of each pillar. No levels and no 0–100 scores (his 7 Nov doubts). | Removing the README from the test repository turns that check to "Not met", with the reason. | done: 20 checks in 7 pillars, each read from tracked files; Elpis meets 14. The check list is a first set: his own questions and the judges are not in it |
| D8 | Each report is kept, and the page shows what changed since the last one. | A second report after a change lists the check that moved. | done: same test; reports are kept under `readiness/` in the Elpis home |

Non-goals now: LLM judges and their rubrics, which wait for his approval of the rubric (readiness spec v2); levels; his own list of questions, which he writes himself.

Stop and ask: a check that would need a paid model call; anything that writes in the project.
