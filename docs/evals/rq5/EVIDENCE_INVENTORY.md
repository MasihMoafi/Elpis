# RQ5 Evidence Inventory: Auditability & Provenance

## Existing Evidence Inventory

| Auditability Dimension | Current Status | Existing Artifacts / Log Location | Description |
| --- | --- | --- | --- |
| **Pruning Trigger / Time** | Partial | `elpis-pruning-cache-investigation.zip`, `elpis-single-prune-validation-v2.zip` | Timestamps and trigger thresholds recorded in stdout debug logs during prune execution. |
| **Selected Material** | Complete | Session JSONL transcripts (`transcript.jsonl`) | Kept context items, system prompts, pinned messages clearly visible in context payload. |
| **Removed / Replaced Material** | Complete | `elpis-single-prune-validation-v2.zip`, `transcript_full.jsonl` | Diff between pre-prune and post-prune message arrays captured in validation logs. |
| **Reclaimed Tokens** | Complete | `paper.zip`, `final-rq1-rq4-data` | Token count deltas before vs after pruning events logged per session step. |
| **Ace Model Usage** | Complete | Server / Proxy logs, session cost summaries | Record of sub-call API requests for memory extraction / summarizing models. |
| **Replacement History** | Partial | `docs/sessions.md`, session history files | State updates and summary replacement events stored in session state files (`~/.elpis/sessions/`). |
| **Context Trajectory** | Complete | `elpis-rq1-rq4-analysis.html`, `elpis-rq4-final-forensics.zip` | Per-step context size trajectory tracking over long-horizon runs. |
| **Compaction** | Complete | `cache-friendly-pruning.md`, pruning benchmark data | Compaction ratio and message collapsing metadata preserved. |
| **Session Provenance** | Partial | Session metadata headers (`~/.elpis/sessions/*.json`) | Recorded session ID, timestamp, initial parameters, commit hash. |

---

## Identified Evidence Gaps

1. **Standardized Replay Log Format**: Lack of unified, single-file schema combining raw API payloads, pruning decisions, and token reclaim metrics into a single auditable JSON document per run.
2. **Deterministic Provenance Verification**: Provenance metadata does not currently include installed binary SHA256 checksum in every session JSON file header.
3. **Structured Audit Viewer**: Existing visualization HTMLs (`elpis-rq1-rq4-analysis.html`) focus on cost/cache rather than explicit audit inspection of pruned vs retained items per turn.

> **Directive**:
> Worktree `~/Desktop/p/elpis-rq5-final` is designated for **EVIDENCE CONSOLIDATION ONLY**. No new expensive live experiments are permitted unless existing log evidence is audited and proven insufficient.
