# Agent readiness (spec v2, for Masih's yes)

Request: REQUESTS.md, 6 November. Lowest priority, runs in parallel (7 Nov). Built only after his go.
Grounded in his reading, through the rag workspace `readiness` (161 sources). Research reports, with file:line
citations: `~/.cache/elpis-workers/readiness/{read-books,full-course,full-vault,full-books}.out`.

## Goal
For a git project Masih picks, Elpis shows how ready the codebase is for coding agents and what to fix first:
pillar checks, principle scores with evidence and one best fix each, blockers to the next level, and the change since
the last report. A guide to inspectable fixes, not proof of quality (Week 5 assignment; Comprehension Debt).

## Who sees it, and where
Masih, in the desktop app, as the Readiness section of the code dashboard (code, churn, docs, worktrees,
duplicates), for any project with git (his 6 Nov words). The "elpis" session owns the page, the project picker and
the charts; this work owns the engine, the stored reports and the section's content.

## What is measured: two scales, never mixed (Fundamentals of SW Architecture ch 6; Factory)
1. **Pillar checks**, pass / fail / not applicable / unknown, each with evidence. Factory's eight pillars. Starts
   from the 28 prototype checks plus the signals the readings name (lint, types, pre-commit, documented env vars,
   locally runnable tests, E2E tests, agent instructions in git and true to the code, CODEOWNERS, branch protection,
   security and dependency scans, logs and traces). Repo-scoped and per-app (a monorepo shows "3 of 4 apps").
2. **Principle scores**, 0–100 or unknown, one judge each: DRY, single source of truth, separation of concerns,
   cohesion, coupling, modularity. Rubric anchors at 0/25/50/75/100 from Clean Code and Fundamentals of SW
   Architecture (draft in read-books.out; his approval needed). Each score has `path:line` evidence (both ends for
   duplication and coupling), observed vs inferred marked, and one best fix with its reason.
3. **Level 1–5** (Functional … Autonomous): a level needs 80% of its checks and of every lower level's.
   No source on disk says which check belongs to which level; Factory publishes only Level 3's key signals (E2E
   tests, maintained docs, security scanning, observability). Until Masih assigns levels, Elpis shows pass rates
   per pillar and no level.
4. **Masih's questions**: an empty, named list per project. Elpis writes none. Each question he adds gets an
   evidenced answer on the next run.

## How a run works
- Only when he presses Run report. Records commit, model, rubric version, tool versions.
- **Code measures first** (fitness functions): file sizes, cyclomatic complexity, exact and near duplicates,
  unused-code candidates, dependency graph (incoming/outgoing coupling, instability, cycles), churn. Unknown when a
  language is unsupported.
- **Judges second**, one fresh read-only engine thread each in the project folder, on Codex Terra or agy Gemini
  Argon Medium, never Claude. Each gets: its rubric, its passages from the rag workspace (fixed query, passage ids
  stored), the code measures, its **previous report** for this project with each finding's status, and the files
  changed since that commit. It must re-check every earlier finding against current code: fixed findings drop,
  unresolved ones stay, Masih's overrides stand (Cloudflare re-review). It may answer "no issue".
- The bridge rejects evidence naming a missing file or line, and a score move without new evidence.

## What is stored
`$ELPIS_HOME/readiness/<project id>/<date-time>.json` per run; `questions.json` and `overrides.json` beside it.
Trend = difference from the previous run, per check, per score, per finding. Nothing is written in the project.

## What the section shows (after Factory's report page, with his date picking)
Level or "no level yet"; pass rate; a criteria bar grouped by level; pass rate per pillar; scores over time with a
date range he picks; one card per check or principle: result, evidence, best fix, change; blockers to the next level
and the single cheapest high-leverage fix; checks that do not fit this project; his questions with answers.

## Acceptance test
1. Picking a git project and pressing Run report shows pillar checks and six principle scores, each with
   evidence that opens at the cited line, and one best fix.
2. Two runs on an unchanged commit: no score moves more than 3 points, no check flips (Elpis and one small repo).
3. A seeded change (a copied function; a removed test command) moves the matching score or check, citing it.
4. No questions: the slot says so. After he adds one, the next run answers it with evidence.
5. Fast unit tests, no browser or model: level gating, trend, storage, the previous report reaching each judge
   (absent on a first run), rejection of bad evidence.
6. Calibration before trust: 20 findings labelled by Masih; report false positives and misses.

## Status (7 Nov): needs more thinking from Masih
- Extra judges (naming, complexity, dead code, duplication, test value, docs truth): unsure they help.
- Levels: not needed.
- 0–100 scores: he hears scoring is weak in AI evals. The readings agree: fuzzy scales drift; yes/no rubric
  questions with evidence are steadier (Evaluating Agents in Production, "Trap 2"; full-vault.out section 3).
- Nothing is built. Restart from his answers.
