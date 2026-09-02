# Elpis Context Sovereignty

Elpis enforces **Context Sovereignty**: the principle that context is a strictly budgeted working set, not a dumped chat transcript. The user maintains live visibility and explicit control over every byte admitted to the agent's context window.
---

![Elpis context control pipeline](assets/elpis-context-control.svg)

## 1. Systemic Role in Elpis

Context management acts as the primary gatekeeper between raw workspace/session events and the active model inference loop:

---

## 2. Three context-control mechanisms and native compaction

Long agent sessions accumulate dead ends, voluminous search results, and repetitive file reads. Elpis separates **working context** from **durable evidence**.

Elpis separates prevention from retrospective cleanup. **Smart Prune** is the optional
automatic path: it considers a fresh textual tool result after post-tool hooks finish but
before that result is recorded or sent to the main model for the first time. It may replace
only the result body with a smaller, evidence-linked body. It never removes the tool-call
event, changes its call id, or rewrites an item that has already entered sent history.

The ambiguous retrospective `/prune` command was removed. `/force-prune <1-100>` remains
an explicit emergency Ace pass. It can rewrite older tool-result bodies on request, which
necessarily changes the cacheable prefix after the first changed item. See
[cache-friendly-pruning.md](cache-friendly-pruning.md).

### Pipeline Layer Comparison

| Layer | Trigger | Scope | Behavior | Failure Recovery |
| :--- | :--- | :--- | :--- | :--- |
| **1. RTK Filter** | Before selected shell tools execute | Shell command/request | Rewrites supported commands so the external RTK process can emit a smaller result. RTK is syntactic filtering, not semantic history pruning. | Hook rejection or tool failure leaves normal or unfiltered output available. |
| **2. Safety Cap** | Tool execution | All raw tool outputs | Hard-truncates exceptionally large output blobs to protect context limits. Inherited from Codex, unchanged. | Preserves header and footer with a truncation notice. |
| **3. Smart Prune** | After sibling tools and post-tool hooks, before first main-model exposure, when enabled | Fresh textual function/custom-tool results of at least 1,024 estimated tokens, up to a 24k-token batch | Ace returns `compact` or `unchanged` for every result. Elpis admits a compact body only when it saves at least 256 estimated tokens and 20%; the original envelope and call id remain. | Any timeout, malformed response, audit failure, unsupported body, or weak saving admits the exact original result. |
| **4. Explicit recovery** | `/force-prune <1-100>` or `/compact` | Already-recorded history | `/force-prune` selectively rewrites eligible old tool-result bodies; `/compact` performs Codex's broader documented rollover. | Incomplete or invalid decisions leave history unchanged. |

RTK is a separate binary and an optional `PreToolUse` hook. `scripts/install-elpis.sh`
installs it alongside Elpis unless `ELPIS_SKIP_RTK=1` is set. On a launch that finds `rtk`
on `PATH` and no user-owned `~/.elpis/hooks.json`, Elpis writes the hook and subjects it to
the normal startup review. An existing hooks file is never modified, so `{"hooks":{}}`
opts out permanently. Elpis's hook runtime accepts RTK's rewrite response. RTK and Smart
Prune may coexist: RTK changes supported shell execution before it runs; Smart Prune
evaluates the final post-hook result that would otherwise enter model history.

Smart Prune is off by default. Toggle it for subsequent turns with the Context Ledger's
`p` key/switch or `/smart-prune on|off`; the underlying persisted feature key remains
`features.automatic_context_pruning`. A turn captures the setting once, so changing the
configuration cannot change outputs halfway through an active turn. OpenAI-backed
admission passes use Luna at maximal reasoning effort; other providers use the selected
provider model. The admission call has its own `:smart-prune` prompt-cache namespace and
does not consume the main turn's stable cache key.

`/force-prune <pct>` is an explicit emergency Ace action and works while Smart Prune is off.
It records `pressure` in its audit to name the targeted selection strategy; that value does
not establish automatic invocation.

`/compact` immediately runs Codex's native compaction/summarization lifecycle when invoked; it
does not run Ace first. Separately, automatic native compaction uses the donor model-window
threshold and usable-window headroom. The Context Ledger's exact used-token number is
authoritative after either mechanism. Ace saved-token totals are cumulative and origin-neutral:
they do not identify a pass as manual or automatic.

### Audit trail

Before a compact body can enter history, every applied Smart Prune admission writes its
exact source, admitted envelope, source hash, and model decision under
`~/.elpis/logs/smart-prune/admissions/<admission-id>/`. Elpis later appends hash-only
main-request linkage and the matching response id/usage. If the initial audit cannot be
written, Elpis admits the original output. Manual Ace passes retain their existing
immutable pruning audit.

![Elpis immutable audit trail](assets/elpis-audit-trail-template.svg)

For manual Ace, `prune_report.md` renders `ace.json` and `manifest.json` as clickable
links (`context_prune_audit.rs`). Those manual reports deliberately omit the system prompt,
skills, and transcript so they stay readable.

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

![The Context Ledger admission model](../website/assets/elpis-context-ledger.svg)

### `/context` — where the window went

The ledger answers *what is admitted*. `/context` answers *what filled the window*: token
usage as a grid broken down by category — user messages, agent responses, tool calls,
system prompt, Development rules, and free space — alongside the backtrack checkpoints available via
`Esc Esc`. The two are separate surfaces and neither replaces the other.

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
