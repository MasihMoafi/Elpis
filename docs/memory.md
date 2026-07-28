# Elpis Memory Architecture

Elpis uses curated, size-bounded local memory to preserve recurring project knowledge and user preferences across sessions—without turning past conversation history into prompt baggage.

---

## 1. Overview & Core Philosophy

In Elpis, **durable memory is distinct from session transcripts**. While raw transcripts remain intact on disk as exact evidence, active context is kept small. 

- **Memory is curated:** Only stable project facts, user preferences, standing decisions, and proven procedures enter long-term memory.
- **Memory carries provenance:** Every entry records its source thread and context.
- **Recall is a discovery aid:** Historical memory entries are treated as hypotheses. If a fact can drift or change, Elpis verifies it against the current workspace before relying on it.

### What you control

Memory is on by default, and it is yours to switch off. Three independent controls govern it, all reachable from `/memories` in the TUI:

| Control | Config key | Default | Effect when off |
| :--- | :--- | :--- | :--- |
| Memory subsystem | `features.memories` | on | Nothing is extracted, consolidated, or recalled. The pipeline below never starts. |
| Recall | `memories.use_memories` | on | Memory instructions are not injected into prompts; stored memory is not consulted. |
| Writing | `memories.generate_memories` | on | New threads are recorded as `memory_mode = "disabled"` and never become memory candidates. |

Two further guarantees hold regardless of those settings:

- **The agent has no memory-write tool.** Dedicated memory tools are gated behind `memories.dedicated_tools`, which defaults to off. `MEMORY.md` is written by the phase-2 consolidation pass described below, not by the agent you are talking to.
- **Nothing is deleted without a trace.** Faded and removed entries append to `archive.md`, and if that write fails the operation is aborted rather than completed.

---

## 2. Two-Stage Memory Pipeline

Memory processing in Elpis operates in two distinct background stages:

```text
[Turn Rollout / Transcript]
           |
           v
   [Stage 1 Extraction] --------> Stores stage1_outputs & tracks recall queries
           |
           v
 [Phase 2 Consolidation] ------> Distills qualified items into MEMORY.md (6h cooldown)
```

1. **Stage 1 (Extraction — `memory_stage1`):**
   - Extracts candidate memory items from raw thread rollouts.
   - Stores normalized outputs in `stage1_outputs`.
   - Tracks `usage_count`, `last_usage` timestamps, and `stage1_recall_queries` `(thread_id, query_key, recalled_at)` to measure recall frequency and query diversity.

2. **Phase 2 (Global Consolidation — `memory_consolidate_global`):**
   - Attempts to run on each session launch, and stops immediately unless every condition
     holds: no other run holds the lock, the last success finished more than 6 hours ago,
     and the candidate set has actually changed since the last run. In practice this is a
     few times a day at most, never mid-turn.
   - Loads up to 256 candidates, dropping any not recalled in 30 days, and writes them into
     the memory workspace as `raw_memories.md`.
   - Hands a second Elpis — sandboxed to the memory directory, no network, no memory tools
     of its own — the diff of what changed, and asks it to decide what belongs in
     `MEMORY.md`. That agent edits the files; the pipeline only commits the result.

### What the consolidation agent decides on

Promotion is a judgment call, not a threshold. Each candidate carries
`recall_evidence: repeated | some | none` — how often it has already been searched for —
and the agent weighs it as evidence rather than permission. `repeated` argues strongly for
promotion; `none` disqualifies nothing, since a standing preference stated once is durable
while a twice-recalled impression is not. The instructions ask for stable project facts,
user operating preferences, recurring corrections, repo maps, tooling quirks, and proven
reproduction plans — and explicitly reject generic advice, secrets, verbatim output, and
one-off exploratory discussion. The size cap on `MEMORY.md` bounds the result: near the
limit the agent must remove stale or weakly supported material before adding more.

This replaced an arithmetic gate that required three recalls across two distinct query
contexts. On real usage nothing ever cleared it, so durable memory stayed empty while
candidates accumulated. Judgment now sits with an agent, as it does for context pruning.

---

## 3. Data & File Layout

Elpis memory state is strictly separated from upstream runtime state and stored under `~/.elpis/`:

| Path | Purpose | Behavior |
| :--- | :--- | :--- |
| `~/.elpis/memories/MEMORY.md` | Curated durable long-term memory. | Injected into session bootstrap (subject to token budget cap). |
| `~/.elpis/memories/archive.md` | Searchable append-only archive. | Receives deleted or age-faded memories prior to baseline reset. Fail-closed on write error. |
| `~/.elpis/state/memories_1.sqlite` | SQLite state database. | Stores `stage1_outputs`, `stage1_recall_queries`, job queues, and promotion metadata. |
| `~/.elpis/context/workspaces/<workspace>/GOAL.md` | Active goal checkpoint. | Survives restarts, model switches, and thread compaction. |
| `~/.elpis/context/workspaces/<workspace>/ES.md` | Session checkpoint, rewritten after each completed turn. | Records the turn's latest result, changed files, and commands run. See [Sessions](sessions.md). |

---

## 4. Provenance & Live Workspace Re-Verification

Memory in Elpis is not treated as undeniable truth:

- **Provenance:** Every recalled memory item retains its original source attribution (`thread_id`, timestamp, query key).
- **Workspace Re-Verification:** When an entry describes workspace state (e.g., file paths, build flags, dependencies, or function signatures), Elpis treats the memory entry as a *discovery pointer*. Before making changes based on a recalled memory, Elpis inspects the live workspace to confirm the fact remains true.

---

## 5. How Memory Fits the Context Lifecycle

Memory fits into a strict 3-tiered context lifetime model:

```text
Lifetime        Scope                    Examples
--------------------------------------------------------------------------------------
durable         Global rules & memory     AGENTS.md, GOAL.md, MEMORY.md
task            Active thread state       ES.md, decisions, changed paths, verification
turn            Transient exploration     File reads, rg outputs, command execution
```

- **Post-Turn Pruning (Ace):** After a turn finishes, transient `turn`-level exploration (searches, directory listings, raw command outputs) is pruned from the next request, leaving only compact conclusions and evidence pointers. See [Context](context.md).
- **Independent of compaction:** Memory extraction reads completed rollout transcripts from disk, so it neither runs at compaction time nor depends on it. Transcripts are already durable evidence by the time stage 1 sees them.
- **Fail-Closed Archive Reset:** When resetting or pruning memory baselines, faded entries must append to `archive.md`. If the archive write fails, the reset is aborted to prevent data loss (`codex-rs/memories/write/src/workspace.rs`).

---

## 6. Inspection & Verification

You can inspect and verify memory behavior using the following surfaces:

1. **Context & Memory Usage:** Run `/usage` in the TUI to see currently admitted memory sources, byte sizes, and reasons.
2. **Context Ledger:** The ledger sidebar is shown by default and toggles with `Tab` or `Alt+C`. It lists live admitted portable context sources (`GOAL.md`, `ES.md`, `MEMORY.md`, and active rule files).
3. **Database Audit:** Inspect `~/.elpis/state/memories_1.sqlite` using SQLite:
   ```sql
   SELECT thread_id, usage_count, datetime(last_usage, 'unixepoch') FROM stage1_outputs;
   SELECT thread_id, query_key, datetime(recalled_at, 'unixepoch') FROM stage1_recall_queries;
   ```
4. **Archive Safety:** Inspect `~/.elpis/memories/archive.md` to review historical faded or deleted memory entries preserved prior to baseline resets.
5. **Promotion History:** `~/.elpis/memories/` is a git repository, and every consolidation
   pass that changes anything commits there. `git log -p` in that directory is the complete
   record of what the consolidation agent promoted, reworded, or removed, and when. A
   repository holding only its initial baseline commit means nothing has ever been promoted.
