# Elpis Worktree Integration Ledger

Last source audit: 2026-09-02. Coordinator branch: `integration/elpis-stable`.

This ledger records local integration decisions. It is not release evidence, does not replace Git history, and does not authorize deleting a worktree. `patch-equivalent` means `git rev-list --cherry-pick` found no distinct patch at the recorded audit point; it does not mean the branch can be deleted.

| Branch | Audited head | Relation to coordinator | Decision |
| --- | --- | --- | --- |
| `main` | `34bd4ab` | ancestor | Foundation is already contained. Do not move local `main` until the complete candidate passes its final local checks. |
| `fix/openai-model-reasoning-picker` | `265e14f` | ancestor | Contained; preserve its subscription model/reasoning behavior. |
| `fix/model-selection-atomicity` | `0ca47c4` | ancestor | Contained; preserve provider-catalog atomicity. |
| `fix/elpis-salvage-candidate` | `72c2a5d` | ancestor | Candidate foundation is contained. |
| `feat/turn-observability` | `fef746e` | patch-equivalent | Six distinct commits were reviewed and replayed as `5f0f413..5689108`. The owner worktree and its untracked `ES.md` remain untouched. Timing/cost facts now have a bounded current-session Activity surface in `/dashboard`; real subscription and Masih acceptance remain pending. |
| `docs/manual-memory-contract` | `727ab12` | patch-equivalent | Already absorbed by equivalent commit `c7ce762`; do not merge the branch. |
| `fix/manual-only-pruning` | `04916f0` | patch-equivalent | Already absorbed by equivalent commit `c1e581f`; manual pruning remains independent and automatic pruning stays off by default. |
| `fix/work-graph-sandbox-eval` | `ddda270` | patch-equivalent | Already absorbed by equivalent commit `d74f989`; retain the experimental boundary. |
| `agent/continuity-repair` | `342e917` | patch-equivalent | Already absorbed by equivalent commit `fe3839f`; do not merge the branch. |
| `agent/auto-model-routing-intent` | `0484215` | one distinct patch | Deferred. The distinct patch changes `/auto` policy, which is not required for Codex parity and could conflict with the verified picker behavior. |
| `agent/candidate-portable-checkpoint` | `1730ac2` | one distinct patch | Rejected for integration. It only seeds an evaluation prompt and is not a product feature. |
| `docs/evaluation-status` | `6307fed` | two distinct documentation patches | Deferred for selective documentation review; do not merge stale or claim-changing documentation wholesale. |
| `eval/rq3-*` | `51de0a2` / `1a722a4` | historical evaluation heads | No product integration. RQ3 remains unestablished; these branches are evidence/history only. |
| `feat/smart-prune-admission` | `d2da5b6` | selectively integrated | Admission-time Smart Prune is integrated into `integration/elpis-stable` with coordinator adaptations, including browser-safe revisioned dashboard evidence. Automatic history rewriting remains removed, manual `/prune` remains, and Smart Prune stays Experimental and off by default. Linux candidate CI, install, restart, and Masih acceptance remain pending. |

## Final integration boundary

- No push, tag, hosted release, version bump, worktree deletion, or process restart.
- Keep the installed debug binary unchanged until all selected functional work and final local checks are complete.
- Then advance local `main` to the exact reviewed coordinator commit, build one optimized artifact under `docs/LOCAL_BUILD_RULES.md`, install it atomically as `elpis`, retain a recoverable copy of the replaced binary, and prove the installed artifact hash matches.
- Automated evidence does not equal user acceptance. Masih performs the final manual checklist.
