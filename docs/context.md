# Elpis Context Sovereignty

See the [product overview](../readme.md#why-elpis), [runtime architecture](GUIDE.md#runtime-architecture), [sessions](sessions.md), [providers](providers.md), [work graphs](WORK_GRAPHS.md), and [desktop context requirements](../apps/elpis-desktop/SPEC.md#context-goals-and-files).

## 1. Admission requirements

The new user message and explicitly admitted context must reach the model. Treat `@file` as an explicit refresh; do not re-append unchanged file bodies. Once a search, listing, file read, probe, dead end or bulky tool output has yielded its conclusion and evidence pointer, let it leave the working set. Keep changed paths, verification, blockers and the next action in context; keep full events in durable evidence. Prefer runtime or provider token usage and window sizes, with estimates as a fallback.

Instruction and continuity sections each occupy a single World State slot. Changing a slot can remove its earlier fragments, changing the request prefix and affecting prompt caching. [Admission](../codex-rs/core/src/elpis_admission.rs); [reconciliation](../codex-rs/core/src/context_manager/history.rs).

## 2. Context-control mechanisms and native compaction

**RTK.** The optional `rtk` binary rewrites supported shell commands through a `PreToolUse` hook. The [installer](../scripts/install-elpis.sh) reports whether it is on `PATH`. When the TUI starts with RTK on `PATH` and no `$ELPIS_HOME/hooks.json`, it writes a hook calling `rtk hook claude`; startup hook review still applies. An existing `hooks.json` is untouched; `{"hooks":{}}` opts out. [Hook setup](../codex-rs/tui/src/rtk_hook.rs); [rewrite parser](../codex-rs/hooks/src/events/pre_tool_use.rs). The runtime home is defined in the [README](../readme.md#how-it-works).

**Output truncation.** Codex's byte or token policies truncate oversized text in the middle, with a marker. [Implementation](../codex-rs/utils/output-truncation/src/lib.rs).

**Smart Prune.** Experimental and off by default, it can shorten eligible fresh tool results after post-tool hooks and before `record_annotated_conversation_items`; it does not rewrite earlier history. `/prune` enables it; `/smart-prune` toggles it; `/smart-prune on|off` sets it. Changes apply to subsequent turns. Failures preserve the original output. [Feature](../codex-rs/features/src/lib.rs); [admission pass](../codex-rs/core/src/session/smart_prune.rs); [commands](../codex-rs/tui/src/chatwidget/elpis_prune_commands.rs).

Each applied admission records the source and admitted forms under `logs/smart-prune/admissions`; attempts live under `logs/smart-prune/attempts`. The admission audit must be durable before the shortened output enters history. It can contain the latest user request and tool invocations. `/smart-prune log` opens the evidence; `/pruner-model <id|provider:id|default>` selects its model, saved in `pruner.json`, without changing the chat model. [Audit](../codex-rs/core/src/session/smart_prune_audit.rs); [audit input](../codex-rs/core/src/session/smart_prune.rs); [commands](../codex-rs/tui/src/chatwidget/elpis_prune_commands.rs).

`/force-prune <pct>` remains listed for compatibility but does not prune. [Dispatch](../codex-rs/tui/src/chatwidget/elpis_commands.rs).

**Native compaction.** `/compact` compacts immediately; `/compact <text>` adds summary guidance. `/compact N` instead saves a remaining-context pressure threshold in `$ELPIS_HOME/compaction.json`: N must be finite and greater than 0 and less than 70; decimals and `%` are accepted. The runtime checks the full window before turns and between model/tool iterations. If compaction cannot relieve pressure, further pressure compactions are suppressed for that turn until pressure clears; native context-limit protection remains active. Without the setting, native policy applies. [Command](../codex-rs/tui/src/chatwidget/elpis_commands.rs); [threshold](../codex-rs/core/src/pressure_compaction.rs); [turn loop](../codex-rs/core/src/session/turn.rs).

Compaction and pruning can lose detail. Check consequential claims against the transcript and artifacts; do not treat pruned tokens as total cost savings. See [evaluation evidence](evals/RESULTS.md).

## 3. Memory and checkpoints

[Sessions](sessions.md#3-portable-checkpoint-layout) owns the generated `GOAL.md` and `ES.md` layout, per-thread isolation, legacy fallback, handoff and deterministic checkpoint writes. For continuity admission, `GOAL.md` is capped at 6,000 trimmed characters; `ES.md` and `MEMORY.md` are each capped at 8,000. [Limits](../codex-rs/core/src/elpis_context.rs).

### Requirements

Memory must be searchable, attributable, reviewable, deletable and bounded. Keep verified reusable lessons, replace obsolete lessons after a verified correction, and leave temporary progress in the checkpoint. Promotion requires repeated useful recall across distinct contexts. Before a baseline reset, archive deleted or faded facts in searchable form; stop the reset if archiving fails. These are requirements, not behavior enforced by `save_memory`. [Tool contract](../codex-rs/core/src/memory_save.rs).

### Saving

See the [terminal overview](../readme.md#the-terminal-app). A workspace opts in to saving with `$ELPIS_HOME/context/workspaces/<workspace>/memory-autosave.json` containing `{"enabled":true}`; otherwise saving is off. In an opted-in root thread, the responding agent may call `save_memory` before its final answer. Subagents and internal threads are not offered the tool, and no auxiliary model saves after the response or before compaction. The Ledger controls admission to later requests. [Extension](../codex-rs/core/src/elpis_memory.rs).

The tool accepts exact append, replace or remove edits to `MEMORY.md` and an optional replacement of ES's Consolidated State. The model-facing contract assigns stable global user preferences to memory and thread/project state to ES; this guidance does not verify scope or truth. Each new memory or checkpoint output is limited to 6,000 characters. [Contract and validation](../codex-rs/core/src/memory_save.rs).

The runtime fixes the write paths, captures a turn-start baseline, locks the shared memory and thread checkpoint, and rejects stale or conflicting edits, invalid or oversized output, an empty checkpoint, erasure of existing memory and unsupported evidence citations. Locks coordinate Elpis writers only. A receipt records prepared and committed state; each file replacement is atomic, but the two-file update is not crash-atomic. [Save implementation](../codex-rs/core/src/memory_save.rs).

Receipts retain old and proposed state and up to 64,000 characters of serialized current-turn message evidence, with a first allowance of 32,000 for user messages. [Evidence selection](../codex-rs/core/src/tools/handlers/save_memory.rs).

Full evidence IDs in saved memory become numeric references in `memories/memory-references/sources.md`; provenance is written before the shortened memory. Unsupported UUID-based citations are rejected. For unchanged lines that still end in numeric references, the guard rejects replacing registered support with different references. It does not catch complete citation removal or validate rewritten prose, interior citations or the claim itself. [Reference handling](../codex-rs/core/src/memory_save.rs).

The runtime check is `node scripts/memory-runtime.test.cjs /absolute/path/to/binary`, using a built Elpis or app-server binary. [Driver](../scripts/memory-agent-tool-runtime.test.cjs). The [memory acceptance record](evals/memory-lessons-review.md) documents behavioral checks and their limits; fitting a checkpoint budget does not prove fidelity. Acceptance requires a checkpoint to retain the goal, constraints, unresolved work and evidence locations, replace superseded facts and keep detailed evidence outside the admission budget.

## 4. Context Ledger and admission

The [TUI Ledger](../codex-rs/tui/src/chatwidget/context_ledger.rs) is visible by default. Its default width is at most 52 columns and narrows with the terminal; the divider can resize it. `Alt+C`, `Ctrl+X` or `Tab` focuses it; the same key or `Esc` closes it while focused. Voice mute, menus, completions, configured shortcuts and pasted text retain their applicable keys; Tab queues a draft only when configured to do so.

While focused, Up/Down or `j`/`k` move; Space or Enter toggles a row; `i` toggles all eligible rows; `p` toggles Smart Prune; `s` toggles subagents; `m` picks the pruning model; `w` shows row reasons. Typing returns to the draft. [Keys](../codex-rs/tui/src/chatwidget/context_ledger.rs).

The Subagents switch controls delegation on the next turn of an open chat, including one started while it was off; off also wins over V2. [Runtime check](../scripts/subagents-switch-runtime.test.cts).

The Ledger saves workspace choices in `$ELPIS_HOME/context/workspaces/<workspace>/admission.toml`. Global, project and development rules start admitted; goal, checkpoint and memory start excluded until selected. `/add <path>` adds a file or directory. An invalid admission record fails closed for instruction files. [Admission](../codex-rs/core/src/elpis_context.rs); [instruction filtering](../codex-rs/core/src/elpis_admission.rs); [`/add`](../codex-rs/tui/src/chatwidget/elpis_ledger_glue.rs).

When Memory status is ready, its row includes a missing file, which cannot be admitted. Lowercase `c` creates a minimal template without admitting it; Space or Enter toggles an existing file for the next request. Bulk admission skips Memory while its status or change is pending. Ctrl+click follows a row's file link. [Memory row](../codex-rs/tui/src/chatwidget/context_ledger.rs); [status and creation](../codex-rs/core/src/elpis_context.rs).

### Development rules and skills

Development rules are Markdown Ledger rows. Configured `[skills] dev_rule_roots` replace the fallback `$ELPIS_HOME/skills/dev` and optional `ELPIS_DEV_SKILLS_DIRS`; an empty list uses that fallback. Roots are read in configuration order and files in sorted order; the first file with a given name wins. [Discovery](../codex-rs/core/src/elpis_context.rs); [configuration](../codex-rs/config/src/skills_config.rs).

Elpis disables ordinary and bundled skills by default; configuration can enable them. Enabled skills supply metadata until used. `/skills` opens the skill list and enable/disable menu; mentions include enabled skills only. The skill catalog is not a Ledger token row. [Defaults](../codex-rs/config/defaults.toml); [catalog](../codex-rs/ext/skills/src/render.rs); [skill menu](../codex-rs/tui/src/chatwidget/skills.rs).

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

### Context accounting

`/context` shows estimated categories of window use and the checkpoints reachable with `Esc Esc`. `/usage` opens the session card with model, provider, permissions and token usage. [Context report](../codex-rs/tui/src/chatwidget/context_usage.rs); [usage card](../codex-rs/tui/src/chatwidget/elpis_commands.rs).

The Ledger uses the runtime's active-context total and full model window for its used percentage. Source counts are capped estimates: trimmed characters divided by four, rounded up, with a byte fallback on read failure. Category proportions are estimates from the latest built request, scaled to the active-context total. `Reasoning + compaction` is an estimate of retained items, not the reasoning-effort setting. [Ledger](../codex-rs/tui/src/chatwidget/context_ledger.rs); [source estimates](../codex-rs/core/src/elpis_context.rs); [categories](../codex-rs/tui/src/chatwidget/context_usage.rs).

For encrypted reasoning and compaction items, the core estimate subtracts 1,287 bytes, then counts one token per 14.14 remaining bytes, rounded up. The constants were fitted to 4,363 reported responses across 24 chats; 18 of the 21 chats with at least 20 responses fell within 3% when each chat was held out. This is an estimate, not provider token accounting. [Estimator and method](../codex-rs/core/src/elpis_context_attribution.rs); [data](../codex-rs/core/src/elpis_reasoning_cost.json).

`/yolo` selects Full Access for the current chat and saves it as the default for future chats once confirmed; saving errors are reported. [Command](../codex-rs/tui/src/app/elpis_events.rs); [permission requirements](../apps/elpis-desktop/SPEC.md#permissions). `/theme` opens the syntax-theme picker with preview and cancel/restore. [Picker](../codex-rs/tui/src/theme_picker.rs).
