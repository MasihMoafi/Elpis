# Mother handoff — Elpis, 27 October 2026

**Latest instruction: leave the whole-project handoff, including obsolete worktrees. Implementation and installation work stopped for that handoff. The latest candidate is not installed or release-ready.**

## Project and source of truth
Elpis is a Linux desktop app and Codex-derived TUI sharing one engine and `~/.elpis-next`. It preserves goals, admitted context, permissions and evidence across providers. Read VISION.md, docs/GUIDE.md, docs/USER_REQUESTS.md and apps/elpis-desktop/SPEC.md. The guide’s older TUI-only wording is historical; the desktop is the immediate user-facing priority. SPEC’s C1–C14 table is the current completion checklist; older paragraphs and ES.md entries are historical when they conflict with later user corrections. Only Masih accepts daily-use quality.

| Area | Owner / boundary |
| --- | --- |
| Engine, TUI, native agents, models and sessions | `codex-rs/`; shared terminal behavior follows docs/specs/codex-parity.md. |
| Native windows, browser, IPC and storage | `apps/elpis-desktop/desktop/`; Electron44. |
| Chat, recursive sidebar, composer, files and panels | `apps/elpis-desktop/app/page.tsx`, `components/`, `lib/`; Next16/React19 static export. Follow DESIGN.md, shared shadcn/Base UI components, globals.css tokens and elpis-icons.tsx. |
| Providers, settings, documents and runtime boundary | `apps/elpis-desktop/bridge/`; adapters in `tools/elpis-claude/`. Credentials stay out of renderer/logs. |
| Board workflows | agents-canvas.tsx, workflow-chat.tsx, workflow-progress.tsx; bridge/workflow-acp.mjs. |
| Script workflows | tools/elpis-claude/workflow-runner.mjs and companions. **A separate runner still exists.** SPEC WR8 unification is proposed, not implemented here. |
| Love Spot/Matilda, Ledger, pruning and RAG | Existing desktop/bridge/engine owners. Separate unfinished input, runtime state and admitted context. Pruning/work-graph quality remains experimental. |
| Website and writing | `website/` ships separately. Preserve another effort’s untracked docs/readme-draft.md; its story/README planning is unfinished. |

## Where to work and what is actually installed
- Canonical checkout: `/home/masih/Desktop/p/Elpis-wt-install`, branch **build/integrate-20261024h**. `/home/masih/Desktop/p/Elpis` is the stale original checkout. Discover future integration lines with `git -C ~/Desktop/p/Elpis worktree list | rg integrate`.
- Selected GUI: **53e83a0b41bdd3a411cc560a3b4d9878871354f3**, bundle `~/.local/lib/elpis-desktop/versions/gui-20261027-message-fold-scroll-53e83a0b4`; launcher `~/.local/bin/elpis-app`. No user window was restarted.
- Selected TUI: `~/.local/lib/elpis-next/versions/engine-20261027-d2603c311-91e65c75/package/bin/codex`. `~/.local/bin/elpis` is a wrapper with REAL=. Its source branch fix/fast-live-check-20261025 has separate history; preserve it.
- Latest runtime/test checkpoint: **f007653072052c2e3200526473359d731bbe82cd**, built/typechecked in `/home/masih/Desktop/p/.worktrees/Elpis-gui-20261027-package` at that detached commit. Export is **unstamped**. Later handoff commits contain documentation only; never install this candidate as verified yet.
- Uncommitted: my one-line globals.css section-heading margin correction is unbuilt/unchecked. Foreign acp-bridge.mjs, agy-acp.mjs, their test, caches and review/readme artifacts pre-existed. Inspect git status; do not blanket stage/revert them.

## Newer source, not installed
0223410b1 adds selected Claude MCP preview/import with no secret-bearing preview/overwrite. 2aaec028f fixes literal weekly-limit fallback, verifier/merge supervision, recursive/next-stage guards and cancelled Resume. 1918fa5f3 plus 8c2b07836 add meaningful low-effort subscription Mother reviews, serialized bounded decisions, real summaries across chat/Flat/Isometric and stale/completed/manual-steer dispatch guards.
c5e2a69fc adds explicit Auto/manual planning and native Browser settings; a manual dependency redesign is refused without replacing the board. 4888c4c4f hides unreliable read aloud in ordinary/Love Spot chats with zero warming; realtime Voice/dictation remain separate. 24fb6fb07 plus 1c38728ed address Settings density, interrupted request editing, duplicate colour, dot hover and browser fallback navigation. ac98300ec plus dce66fe44 repair valid workflow fixtures and failed-startup cleanup. Everything is local; no push/release occurred. All delegated workers are complete; no owned build/test job remains. Do not reapply the earlier palette-button proposal: the later right-click row tint correction superseded it.
Installed53 already contains long-message folding/full Copy/reading-position preservation, mini chat/mute, right-click row tint, /clear and /resume, HTML/large-file review, compact composer, browser selection/close/popup fixes and earlier workflow repairs. Regression-check these on the eventual combined candidate; do not infer all later requests are finished.

## Evidence and the immediate blockers
- Evidence directory: `/home/masih/Documents/Codex/2026-10-25/hi/work/`. Installed proof: collapse-installed-proof.json; native recordings/results: native-collapse-final/ and native-mini-review/ (inspected frames).
- **46/46** workflow/ACP checks pass in `/tmp/wf-active-owner-final.tap`, with pre-fix failures. These use fake ACP, including real dispatch-boundary races; they are not live inference proof.
- completion-final-build.log passes at f007; completion-fixed.tap is **8 pass /3 fail**. Last isolated diagnostic passes the complete Settings style sweep, so its earlier narrow opener failure appears to be initial hydration timing. Preserve native/browser coverage and wait for actual ready navigation.
- **Canvas failure:** after note/Undo, a connector lies above the ReactFlow viewport under `.canvas-telemetry`. Last dot centre y320.9; viewport begins326.1; hit target is telemetry. Fix layout/viewport preservation or fitting when telemetry height changes. Larger hit rings did not solve it. See last-geometry-diagnostic.tap and canvas-hit-diagnostic.cjs.
- **Settings760px failure:** navigation775px in 724px available. The uncommitted section-heading margin change targets inherited margins; rebuild/verify it. Never conceal clipped destinations. At 540px retain a reachable fallback. 2048×1159 and 1280×900 passed onf007.
- completion-final-checks.sh stops after those failures; its retained second phase **did not run**. No final package/hash/install/native-video check, real shadcn import or live subscription Terra child has run forf007. Cache/source support 6.1 Terra; emitted schema/account execution remains unchecked. Prepared record-native-completion.cjs and import-real-shadcn.mjs have not run.
- Supporting requests: 24 renamed screenshots exist (screenshot-renames.json); shared web-dev skill carries dismissal/focus/selection/creation rules. Original Codex-contribution request was not located; only the 26 Oct follow-up in this chat was confirmed. Langfuse/observability remains deferred.

## Worktrees and safety
Read **docs/HANDOFF-WORKTREES.json**:48 checkouts, branches/heads, integration ancestry, dirty/untracked paths and process hints. Twelve heads are integrated; 39 checkouts have dirty/untracked material. Only **elpis-bisect, elpis-gate-11 and elpis-gate-5** were clean, integrated and without a process cwd: retirement candidates, not confirmed abandoned. Nothing was deleted. elpis-live-chat is integrated but has artifacts; elpis-matilda-top has one unmerged commit; the installed TUI line has separate history and dirty bridge work. Ancestry does not establish cherry-pick equivalence; compare before discarding. Cherry-pick intended commits between divergent histories, never merge them blindly.
Read global user rules, docs/LOCAL_BUILD_RULES.md and docs/SHIPPING_RULES.md; current user rules override old local Cargo/removal recipes. GUI: one local nice -n 19 job, New Volume cache, resource guard, no Bloodborne (`ps -eo args | rg -c '[B]loodborne'`, not pgrep). Rust/TUI/heavy matrices: Actions. No full-suite rerun, new paid/API-key route, default-branch/tag push or release. Use gio trash; preserve other work; never restart Masih’s app. Standard installer only, forward lineage; retained baseline stays 988aad0e78bd264c00e435be07598e79f08941e8. Pin authorized owner changes, do not weaken assertions.

**Next action:** reproduce the telemetry/viewport overlap with the existing owner, finish Settings fit, then run only those failures and the remaining targeted journeys. After passing: frozen clean build, exact source/hash proof, forward installation and native visual review. Reconcile every C1–C14 row. No redesign, observability project, runner unification or broad cleanup before these blockers.
