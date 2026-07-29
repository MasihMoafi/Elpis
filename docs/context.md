# Elpis Context Sovereignty & 3-Layer Pruning Pipeline

Elpis enforces **Context Sovereignty**: the principle that context is a strictly budgeted working set, not a dumped chat transcript. The user maintains live visibility and explicit control over every byte admitted to the agent's context window.

---

## 1. Systemic Role in Elpis

Context management acts as the primary gatekeeper between raw workspace/session events and the active model inference loop:

```text
[User Prompt / Task Input]
           |
           v
+----------+-------------------------------------------------------+
|                 ELPIS CONTEXT ADMISSION GATE                     |
|  - GOAL.md (Active Goal)       - ES.md (Executive Summary)       |
|  - MEMORY.md (Curated Facts)   - AGENTS.md / Skill Rules         |
|  - Context Ledger Selections   - Admitted @file references       |
+----------+-------------------------------------------------------+
           |
           v
+----------+-------------------------------------------------------+
|                    3-LAYER PRUNING PIPELINE                      |
|  Layer 1: RTK Shell-Output Filter (Pre-model command rewrite)   |
|  Layer 2: Deterministic Safety Cap (Upper bound truncation)     |
|  Layer 3: Ace Pressure Pass (60% trigger, ~50% target)            |
+----------+-------------------------------------------------------+
           |
           v
+----------+-------------------------------------------------------+
|                 MODEL INFERENCE (Selected Provider)              |
+------------------------------------------------------------------+
```

---

## 2. The 3-Layer Pruning Pipeline

Long agent sessions accumulate dead ends, voluminous search results, and repetitive file reads. Elpis separates **working context** from **durable evidence**.

```text
[Raw Tool / Terminal Output]
           |
           v
[Layer 1: RTK Filter]          -> Pre-model: compacts verbose CLI output (rg, find).
           |
           v
[Layer 2: Safety Cap]          -> Pre-model: Hard deterministic upper-bound truncation.
           |
           v
[Active Agent Turn Execution]  -> Tool outputs remain verbatim during active turn.
           |
           v
[Layer 3: Ace Pressure Pass]   -> Between follow-ups: selectively distills old tool evidence at 60% use.
```

### Pipeline Layer Comparison

| Layer | Trigger | Scope | Behavior | Failure Recovery |
| :--- | :--- | :--- | :--- | :--- |
| **1. RTK Filter** | Tool execution | Shell output (`rg`, `git status`, `find`) | Compacts raw command output using pattern filters before the agent sees it. | Fallback to unfiltered output on tool error. |
| **2. Safety Cap** | Tool execution | All raw tool outputs | Hard-truncates exceptionally large output blobs to protect context limits. Inherited from Codex, unchanged. | Preserves header & footer with truncation notice. |
| **3. Ace Pressure Pass** | Exact model-window use reaches 60% | Oldest eligible tool exploration from completed turns | Selects only enough old tool evidence to target roughly 50% use. Useful results become a compact conclusion plus an evidence pointer; dead ends leave working context entirely; the current turn and recent suffix stay verbatim. | A failed pass changes nothing — working context is left as-is, and native compaction remains the exhaustion fallback. |

**All three layers ship with Elpis.** Layer 1 runs through RTK, which is a separate binary: `scripts/install-elpis.sh` installs it alongside Elpis (skip with `ELPIS_SKIP_RTK=1`), and on a launch that finds `rtk` on `PATH` with no `~/.elpis/hooks.json` of your own, Elpis writes the `PreToolUse` hook that calls `rtk hook claude`. It then passes the normal startup hook review before it can run. An existing `hooks.json` is never modified, so `{"hooks":{}}` opts out permanently, and Elpis's hook runtime (`codex-rs/hooks/src/events/pre_tool_use.rs`) is what accepts RTK's rewrite response.

The Ace pass runs between model follow-ups as well as at the end of a turn, so one
long-running tool-driven turn cannot skip the pressure boundary. OpenAI-backed passes use
Luna at low reasoning effort. Every successful pass immediately recomputes the working
history estimate and writes `prune_report.md` alongside the session logs
(`codex-rs/core/src/session/context_prune_audit.rs`).
The pass may run during a current turn, but it only receives and rewrites tool evidence
from earlier completed turns; current-turn observations remain intact for the next
follow-up.

`/prune` is currently a compatibility alias for full native `/compact`; it summarizes and
replaces conversation history, so it can legitimately leave a nearly empty working window.
It is not the selective Ace pass and does not create its audit report. The Context Ledger's
exact used-token number is authoritative after either path.

### Ace pass audit trail

Every applied Ace pass writes an immutable audit before the working history changes. If that audit cannot be written, Elpis keeps the working history and does not record the pass as applied.

```text
~/.elpis/logs/
├── prune_report.md              # points at the latest pass; contains clickable file:// links
└── pruning/passes/<pass-id>/
    ├── ace.json                 # Ace's exact instructions, input, and raw response
    ├── manifest.json            # every reviewed call ID and its kept/deleted decision
    └── items/*.json             # exact model-visible before/after for one call
```

You do not have to go looking for these: `prune_report.md` renders `ace.json` and `manifest.json` as clickable links (`context_prune_audit.rs`). The audit deliberately omits the system prompt, skills, and transcript, so it stays readable.

---

## 3. Context Lifetimes

Every item admitted into Elpis context carries an explicit lifetime:

```text
+-----------------------------------------------------------------------------------+
| DURABLE LIFETIME                                                                 |
| - AGENTS.md rules, active GOAL.md, MEMORY.md, explicit user constraints           |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| TASK LIFETIME                                                                     |
| - Decisions, changed file paths, blockers, verification, ES.md checkpoint         |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| TURN LIFETIME (Expires after turn question is answered)                           |
| - Terminal reads, searches, directory listings, command probes, temporary diffs   |
+-----------------------------------------------------------------------------------+
```

1. **Durable:** Survives across compaction, model switches, and restarts.
2. **Task:** Survives across turn execution within the current task; summarized into `ES.md` upon task transition.
3. **Turn:** Expires immediately after the active turn question is answered. Raw output is evicted from working context, leaving behind an exact evidence pointer (rollout ID / log path).

---

## 4. Context Ledger (`Tab` / `Alt+C`) & `admission.toml`

Elpis provides interactive context admission control in the TUI:

- **Context Ledger Panel (`Tab` or `Alt+C`):** A side panel shown by default, listing every admitted portable context source with exact byte sizes and the percentage of the model context window in use. It is 52 columns wide, narrowing to a proportional slice on smaller terminals so the composer keeps room. While a turn is running, `Tab` defers to the composer's queue-the-draft action; `Alt+C` always toggles the ledger.
- **`admission.toml` Control:** Toggling a row in the ledger writes `~/.elpis/context/workspaces/<workspace>/admission.toml`, which dynamically governs next-turn admission for:
  - `GOAL.md` (Active Goal)
  - `ES.md` (Executive Summary)
  - Global & project-level `AGENTS.md` rules
  - Individual skill rules (`skills/dev/*.md`)

![The Context Ledger listing admitted instruction files with their token counts and included state](assets/context-ledger.png)

### `/context` — where the window went

The ledger answers *what is admitted*. `/context` answers *what filled the window*: token
usage as a grid broken down by category — user messages, agent responses, tool calls,
system prompt, skills, and free space — alongside the backtrack checkpoints available via
`Esc Esc`. The two are separate surfaces and neither replaces the other.

![/context showing token usage as a grid, broken down by category, with available backtrack checkpoints](assets/elpis-context-slash.png)

### Context Accounting Contract

Elpis exposes **one single source of truth** for context measurement:

- Displayed percentages explicitly state whether they mean **used** or **remaining**.
- The percentage is computed against the model's own context window — used tokens over context window (`codex-rs/tui/src/chatwidget/context_ledger.rs`) — never against transcript length.
- It is reported in the Context Ledger. The persistent identity header carries product, model, and location only (`Elpis · model {model} · location {cwd}`); the inherited footer status line is deliberately suppressed so there is exactly one place to read the number.
- `/usage` enumerates admitted sources, byte sizes, and lifetime reasons.

---

## 5. Systemic Inter-Dependencies

- **Integration with Sessions:** the admitted `GOAL.md` and `ES.md` sources are exactly what lean continuation carries into a fresh thread; see [Sessions](sessions.md).
- **Integration with Memory:** durable memory is a separate subsystem. It reads completed rollout transcripts from disk rather than hooking into compaction, so it does not depend on when a thread compacts. A `PreCompact` hook event is available if you want to run your own work at that moment. See [Memory](memory.md).
- **Integration with Providers:** admitted context is normalized across provider wire formats while evidence pointers are preserved; see [Providers](providers.md).
