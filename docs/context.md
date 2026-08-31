# Elpis Context Sovereignty & 4-Layer Pruning Pipeline

Elpis enforces **Context Sovereignty**: the principle that context is a strictly budgeted working set, not a dumped chat transcript. The user maintains live visibility and explicit control over every byte admitted to the agent's context window.
---

![Elpis context control pipeline](assets/elpis-context-control.svg)

## 1. Systemic Role in Elpis

Context management acts as the primary gatekeeper between raw workspace/session events and the active model inference loop:

---

## 2. The 4-Layer Pruning Pipeline

Long agent sessions accumulate dead ends, voluminous search results, and repetitive file reads. Elpis separates **working context** from **durable evidence**.

When enabled, Layer 3's automatic mode uses one pressure trigger and a gated cycle rather
than running continuously. An earlier "steady" trigger also fired on backlog size alone,
independently of how full the window was; it was removed because it produced runs of tiny
passes inside the healthy 20-30% band, and every pass discards the reusable prompt-cache
prefix past its first rewritten item. The case it was meant to cover -- a single turn that
balloons past the boundary without ever ending -- is already handled here, because the
eligible region is cut by recency rather than at a turn boundary. See
`cache-friendly-pruning.md`.

The model-backed Ace pass is **manual by default** because the current evaluation does not
show a task-success or cost-per-success benefit. `/prune` and `/compact` remain available.
The pressure cycle can be enabled explicitly with
`features.automatic_context_pruning = true` for continued experiments.

### Pipeline Layer Comparison

| Layer | Trigger | Scope | Behavior | Failure Recovery |
| :--- | :--- | :--- | :--- | :--- |
| **1. RTK Filter** | Tool execution | Shell output (`rg`, `git status`, `find`) | Compacts raw command output using pattern filters before the agent sees it. | Fallback to unfiltered output on tool error. |
| **2. Safety Cap** | Tool execution | All raw tool outputs | Hard-truncates exceptionally large output blobs to protect context limits. Inherited from Codex, unchanged. | Preserves header & footer with truncation notice. |
| **3. Ace Pruning** | Explicit `/prune` or `/compact`; optionally, exact model-window use reaches 30% when `features.automatic_context_pruning = true` | Oldest eligible tool exploration, including the turn still running in automatic mode, but never a sealed epoch | Manual pruning sweeps eligible stale tool evidence on request. Optional automatic mode targets roughly 20% use, protects the newest 10% of the window, allows at most 2 back-to-back passes per pressure cycle, and seals rewritten regions with epoch markers. | A failed pass changes nothing. In optional automatic mode, an exhausted pressure cycle hands off to native compaction. |

**All three layers ship with Elpis, but Ace is opt-in for automatic use.** Layer 1 runs through RTK, which is a separate binary: `scripts/install-elpis.sh` installs it alongside Elpis (skip with `ELPIS_SKIP_RTK=1`), and on a launch that finds `rtk` on `PATH` with no `~/.elpis/hooks.json` of your own, Elpis writes the `PreToolUse` hook that calls `rtk hook claude`. It then passes the normal startup hook review before it can run. An existing `hooks.json` is never modified, so `{"hooks":{}}` opts out permanently, and Elpis's hook runtime (`codex-rs/hooks/src/events/pre_tool_use.rs`) is what accepts RTK's rewrite response.

When automatic Ace pruning is enabled, the pass runs between model follow-ups as well as at
the end of a turn, so one long-running tool-driven turn cannot skip the trigger. Each pass
records which trigger fired (`manual` or `pressure`) in its manifest and report.
OpenAI-backed passes use Luna at maximal reasoning effort
(`PRUNE_REASONING_EFFORT = ReasoningEffort::Max`). Every successful pass immediately
recomputes the working history estimate and writes `prune_report.md` alongside the session logs
(`codex-rs/core/src/session/context_prune_audit.rs`).
The automatic pass may reach older tool evidence from the current turn, but its newest 10%
recency budget remains verbatim for the next follow-up.

`/prune` runs the Ace pass on demand across eligible tool evidence from completed turns.
It keeps user and assistant messages, the current turn, and durable rollout evidence.
`/compact` is Elpis-owned conservative cleanup. It first runs the audited tool-evidence
pass, then asks Luna Max to mark older whole conversation messages as `KEEP` or `DELETE`.
The latest turn is protected; kept content is copied verbatim; incomplete, malformed, or
uncertain decisions leave conversation history unchanged. A successful deletion starts a
new window while the raw transcript remains intact. An explicit custom `compact_prompt`
retains the upstream summary path as an opt-out. The Context Ledger's exact used-token
number is authoritative after either path.

### Ace pass audit trail

Every applied Ace pass writes an immutable audit before the working history changes. If that audit cannot be written, Elpis keeps the working history and does not record the pass as applied.

![Elpis immutable audit trail](assets/elpis-audit-trail-template.svg)

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

- **Context Ledger Panel (`Tab` or `Alt+C`):** A side panel shown by default, listing portable context sources with their byte sizes, per-source estimates, and the percentage of the model context window in use. It is 52 columns wide, narrowing to a proportional slice on smaller terminals so the composer keeps room. While a turn is running, `Tab` defers to the composer's queue-the-draft action; `Alt+C` always toggles the ledger.
- **`admission.toml` Control:** Toggling a row in the ledger writes `~/.elpis/context/workspaces/<workspace>/admission.toml`, which dynamically governs next-turn admission for:
  - `GOAL.md` (Active Goal)
  - `ES.md` (Executive Summary)
  - Global & project-level `AGENTS.md` rules
  - Individual portable development rules installed by Elpis
    (`~/.elpis/skills/dev/*.md`)

### Development rules and curated skills

Development rules and skills have different admission contracts. Development rules are
ordinary Markdown instruction rows in the Context Ledger; they are not skills. This portable
configuration chooses development-rule roots and explicitly enables one skill:

```toml
[skills]
default_enabled = false
dev_rule_roots = ["/absolute/path/to/your/dev-rules"]

[skills.bundled]
enabled = false

[[skills.config]]
name = "one-selected-skill"
enabled = true
```

When `skills.dev_rule_roots` contains one or more roots, those roots replace the managed
development-rule fallback. With no configured roots, including an explicitly empty list, Elpis
uses its managed rule directory and the optional
`ELPIS_DEV_SKILLS_DIRS` additions. Configured roots are read in configuration order; Markdown
files within each root are read in sorted order. The first file with a given filename wins.

Fresh development-rule rows start included. An explicit Ledger exclusion is stored in
`admission.toml` and continues to exclude that row. This default applies to development rules,
not the skills catalog: Elpis product defaults leave ordinary and bundled skills off. Deliberate
user configuration can enable them.

Enabled skills expose compact metadata to the model, while skill bodies remain lazy and are read
only when a selected skill is used. The `/skills` management surface shows enabled skills before
available candidates and labels their origins. Mentions and the model-visible skills list include
enabled skills only. The skills catalog itself is not a Context Ledger token row.

![The Context Ledger listing admitted instruction files with their token counts and included state](assets/context-ledger.webp)

### `/context` — where the window went

The ledger answers *what is admitted*. `/context` answers *what filled the window*: token
usage as a grid broken down by category — user messages, agent responses, tool calls,
system prompt, Development rules, and free space — alongside the backtrack checkpoints available via
`Esc Esc`. The two are separate surfaces and neither replaces the other.

![/context showing token usage as a grid, broken down by category, with available backtrack checkpoints](assets/elpis-context-slash.webp)

### Context Accounting Contract

Elpis exposes **one single source of truth** for context measurement:

- Displayed percentages explicitly state whether they mean **used** or **remaining**.
- The percentage is computed against the model's own context window — used tokens over context window (`codex-rs/tui/src/chatwidget/context_ledger.rs`) — never against transcript length.
- It is reported in the Context Ledger. The persistent identity header carries product, model, and location only (`Elpis · model {model} · location {cwd}`); the inherited footer status line is deliberately suppressed so there is exactly one place to read the number.
- `/usage` enumerates admitted sources, byte sizes, and lifetime reasons.
- Per-source Ledger counts are capped estimates from trimmed characters divided by four, not
  tokenizer measurements. They make the admitted-file cost inspectable without assigning a
  measured token value to the skills catalog.

---

## 5. Systemic Inter-Dependencies

- **Integration with Sessions:** the admitted `GOAL.md` and `ES.md` sources are exactly what lean continuation carries into a fresh thread; see [Sessions](sessions.md).
- **Integration with Memory:** durable memory is user-managed. Elpis can admit the user's `~/.elpis/memories/MEMORY.md` into context, but it does not automatically extract, consolidate, or promote memories from completed rollouts. A `PreCompact` hook event is available if you want to run your own work at that moment.
- **Integration with Providers:** admitted context is normalized across provider wire formats while evidence pointers are preserved; see [Providers](providers.md).
