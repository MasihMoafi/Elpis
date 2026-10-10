# Continuity and Codex workflows — October 10, 2026

Masih requested all three overview improvements and any missing Codex review/worktree workflows. Preserve the installed candidate's upstream Codex 0.162.0 behavior and reuse its implementations.

## Acceptance
- `/review` and `/worktree` are discoverable and use the inherited menus, tools and execution paths. The ordinary launcher supports the same worktree lifecycle. Preserve unrelated command choices and never push or delete user work as a side effect.
- Changing admitted rules, memory or files reaches the next Claude/Gemini bridge turn. Unchanged context reuses its session. Failed instruction RPCs never silently substitute empty/stale context. Changes do not mutate an in-flight request. Existing native handling of missing optional files remains unchanged.
- Each thread retains its own goal/checkpoint across concurrent turns, interruption, saving and resume. Another thread cannot replace or silently inherit it. Existing workspace files remain intact; legacy recovery must verify ownership. Intentional handoff remains explicit.
- One current project pointer identifies the active source, installed artifact and status record. Legacy checkouts point there without losing unrelated work or rewriting historical acceptance.
- Each behavioral correction has a failing control and a passing focused test. Run relevant integration checks and inspect changed UI before claiming readiness.

## Plan and boundaries
1. Reproduce the continuity failures and check existing upstream workflows.
2. Implement bridge refresh and thread isolation in separate worktrees. Restore upstream workflow access and repair project orientation.
3. Integrate, run focused checks and prepare a reviewable local candidate with rollback. Record actual checks and gaps.

No new desktop app, unrelated feature restoration, provider calls, publication or real-chat migration/deletion is included. Masih authorized a dedicated GitHub validation branch, Actions checks and artifact downloads on October 10. Do not infer that an existing review/worktree implementation is absent. Use bounded local builds; one compiler owner. Ask only if the upstream behavior needs unavailable proprietary code or a material product choice.
