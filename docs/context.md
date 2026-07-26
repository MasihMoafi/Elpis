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
|  Layer 1: RTK Shell-Output Filter (Pre-model command trim)      |
|  Layer 2: Deterministic Safety Cap (Upper bound truncation)     |
|  Layer 3: Ace Post-Turn Pass (Post-turn exploration pruning)     |
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
[Layer 1: RTK Filter]          -> Pre-model, optional: compacts verbose CLI output (rg, find).
           |
           v
[Layer 2: Safety Cap]          -> Pre-model: Hard deterministic upper-bound truncation.
           |
           v
[Active Agent Turn Execution]  -> Tool outputs remain verbatim during active turn.
           |
           v
[Layer 3: Ace Post-Turn Pass]  -> Post-model: Distills turn into compact findings + evidence pointers.
```

### Pipeline Layer Comparison

| Layer | Trigger | Scope | Behavior | Failure Recovery |
| :--- | :--- | :--- | :--- | :--- |
| **1. RTK Filter** *(optional)* | Tool execution | Shell output (`rg`, `git status`, `find`) | Compacts raw command output using pattern filters before the agent sees it. | Fallback to unfiltered output on tool error. |
| **2. Safety Cap** | Tool execution | All raw tool outputs | Hard-truncates exceptionally large output blobs to protect context limits. Inherited from Codex, unchanged. | Preserves header & footer with truncation notice. |
| **3. Ace Post-Turn Pass** | Turn completion | Turn exploration & tool history | Evaluates the completed turn. Useful results become a compact conclusion plus an evidence pointer; dead ends leave the working context entirely. | A failed pass changes nothing — working context is left as-is. |

**Layer 1 is not built in.** It activates only once you install RTK and trust its hook; layers 2 and 3 ship with Elpis. Inspect the result of a pass with `/prune`, which writes `prune_report.md` alongside the session logs (`codex-rs/core/src/session/context_prune_audit.rs`).

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
