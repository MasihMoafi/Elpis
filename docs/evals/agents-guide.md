# Agents guide — 18 October 2026

Intent: a short guide for someone choosing and reading a team in Elpis. Agents → guide → topic → back; Canvas help uses the same page; Ctrl+K finds “Guide”. Five topics show one at a time using the existing renderer and Button styles. No runtime or package changes.

The acceptance harness is `apps/elpis-desktop/tests/agents-guide.test.cjs`: real clicks and keys for both entries, topic changes, return navigation and command discovery; no workflow or turn POST; every topic links Anthropic; light/dark at 1280×800 and 900×700 checked with `tests/ui-fit.cjs` and screenshots.

## Content evidence

| Topic | Checked source and claim |
| --- | --- |
| One agent or many | `AGENTS.md`, Agent Dispatch: independent tasks, one worktree per implementation task, no shared files/interfaces. `lib/canvas.ts`, `TEMPLATES`: default split by parts and final join. `components/agents-canvas.tsx`, `start`, Mother settings: project required, Max agents and At once. |
| Mother and Father | `lib/canvas.ts`, `MOTHER`, `PER_PARENT`, `parents`, `runParts`: first ten writers in wave/board order, remainder under Father. `components/agents-canvas.tsx`, `startFather`, polling and Mother panel: separate chat after her success, brief, model, feed and reports. |
| Writers and checks | `lib/canvas.ts`, `runTasks`: implement plus verify task per writer; downstream depends on writer and check. `components/agents-canvas.tsx`, `start`: missing prompt/folders filled before run. `lib/canvas-isolation.ts`, `runPayload`: isolation only for several writers in a repository. `codex-rs/core/src/tools/handlers/work_graph_worktrees.rs`: writer and verifier share worktree; merging and kept work. `docs/WORK_GRAPHS.md`: blocked descendants and scope rules. |
| Patterns | `lib/canvas.ts`, `TEMPLATES`: split by parts, voting (three plus tally), debate (two plus judge), hierarchical (lead, teams, join), research (four researchers, report, citation writer); all branches run, no routing. Fit descriptions are practical interpretations of these actual dependency graphs, not measured performance claims. |
| Read a run | `lib/canvas.ts`, status/check labels and `waves`; `components/agents-canvas.tsx`, feed, dashboard, run order, done calculation and merge handling; `lib/canvas-isolation.ts`, `stopText`; `AGENTS.md`, Definition of Done: user acceptance distinct from checks. |

Source paths abbreviated above are under `apps/elpis-desktop/` unless otherwise qualified. Worktree and Father behavior describe current source; installed-engine/live behavior is not established by the guide checks.

## External references

Opened once each on 18 October 2026, both returned the titled article: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) and [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system). These are further reading; Elpis-specific statements are grounded in the source map above. Debate is an Elpis template, not attributed to Anthropic.

The Canvas help entry is a small portal component scoped to its wrapper. It follows the help section as settings replace it, avoiding edits to the Canvas files owned by another worker. Reference review: Claude desktop’s local help strings and bundled JS; existing Elpis page framing and controls remain the UI source.

## Verification

Baseline: 0/6 guide tests passed before implementation. Final: guide 6/6, command menu 9/9, bridge 324/324, desktop 155/155; locked build, separate TypeScript check and `lat check` passed. `alint check` has no project configuration. All 20 topic captures passed `ui-fit` and no-scroll checks at 1280×800 and 900×700, in light and dark; every topic’s 900px capture and representative 1280px captures were visually inspected in `/tmp/agents-guide-shots/`. Link-click tests intercept navigation locally; the two real article fetches above were each done only once. Installed app, live inference and user acceptance remain unchecked.
