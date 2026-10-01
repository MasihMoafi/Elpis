# Spec: agents panel and work graphs on elpis-next

Date: 2026-10-01. Source: v0.3.0 (`stage0-stop-bleeding`), copied verbatim; only call sites change.

## What you get

- The model can hand a job to several agents as one plan (a work graph). Elpis checks the plan
  (Kahn's algorithm: no cycles), runs each task only when its prerequisites succeeded, never lets
  two agents write the same files at once, and requires a verifier with evidence before a task
  counts as done. A failed task stops everything that depends on it.
- `/agent` shows the graph: each task with ✓ / ✕ / ● and its summary, changed files, checks.
- The Context Ledger's SUBAGENTS switch (`s`) and the live list of running subagents.

## What is ported

| Part | v0.3.0 source | Size |
| --- | --- | --- |
| Engine and tools (`run_agent_work_graph`, `report_agent_work_task`) | `core/src/tools/handlers/work_graphs*.rs` | ~2,000 lines |
| Storage, in its own file `work_graphs_1.sqlite` (never Codex's database) | `state/src/runtime/work_graphs.rs`, `model/work_graph.rs`, 2 migrations | ~1,500 |
| `workGraph/list` request | `app-server-protocol/.../work_graph.rs` + handler | ~150 |
| Panel | `tui/src/multi_agents.rs` (graph cell), Ledger subagent rows | ~300 |

## Acceptance (each with a case that must fail)

1. A 3-task graph with A → B runs B only after A succeeds. A cycle is rejected before any agent starts.
2. Two tasks writing the same folder never run together; tasks on separate folders do.
3. A failed task blocks its dependents; their agents are never started.
4. `/agent` shows the graph with per-task status. With the feature off, the model is never offered the tool.
5. SUBAGENTS off in the Ledger: the model cannot spawn an agent. On: it can, and the Ledger lists it live.
6. You: ask elpis-next for a small fan-out job and watch `/agent`.

Tests 1–5 run on fake providers. Estimate: 2–3 working days.
