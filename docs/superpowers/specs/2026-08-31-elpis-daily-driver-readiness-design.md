---
name: Elpis daily-driver readiness candidate
type: Internal implementation and acceptance specification
---

# Elpis Daily-Driver Readiness Candidate

## Status

Approved in chat by Masih on 2026-08-31, with two explicit amendments:

- this work produces a candidate for manual acceptance, not a release; and
- automatic pruning must be visibly marked experimental, while `/dashboard`
  must become a useful, intentionally designed product surface.

Automated checks and GitHub builds are evidence. Only Masih can accept the
installed behavior or authorize promotion to the normal `elpis` command.
Acceptance of the candidate does not authorize replacing `elpis`, merging to
`main`, versioning, or releasing. Each requires a separate later instruction
from Masih.

## Intent

Make Elpis safe and pleasant enough to evaluate as a daily Codex replacement:
preserve current Codex behavior by default, repair known Elpis regressions,
connect the distinctive Elpis capabilities that already exist, and shorten the
development feedback cycle without hiding unfinished experiments in the core.

This is a staged integration program, not a rewrite, upstream-wide rebase, new
operating system, or claim that Elpis outperforms Codex.

## Current Evidence

The candidate baseline is `72c2a5dc14ba6a0739a63b1a44eb3f4247596ae2`.
Read-only source audits found an Elpis-only 40%-remaining compaction rule, a
blocking interrupt request in the TUI event path, an invisible automatic-prune
flag, a context-only dashboard that can serve stale data, partial agent/work-
graph views, and manual memory with positive and negative request-level tests.
These findings justify the work; they do not prove the future candidate works.

## Non-Release Boundary

This effort must not:

- merge to `main`;
- create a tag, version bump, GitHub release, public announcement, or published
  package;
- replace the currently installed `elpis` executable before Masih accepts the
  candidate;
- restart or disturb another running Elpis/Codex process or the separate
  `feat/turn-observability` worktree; or
- call the candidate complete on the strength of compilation or automated
  tests alone.

The final local artifact is installed alongside the current executable as an
explicit candidate, such as `elpis-candidate`. Masih manually verifies the
important workflows before any later promotion is considered.

During implementation, do not run local Rust builds, checks, or tests; use
GitHub CI. Only after candidate-scoped issues are closed and required Linux CI
is green, follow `docs/LOCAL_BUILD_RULES.md`, check disk usage, and perform one
local `elpis-candidate` build/install. Do not launch it in tmux.

## Design Principles

1. **Codex behavior is the default.** Elpis-specific behavior is additive,
   visible, reversible, and off by default when experimental.
2. **One source of truth per fact.** Runtime events feed both the TUI and the
   read-only dashboard; the dashboard does not scrape logs or reconstruct
   state from display text.
3. **The interface explains uncertainty.** Missing cost, memory, timing, or
   graph data appears as unavailable with a reason, never as zero or success.
4. **The dashboard helps intervention.** It answers what is happening, whether
   the agent is healthy, what context it carries, and what needs attention.
5. **Verification is proportional.** Small changes have a fast focused path;
   unknown or shared changes fall back to the conservative full Linux surface.

## Stage 1: Codex-Equivalent Foundation

### 1.1 Native compaction parity

Pin Codex commit `a9519cbcdd2d664530edb2469224ee03c1056799` as the
reference. Port its context-window resolution, model-specific automatic
compaction threshold, usable-window headroom, and associated tests exactly,
using source rather than a remembered percentage.

Remove Elpis's special `40% remaining` / `60% used` total-scope backstop. At the
audited donor revision, the normal fallback is approximately 90% of the
resolved context window and the default usable ceiling is approximately 95%,
but donor source and model metadata remain authoritative.

Ordinary `/compact` and automatic native compaction use Codex's normal
summarizer and lifecycle. No Elpis pruning pass may masquerade as compaction.
Remove the separate `elpis_compact_cleanup` path rather than leaving a second
behavior behind the same `/compact` command.

Update `docs/context.md`, `docs/cache-friendly-pruning.md`, and `readme.md` so
they distinguish native Codex compaction, manual `/prune`, and opt-in
experimental automatic pruning. They must not advertise the removed cleanup
path or describe the experimental pressure cycle as default behavior.

### 1.2 Manual and automatic pruning

`/prune` remains a visible manual Elpis feature. `/force-prune` remains an
advanced manual action with its explicit target.

Automatic pruning remains disabled by default. It is visible in all relevant
places:

- `/settings` is restored to slash-command discovery and contains
  `Automatic pruning — Experimental`, its on/off state,
  and the plain-language description `Distills completed tool output before
  native compaction. Uses an extra AI call and may slow a turn, reduce prompt
  cache reuse, or remove useful detail.`;
- the dashboard Context view shows `Automatic pruning: Off` or
  `Automatic pruning: On · Experimental`;
- `/prune` completion/status copy distinguishes the manual action from the
  automatic experimental mode; and
- configuration documentation uses the same name and warning.

Enabling the setting is an explicit user action and persists through the
existing feature configuration path. Manual `/prune` works regardless of the
automatic setting. The feature registry promotes automatic pruning from the
invisible `UnderDevelopment` stage to the user-visible `Experimental` stage;
this does not change its default. `/settings` derives its experimental rows
from registry metadata instead of adding another hard-coded feature list.

### 1.3 Responsive interrupt and shutdown

Port current Codex's nonblocking interrupt design into Elpis's app-server TUI:

- reserve and track the pending turn ID;
- send `turn/interrupt` outside the sole UI event loop;
- coalesce repeated interrupts for the same turn;
- retain one stale-turn retry and route failure back as a visible warning; and
- clear pending state when the turn finishes or the request resolves.

The UI must remain responsive while the app server delays an interrupt reply.
Prune streaming also becomes cancellation-aware so an interrupted experimental
prune cannot commit a later mutation. Top-level shutdown receives a bounded,
best-effort cleanup path only if a failing test or measured comparison proves a
remaining delay beyond the shared Codex behavior.

## Stage 2: Faster, Safer Change Cycle

### 2.1 One verification entrypoint

Add one repository-owned command that:

- always sets `CODEX_SKIP_BWRAP_BUILD=1`;
- uses a shared target location derived portably rather than committing a
  machine-specific absolute path;
- accepts changed paths or an explicit verification surface;
- prints the commands it selected before running them;
- fails when a requested test filter matches zero tests; and
- maps unknown/shared foundation changes to the conservative full Linux
  verification surface.

The mapping lives in one checked manifest consumed by both developers and CI.
Representative surfaces include documentation-only, dashboard/TUI, context
and compaction, app-server, telemetry, agents/work graph, memory, and full.

### 2.2 CI behavior

GitHub CI calls the same verification entrypoint instead of maintaining a
second hand-written test list. Formatting is check-only in CI and never edits
source. Linux is the required platform for this candidate; no new macOS work is
in scope and macOS does not gate Masih's acceptance.

Cache changes must be justified by recorded restore/save size and timing. This
effort does not begin with a crate split or dependency-graph rewrite. Existing
local build caches are not deleted without separate approval.

### 2.3 Integration ledger

A small coordinator-owned ledger records each candidate worktree's base,
scope, owner, checks, integration decision, and cache ownership. It contains no
transcript and does not replace Git history. The xhigh observability worktree
and its untracked `ES.md` remain untouched until that owner finishes.

## Stage 3: Elpis Control Surfaces

### 3.1 Dashboard job and visual direction

The dashboard's single job is: **show the owner what Elpis is doing now, what it
is carrying forward, and whether intervention is needed.** It is a loopback,
read-only view of the current Elpis process, not an analytics service.

The visual direction is a precise continuity instrument rather than a generic
admin grid. Its signature element is a live **Continuity Spine**: one trace
joining runtime selection, turns, model waits, tools, compactions, pruning,
checkpoints, agent work, failures, and now. Each node represents a real event
and expands to its evidence. The same spine makes latency and agent activity
understandable without requiring the user to read logs. It becomes vertical on
narrow screens; only its live tip may pulse, and reduced-motion preferences
remove that animation.

The default palette follows Elpis's cyan identity without falling into a warm
paper or neon-on-black dashboard template:

- `Ice canvas #EAF4F5` — page background;
- `Clear surface #F8FCFC` — panels and raised regions;
- `Deep ink #102A31` — primary text;
- `Elpis cyan #007C8C` — active/healthy/current state;
- `Signal amber #9A5A00` — experimental, stale, or attention state; and
- `Failure coral #A93645` — failed or destructive state.

An accessible dark theme derives from the same blue/cyan system. Typography
uses `DejaVu Sans Condensed`/`Arial Narrow` sparingly for display labels, the
offline system humanist sans stack for navigation and prose, and the system
monospace stack for identifiers, durations, token counts, and paths. No remote
font, script, analytics, image, or other network dependency is added.

### 3.2 Dashboard information architecture

The responsive page contains:

1. **Now** — running/idle/interrupted state, active runtime/model/reasoning,
   permission mode, current task, elapsed time, last completed event,
   connection freshness, and warnings requiring attention. Above the fold it
   also shows context remaining until native compaction, active/failed agents,
   memory admission, and automatic-pruning state.
2. **Context** — used and usable headroom, the native compaction threshold,
   category/source composition, admitted sources, checkpoints, manual pruning
   evidence, and the visible automatic-pruning experimental state.
3. **Activity** — a bounded current-session history with the Continuity Spine,
   exclusive latency phases, requests/retries, tokens, cached-input share, and
   backend-reported cost only when actually available. Subscription turns say
   `Cost unavailable for subscription authentication`; they never show `$0`.
4. **Agents** — coordinator/worker lineage, current status, task, elapsed time,
   last activity, and failures. This view is read-only and points to `/agent`
   for control.
5. **Work graph** — graph/task status, dependencies, evidence, blockers, and
   recent transition events. It clearly says when the feature is disabled or
   when no accepted graph exists.
6. **Continuity** — `GOAL.md`, `ES.md`, and the canonical
   `~/.elpis/memories/MEMORY.md` location; present/missing and admitted/off
   state; size/limit and age; latest checkpoint status; and the plain statement
   `Manual memory: Elpis reads this file only after you admit it.` Private file
   contents and expanded absolute paths never enter the dashboard.

Useful summaries precede detail. Tables remain available for exact values, but
the page does not lead with a wall of KPI cards. Empty and failure states say
what is missing and what the user can do in Elpis.

### 3.3 Dashboard data and security

Replace the single context-only JSON snapshot with a bounded, per-process
versioned `DashboardState`, carrying `schema_version`, `revision`, and
`generated_at`, assembled from typed runtime facts:

- TUI/session identity and liveness;
- context and token accounting;
- local turn timing summaries;
- optional backend cost observations from the accepted observability branch;
- agent lineage/activity;
- persisted work-graph summaries/events; and
- manual-memory metadata and admission state.

The dashboard receives local turn summaries directly; it does not require or
scrape OTLP. OTLP remains separately opt-in. History is bounded to the current
session and is not a new durable analytics database.

The server binds only to loopback on an ephemeral port, exposes no mutation
endpoint, rejects foreign `Host` values, disables CORS, escapes all dynamic
content through DOM text APIs, sends `no-store`, CSP, `nosniff`, and frame-deny
headers, and performs no external requests. It never exposes credentials,
prompt/message bodies, command output, or account data. Data revision changes
only when facts change; a separate response heartbeat proves the process is
reachable. Idle unchanged state remains fresh, while stale means the heartbeat
expired or the served process/session identity no longer matches. Dashboard
serialization/render failure must never block or fail a turn. Browser-only
controls are limited to pause/resume polling, refresh, filter/sort/search,
expand details, and copy safe IDs, relative paths, or TUI command hints.

### 3.4 Agent handling in the TUI

Reuse `/agent`; do not add another slash command. Split its overloaded content
into clear tabs or modes:

- **Agents** for lineage, activity, transcript switching, and controls; and
- **Work graph** for tasks, dependencies, evidence, blockers, and history.

The Agents view retains selection and Alt+Left/Right navigation and adds direct
follow-up, interrupt, resume, and close actions through a typed app-server
control request. Running-agent interruption/closure requires confirmation.
The server verifies that the target belongs to the active lineage, rejects
closing the primary thread, validates the action against current status, and
does not leave a graph-owned task falsely running. Controls identify their
target thread and never silently act on the coordinator or a different selected
agent. Requests run asynchronously, coalesce duplicate actions, update visible
state only after confirmation, and report server failures without freezing the
TUI.

Resume is available only for ordinary closed lineage agents. A graph-owned
worker cannot be resumed into a terminal graph task. Interrupting or closing a
graph-owned worker must atomically mark its task failed/cancelled and block
descendants under the existing graph rules; otherwise the server rejects the
action visibly. Continuing that work requires a deliberately constructed next
graph.

Work graphs remain explicitly experimental until their functional acceptance
checks pass. The UI may inspect and control an existing graph; a graphical graph
authoring tool and automatic branch/worktree integration are outside this
candidate.

### 3.5 Manual memory UX

This candidate does not restore automatic extraction, consolidation, or
promotion. It makes the current manual contract usable and honest:

- the Context Ledger and dashboard distinguish `missing`, `available but not
  admitted`, and `admitted`;
- when missing, an explicit user action creates the standard `MEMORY.md` file
  and parent directory without admitting it automatically;
- an edit/reveal action uses the existing safe external-editor mechanism when
  available, writes back atomically only after a successful editor exit, and
  otherwise shows/copies the exact path in the TUI;
- admission remains an explicit per-workspace action; and
- the UI shows the current 8,000-character injection limit and never claims the
  entire file reached the model when truncated.

## Data Flow

```text
Codex-compatible core events ─┐
Context and token facts ──────┤
Turn timing / optional cost ──┤
Agent and work-graph state ───┼─> bounded typed dashboard state
Memory metadata/admission ────┘          │
                                         ├─> TUI views and controls
                                         └─> loopback read-only dashboard
```

Controls flow only from the TUI through existing app-server request boundaries.
The dashboard has no reverse control path.

## Integration Order

1. Update the coordinator-owned ignored `TASKS.md` Current Action and keep the
   worktree integration ledger as a table there, not as a second status source.
2. Record branch/worktree provenance and freeze the candidate baseline.
3. Port compaction parity with failing-first tests.
4. Port nonblocking interrupt behavior and cancellation tests.
5. Add automatic-pruning visibility while keeping its default off.
6. Add the shared verification entrypoint/manifest and make Linux CI consume it.
7. Confirm the already-reviewed model/login/salvage candidates represented by
   the baseline; import any missing owner-approved commits in dependency order
   without rewriting them.
8. Integrate the observability branch only after its owner finishes and its
   focused checks are accepted; preserve its untracked `ES.md`.
9. Add the typed agent-control authority layer, then split and extend the TUI
   agent/work-graph surface.
10. Add the honest manual-memory status type and create/edit/admission UX.
11. Introduce the typed dashboard state, wire the approved runtime facts, and
    implement the useful dashboard views against frozen fixtures.
12. Run GitHub verification, build a candidate artifact, then perform the final
    local candidate build and side-by-side acceptance.

Each stage is committed separately with dependencies recorded. Reverting a
foundation stage also reverts its dependent stages.

## Failure Behavior

- Native compaction failure follows Codex's existing visible error path.
- Manual or automatic prune failure leaves the pre-prune history authoritative
  and records no successful prune mutation.
- Interrupt, agent-control, dashboard, cost, graph, and memory-display failures
  never block the core event loop.
- Stale or missing dashboard facts show `Unavailable` with a reason.
- An unknown verification surface selects broader checks rather than silently
  skipping them.
- Any branch conflict involving the observability owner's live work pauses only
  that integration slice; it does not justify editing the owner's worktree.

## Verification and Acceptance

### Automated source/unit checks

- Codex and Elpis context-window fixtures resolve the same automatic-compaction
  threshold and usable ceiling for default, model-specific, explicit-override,
  unknown-window, and scoped-accounting cases.
- A delayed `turn/interrupt` RPC does not block subsequent UI events; duplicate
  Ctrl-C events coalesce and pending state clears.
- An interrupted pruning stream cannot commit a later history mutation.
- Automatic pruning is default-off, visible in `/settings`, marked
  `Experimental`, and persisted only after explicit enablement.
- `/prune` remains available and independent of that setting.
- Dashboard JSON/page tests cover live refresh, pause/resume, bounded history,
  stale/empty/unavailable states, measured-versus-estimated labels, escaped
  dynamic strings, rejected foreign hosts, loopback-only serving, security
  headers, responsive layout hooks, keyboard focus, and reduced motion.
- Masih reviews light, dark, wide, and narrow rendered dashboard views and
  confirms that the first screen clearly answers what is running, whether it is
  healthy, what needs attention, and how much context remains. DOM and snapshot
  tests cannot accept visual quality.
- Agent controls target the selected child, require confirmation where stated,
  remain nonblocking, and surface failures.
- Memory reaches a model request only when admitted; create does not imply
  admission; missing and truncated states are truthful.
- Verification-manifest consistency tests reject unknown omissions and
  zero-match filters.

### GitHub evidence

- Focused checks run for each stage through the shared manifest.
- The final combined candidate passes the required Linux matrix and produces a
  separately named candidate artifact.
- Cache timing/size evidence is recorded before any cache-policy claim.
- No release, tag, `main` merge, or normal-install step occurs.

### Side-by-side candidate evaluation

Compare current Codex and `elpis-candidate` using two identical disposable
Linux workspace copies from one pinned fixture. Restore the fixture before
every run, alternate arm order, use clean separate state directories, pin both
commit identifiers, match model/reasoning/permissions and prompts, and
normalize only expected product-name and Elpis-feature additions:

- startup and clean exit;
- login status and model/reasoning selection;
- ordinary turn, command/tool execution, file edit/diff, and approval flow;
- manual `/compact` and threshold behavior;
- Ctrl-C during a delayed active turn and repeated Ctrl-C;
- session resume;
- manual `/prune` plus automatic-pruning off/on visibility;
- dashboard freshness and accuracy;
- agent spawn/switch/follow-up/interrupt/resume/close;
- work-graph inspection and evidence; and
- memory missing/create/admit/recall/truncation behavior.

Automated comparison records observable differences, timing, logs, and exit
status. It does not infer superior coding quality from one model response.
Direct non-tmux PTY comparison runs each interrupt/exit state five times; a
healthy Elpis median must remain within 250 ms of Codex and no healthy exit may
exceed three seconds. Any unexplained behavioral difference remains a failure
until reviewed. Timing starts when the PTY writes Ctrl-C and ends when the
process exits after restoring the terminal. A healthy exit has no deliberately
stalled test server, returns success or the same intentional interrupt status
as Codex, restores the terminal, and leaves no child process alive.

Every important workflow listed above remains unaccepted until Masih performs
it directly. Automated comparison is preflight evidence only. Visual,
interaction, authentication, compaction, pruning, interrupt, agent, graph,
memory, and ordinary Codex-parity behavior all require Masih's manual
acceptance.

## Completion Boundary

The engineering candidate is ready for Masih only when the combined branch has
the required GitHub evidence, the separately named local binary is built after
all known implementation issues are closed, and the comparison checklist is
prepared. The work is not released or accepted until Masih manually verifies
the important features and explicitly says so.
