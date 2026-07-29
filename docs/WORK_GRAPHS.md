# Deterministic Work Graphs

Status: implemented behind the under-development `enable_fanout` feature;
agent-verified on Linux; awaiting Masih's functional acceptance.

## Objective

A work graph puts agents in a position where they only need to do bounded judgment:
Elpis validates the plan, persists it, selects dependency-ready work, enforces
concurrency and write boundaries, and accepts evidence before releasing dependent work.

This is separate from the existing agent lineage graph:

- the **lineage graph** records which agent spawned which subagent;
- the **work graph** records tasks, dependencies, scopes, assignments, and outcomes.

The work graph is a directed acyclic graph (DAG). A cycle cannot be scheduled because
each task would wait for another task in the same cycle, so Elpis rejects cycles before
creating workers.

## Graph theory boundary

Elpis uses the smallest graph algorithms that match the control problem:

- Kahn's topological algorithm validates that the task graph is acyclic.
- A stable dependency-ready scan chooses runnable tasks in declared order.
- Path-prefix intersection detects concurrent write conflicts.

DFS and BFS are alternative ways to traverse a graph, but do not improve this
scheduler's decision. Dijkstra's algorithm solves weighted shortest-path problems; a
work graph has prerequisites rather than a destination and weighted routes, so Dijkstra
does not apply unless a future product requirement introduces meaningful task costs and
alternative paths.

## Enable and use

The feature is intentionally off by default:

```toml
[features]
enable_fanout = true
```

There is no slash command. When enabled, the coordinator model receives the
`run_agent_work_graph` function tool. It supplies the complete graph:

```json
{
  "name": "bounded change",
  "max_concurrency": 2,
  "max_runtime_seconds": 1800,
  "tasks": [
    {
      "id": "foundation",
      "title": "Build the narrow foundation",
      "instruction": "Implement the bounded behavior and run its focused checks.",
      "depends_on": [],
      "write_scopes": ["codex-rs/state"],
      "acceptance_criteria": ["focused state test passes"],
      "environment_id": "primary"
    },
    {
      "id": "consumer",
      "title": "Use the accepted foundation",
      "instruction": "Implement only the consumer.",
      "depends_on": ["foundation"],
      "write_scopes": ["codex-rs/core"],
      "acceptance_criteria": ["focused core test passes"],
      "environment_id": "consumer-worktree"
    }
  ]
}
```

`environment_id` must name an environment already selected for the turn. Elpis does
not create, merge, rebase, delete, or push branches or worktrees. Preparing and
integrating worktrees remains coordinator-owned because those operations change durable
user state and need deliberate review.

## Deterministic engine rules

Before dispatch, Elpis rejects:

- empty graphs, duplicate or malformed task IDs, unknown or repeated dependencies;
- self-dependencies and dependency cycles;
- absolute, empty, or escaping write scopes;
- unknown selected environments;
- zero concurrency or runtime limits.

At runtime:

1. Tasks are persisted in declared order.
2. Only pending tasks whose dependencies all succeeded are eligible.
3. Eligible tasks are selected in declared order, then task-ID order.
4. Tasks with overlapping path prefixes in one environment are serialized.
5. The same paths may run concurrently only in different selected environments.
6. Concurrency is bounded by the requested limit and the session agent limit.
7. A failed, cancelled, or blocked prerequisite blocks its pending descendants.
8. Each task has a runtime deadline; a worker that exits without an accepted report
   fails the task.
9. Cancellation shuts down active workers and terminally records the graph.

These rules make dispatch repeatable for the same persisted state. Model completion
time is not deterministic, but it cannot make an ineligible task runnable or bypass a
scope conflict.

## Worker authority and evidence

Each worker receives:

- one task, one selected environment, exact write scopes, and acceptance criteria;
- accepted prerequisite result and evidence;
- only the worker report tool from the work-graph tool pair;
- no collaboration tools with which to create subagents.

The engine derives a managed permission profile for every worker:

- the filesystem is readable;
- only declared repository-relative scopes are writable;
- an empty scope list is read-only;
- network access is restricted.

The child profile cannot broaden the parent profile: parent read denials survive and a
declared write scope must already be writable by the coordinator's active profile.
Windows-style absolute paths, Git metadata paths, and scopes whose existing prefix
resolves through a symlink outside the selected workspace are rejected.

This is enforced by the sandbox, not only by the prompt. A successful
`report_agent_work_task` is accepted only from the assigned thread, must include
concrete evidence, and may not declare a changed file outside its scopes. The report
stores summary, changed files, checks, risks, evidence, and failure reason.

Elpis validates the report's authority and structure. It does not independently prove
that a worker's prose is true; coordinator review and Masih's acceptance remain
required.

## Persistence and interruption

SQLite stores:

- graph identity, root thread, status, limits, timestamps, and final error;
- task order, instruction, dependencies, scopes, criteria, environment/workspace,
  assigned thread, attempts, result, evidence, and failure;
- an append-only transition event trail.

If a coordinator is interrupted and the same root thread starts another work graph,
Elpis first fails that root's unfinished graph and all unfinished tasks. It never
silently requeues an old active claim, so two workers are not deliberately assigned the
same persisted task. It does not resume partially completed work automatically: the
coordinator must inspect accepted evidence and deliberately construct the next graph.

## Verification

Automated coverage proves:

- acyclic persistence and cycle/unknown-dependency/path-escape rejection;
- stable dependency-ready selection and same-environment conflict serialization;
- authenticated reports and evidence persistence;
- interrupted-graph failure without requeue;
- successful dependency handoff;
- prerequisite failure blocks a descendant without spawning it;
- on Linux, a real worker command cannot write outside its declared scope.

These checks are agent verification. Functional acceptance remains with Masih.
