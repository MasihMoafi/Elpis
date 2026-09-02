# Elpis Skill and Context Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Elpis expose only deliberately enabled skills, use the configured canonical development-rule source, and report each Context Ledger source precisely enough that different files cannot look identical.

**Architecture:** Keep Codex's existing multi-root skill discovery and lazy body loading, but add an Elpis default-disabled admission policy above it. Add ordered `dev_rule_roots` to the existing `[skills]` configuration and thread those roots into Elpis continuity assembly; configured roots replace the managed fallback. Keep aggregate token displays compact while rendering exact estimated counts and provenance for individual ledger sources.

**Tech Stack:** Rust, serde/TOML configuration, Codex core-skills service, Elpis continuity context, Ratatui TUI, insta snapshots, Linux verification automation.

**Spec:** `docs/superpowers/specs/2026-08-31-elpis-daily-driver-readiness-design.md`

## Global Constraints

- Do not hard-code `~` or any personal absolute path in shipped source; Masih's source path belongs only in the final local candidate configuration.
- During implementation, do not run local `cargo`, Rust tests, builds, the Elpis binary, or tmux. The latest handoff also forbids pushing, so execution is deferred until the full functional issue set is closed.
- Preserve Codex's default behavior when `skills.default_enabled` is absent; only the Elpis executable prepends `false` as its product default, and a later explicit user override may replace it.
- Bundled Codex skills are off by default in Elpis, but the product must retain the configuration path that deliberately enables them.
- Skill discovery remains path-based and duplicate names remain legal; do not deduplicate skills by name.
- Disabled skills must not enter the model-visible catalog, mentions picker, implicit invocation indexes, or turn prompt. Full `SKILL.md` bodies remain lazy even when a skill is enabled.
- Configured development-rule roots replace the managed fallback and are deduplicated by canonical path and file name in deterministic root order.
- Fresh configured development-rule rows default to admitted; an explicit stored `false` remains authoritative.
- The Context Ledger estimate stays labelled as estimated. Per-source rows show exact grouped token estimates; aggregate/category totals may remain compact.
- Do not edit `main`, the installed `~/.local/bin/elpis`, `~/.elpis/config.toml`, any other worktree, or the observability worktree's untracked `ES.md` during this plan.
- Do not push, tag, publish, release, delete worktrees, or restart a running Elpis/Codex process.

---

### Task 1: Add the fail-first acceptance harness

**Files:**
- Test: `codex-rs/core/src/config/config_tests.rs`
- Test: `codex-rs/core-skills/src/service_tests.rs`
- Test: `codex-rs/core/src/elpis_context.rs`
- Test: `codex-rs/tui/src/chatwidget/tests/context_ledger.rs`
- Test: `codex-rs/tui/src/bottom_pane/skills_toggle_view.rs`

**Interfaces:**
- Consumes: current `SkillsConfig`, `SkillsService`, `continuity_sources`, `ContextLedgerState`, and `SkillsToggleView` behavior.
- Produces: named red tests that Tasks 2–5 make green; no production implementation.

- [ ] **Step 1: Add config-shape coverage**

Extend `parses_bundled_skills_config` so the TOML fixture contains these exact keys and the expected `SkillsConfig` contains the matching fields:

```toml
[skills]
default_enabled = false
dev_rule_roots = ["/tmp/elpis-dev-rules"]
include_instructions = false

[skills.bundled]
enabled = false
```

The Rust expectation must use:

```rust
default_enabled: Some(false),
dev_rule_roots: vec![AbsolutePathBuf::try_from("/tmp/elpis-dev-rules").unwrap()],
```

- [ ] **Step 2: Add a service-level skill-admission test**

Add `default_disabled_skills_require_one_explicit_enable` in `core-skills/src/service_tests.rs`. Create two valid user skills, load them with:

```toml
[skills]
default_enabled = false

[[skills.config]]
name = "selected-skill"
enabled = true
```

Assert all of the following:

```rust
assert!(outcome.is_skill_enabled(selected));
assert!(!outcome.is_skill_enabled(unselected));
assert_eq!(
    outcome.allowed_skills_for_implicit_invocation()
        .iter()
        .map(|skill| skill.name.as_str())
        .collect::<Vec<_>>(),
    vec!["selected-skill"],
);
```

Add a paired assertion using an empty `[skills]` table to prove both skills remain enabled when `default_enabled` is omitted. This protects upstream Codex behavior.

- [ ] **Step 3: Add configured-rule source and admission tests**

Add `configured_dev_rule_roots_replace_managed_fallback` in `core/src/elpis_context.rs`. Build separate managed and configured directories containing different `AGENTS.md` contents, then call the planned API:

```rust
continuity_sources_with_dev_rule_roots(
    Some(&memories),
    &cwd,
    &[],
    &[configured_dev.clone()],
)
```

Assert exactly one `dev/AGENTS.md` row exists, its path is the configured file, its `origin` is `"configured development rules"`, and it is admitted on a fresh workspace. Persist `false` through `set_continuity_source_admitted`, call the function again, and assert the same row is now excluded. Add a prompt-level assertion using:

```rust
build_continuity_prompt_with_dev_rule_roots(
    Some(&memories),
    &cwd,
    &[configured_dev],
)
```

to prove only the configured contents reach the model.

- [ ] **Step 4: Add ledger precision/provenance coverage**

Add `ledger_disambiguates_similarly_sized_rule_sources` in `tui/src/chatwidget/tests/context_ledger.rs` with sources whose estimates are `1_244`, `1_185`, and `1_050`. The rendered collapsed rows must contain `≈1,244 est. tokens`, `≈1,185 est. tokens`, and `≈1,050 est. tokens`; the selected WHY block must contain:

```text
Origin: configured development rules
Size: 4,739 bytes · Estimate: ≈1,185 tokens (trimmed characters ÷ 4, capped)
```

and the canonical source path. Keep the existing `≈` assertion.

- [ ] **Step 5: Add the skills-management ordering/origin test**

Extend `SkillsToggleItem` fixtures with `origin: String`, then add `enabled_skills_render_before_available_candidates_with_origins`. Render one disabled bundled skill, one disabled personal skill, and one enabled personal skill. Assert the enabled row appears first, every description ends with `Source: bundled`, `Source: yours`, or `Source: repo`, and the header contains:

```text
Only enabled skills are shown to the model. Available skills stay off until you select them.
```

- [ ] **Step 6: Commit the red harness without running it locally**

```bash
git add codex-rs/config/src/skills_config.rs codex-rs/core/src/config/config_tests.rs codex-rs/core-skills/src/service_tests.rs codex-rs/core/src/elpis_context.rs codex-rs/tui/src/chatwidget/tests/context_ledger.rs codex-rs/tui/src/bottom_pane/skills_toggle_view.rs
git commit -m "test(context): define curated skill and rule admission"
```

Coordinator action after review: record independent source review as the red-harness evidence. The exact compile failure cannot be observed without violating the no-local-Rust/no-push constraints; all planned fields/functions must be resolved before the deferred final checks.

---

### Task 2: Implement default-disabled skill admission for Elpis

**Files:**
- Modify: `codex-rs/config/src/skills_config.rs`
- Modify: `codex-rs/core-skills/src/config_rules.rs`
- Modify: `codex-rs/core-skills/src/service.rs`
- Modify: `codex-rs/core-skills/src/service_tests.rs`
- Modify: `codex-rs/core/src/config/config_tests.rs`
- Modify: `codex-rs/tui/src/main.rs`
- Test: `codex-rs/tui/src/main_tests.rs` if this test module exists; otherwise keep the product-default assertion beside `prepend_elpis_memories_defaults` under `#[cfg(test)]`.

**Interfaces:**
- Consumes: Task 1's `default_disabled_skills_require_one_explicit_enable` test.
- Produces: `SkillsConfig.default_enabled: Option<bool>` and `SkillsConfig.dev_rule_roots: Vec<AbsolutePathBuf>`; `SkillConfigRules.default_enabled: bool`; Elpis raw defaults `skills.default_enabled=false` and `skills.bundled.enabled=false`.

- [ ] **Step 1: Extend the shared config type without changing its absent-value behavior**

Add these fields to `SkillsConfig` immediately after `bundled`:

```rust
/// Whether newly discovered skills are enabled before an explicit per-skill rule.
#[serde(default, skip_serializing_if = "Option::is_none")]
pub default_enabled: Option<bool>,

/// Ordered roots containing always-visible Elpis development-rule Markdown files.
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub dev_rule_roots: Vec<AbsolutePathBuf>,
```

Update all literal `SkillsConfig` constructors. Do not assign a serde default of `false`; absence means `true` for shared Codex behavior.

- [ ] **Step 2: Carry the default into config-rule resolution**

Change `SkillConfigRules` to:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SkillConfigRules {
    pub default_enabled: bool,
    pub entries: Vec<SkillConfigRule>,
}

impl Default for SkillConfigRules {
    fn default() -> Self {
        Self {
            default_enabled: true,
            entries: Vec::new(),
        }
    }
}
```

In `skill_config_rules_from_stack`, parse `default_enabled` from `config_layer_stack.effective_config()` and fall back to `true`. Preserve the existing ordered per-layer path/name rule collection. In `resolve_disabled_skill_paths`, initialize the set with every discovered path only when `default_enabled` is false, then apply existing rules in order so an explicit `enabled=true` removes the selected path.

- [ ] **Step 3: Keep cache identity and model exposure aligned**

Retain the full `SkillConfigRules` in `ConfigSkillsCacheKey`; its derived hash now includes `default_enabled`. Do not change `finalize_skill_outcome`: its existing enabled-only implicit indexes and `allowed_skills_for_implicit_invocation` must consume the new disabled set.

- [ ] **Step 4: Add Elpis-only product defaults**

In `prepend_elpis_memories_defaults`, prepend these exact raw overrides before the memory paths:

```rust
"skills.default_enabled=false".to_string(),
"skills.bundled.enabled=false".to_string(),
```

Keep them earlier than user overrides so a deliberate user setting wins. Rename the helper only if needed to reflect that it now owns Elpis product defaults, and update its callers/tests together.

- [ ] **Step 5: Check source consistency without compiling**

Run only non-building checks:

```bash
git diff --check
rg -n "SkillsConfig \{" codex-rs --glob '*.rs'
rg -n "SkillConfigRules \{" codex-rs --glob '*.rs'
```

Inspect every literal reported by `rg`; no constructor may silently omit the new fields.

- [ ] **Step 6: Commit**

```bash
git add codex-rs/config/src/skills_config.rs codex-rs/core-skills/src/config_rules.rs codex-rs/core-skills/src/service.rs codex-rs/core-skills/src/service_tests.rs codex-rs/core/src/config/config_tests.rs codex-rs/tui/src/main.rs
git commit -m "feat(skills): require explicit Elpis skill enablement"
```

---

### Task 3: Route configured development rules into the ledger and model request

**Files:**
- Modify: `codex-rs/core-skills/src/service.rs`
- Modify: `codex-rs/core/src/config/mod.rs`
- Modify: `codex-rs/core/src/elpis_context.rs`
- Modify: `codex-rs/app-server/src/extensions.rs`
- Modify: `codex-rs/tui/src/chatwidget/context_ledger.rs`
- Modify: `codex-rs/tui/src/status/card.rs`
- Test: `codex-rs/core/src/elpis_context.rs`
- Test: `codex-rs/app-server/tests/suite/v2/memory_recall.rs` only if its helper needs the new configured-root path.

**Interfaces:**
- Consumes: `SkillsConfig.dev_rule_roots` from Task 2.
- Produces: `Config::dev_rule_roots() -> Vec<AbsolutePathBuf>`; `continuity_sources_with_dev_rule_roots`; `build_continuity_prompt_with_dev_rule_roots`; `ContinuitySource.origin: &'static str`.

- [ ] **Step 1: Expose effective configured roots**

Add `Config::dev_rule_roots` next to `bundled_skills_enabled`. Parse the effective `[skills]` table through `SkillsConfig`; return an empty vector after logging the same invalid-config warning policy used by the skills service. Return clones of the ordered roots without creating directories or canonicalizing nonexistent paths.

```rust
pub fn dev_rule_roots(&self) -> Vec<AbsolutePathBuf> {
    crate::skills::service::skills_config_from_stack(&self.config_layer_stack)
        .dev_rule_roots
}
```

Factor and export `skills_config_from_stack` from `core-skills/src/service.rs` so both `bundled_skills_enabled_from_stack` and this method use one parse/fallback implementation.

- [ ] **Step 2: Add configured-root-aware continuity APIs while retaining wrappers**

Keep existing callers source-compatible:

```rust
pub fn continuity_sources(
    memories_root: Option<&Path>,
    cwd: &Path,
    instruction_source_paths: &[PathBuf],
) -> Vec<ContinuitySource> {
    continuity_sources_with_dev_rule_roots(memories_root, cwd, instruction_source_paths, &[])
}

pub async fn build_continuity_prompt(
    memories_root: Option<&Path>,
    cwd: &Path,
) -> Option<String> {
    build_continuity_prompt_with_dev_rule_roots(memories_root, cwd, &[]).await
}
```

The new functions accept `dev_rule_roots: &[AbsolutePathBuf]`. If the slice is non-empty, use only those roots. If empty, use `$ELPIS_HOME/skills/dev` as the managed fallback, then append legacy `ELPIS_DEV_SKILLS_DIRS` only for backward compatibility. In either case, preserve root order, sort files within a root, accept only nonempty `.md` files, canonicalize successful files, and skip duplicate canonical paths and later duplicate file names.

- [ ] **Step 3: Make new dev rows default on without overriding stored choices**

Replace the shared optional default in `ContinuityAdmission::admits_row` only for `dev/` rows:

```rust
const DEFAULT_OPTIONAL_ADMISSION: bool = false;
const DEFAULT_DEV_RULE_ADMISSION: bool = true;

name if name.starts_with(DEV_SOURCE_PREFIX) => self
    .dev_sources
    .get(&name[DEV_SOURCE_PREFIX.len()..])
    .copied()
    .unwrap_or(DEFAULT_DEV_RULE_ADMISSION),
```

Do not change global/project rules, goal, checkpoint, memory, or custom-source defaults. Update older tests whose comments assumed dev rows default off; keep explicit off/on toggle tests.

- [ ] **Step 4: Record source provenance once**

Add:

```rust
pub struct ContinuitySource {
    // existing fields
    pub origin: &'static str,
}
```

Assign only these stable labels:

```text
runtime instructions
workspace discovery
configured development rules
managed development rules
Elpis workspace state
Elpis durable memory
manual addition
```

Configured dev files receive `configured development rules`; fallback files receive `managed development rules`. Thread the field through constructors and test fixtures without deriving it from display paths in the TUI.

- [ ] **Step 5: Feed the same roots to the model, ledger, and status card**

Add `dev_rule_roots` to `ElpisContinuityConfig::from_config` and call `build_continuity_prompt_with_dev_rule_roots`. In the TUI `ChatWidget::continuity_sources` and status-card construction, call `config.dev_rule_roots()` and then `continuity_sources_with_dev_rule_roots`. This is the single-source consistency requirement: no surface may render configured roots while the request injects fallback roots.

- [ ] **Step 6: Check and commit**

```bash
git diff --check
rg -n "ContinuitySource \{" codex-rs --glob '*.rs'
git add codex-rs/core/src/config/mod.rs codex-rs/core/src/elpis_context.rs codex-rs/core-skills/src/service.rs codex-rs/app-server/src/extensions.rs codex-rs/tui/src/chatwidget/context_ledger.rs codex-rs/tui/src/status/card.rs codex-rs/app-server/tests/suite/v2/memory_recall.rs
git commit -m "feat(context): use configured development rule roots"
```

Stage only paths that actually changed; omit the app-server test path if it did not need modification.

---

### Task 4: Make Context Ledger source estimates and provenance unambiguous

**Files:**
- Modify: `codex-rs/tui/src/chatwidget/context_ledger.rs`
- Test: `codex-rs/tui/src/chatwidget/tests/context_ledger.rs`
- Modify: `codex-rs/tui/src/chatwidget/context_usage.rs` only where its wording calls dev rules “Skills”.

**Interfaces:**
- Consumes: `ContinuitySource.origin` and exact `bytes`/`estimated_tokens` from Task 3.
- Produces: `format_source_count(u64) -> String`; precise per-source row and WHY copy.

- [ ] **Step 1: Add a dependency-free grouped-number formatter**

Implement this exact behavior beside `format_tokens`:

```rust
fn format_source_count(value: u64) -> String {
    let digits = value.to_string();
    let first = digits.len() % 3;
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    if first != 0 {
        grouped.push_str(&digits[..first]);
    }
    for chunk in digits.as_bytes()[first..].chunks(3) {
        if !grouped.is_empty() {
            grouped.push(',');
        }
        grouped.push_str(std::str::from_utf8(chunk).expect("digits are UTF-8"));
    }
    grouped
}
```

Keep `format_tokens` for category/context totals.

- [ ] **Step 2: Change only per-source row copy**

Replace the row's right-hand text with:

```rust
format!(
    "≈{} est. tokens {state}",
    format_source_count(source.estimated_tokens),
)
```

Do not remove `[x]`, `[ ]`, `INCLUDED`, `EXCLUDED`, category headings, focus glyphs, or accessibility wording.

- [ ] **Step 3: Make WHY provenance explicit**

Keep the reason/lifetime text, then render:

```rust
format!("Origin: {}", source.origin)
format!(
    "Size: {} bytes · Estimate: ≈{} tokens (trimmed characters ÷ 4, capped)",
    format_source_count(source.bytes),
    format_source_count(source.estimated_tokens),
)
format!("Source: {}", source.path.display())
```

Each item may wrap as its own dim line. Do not claim tokenizer precision.

- [ ] **Step 4: Correct terminology without inventing skill-catalog accounting**

Where `/context` currently labels admitted instruction files under a `skills` path as `Skills`, rename that attribution to `Development rules`. Do not add a skill-catalog token row until a measured model-visible catalog value is available from the request assembly path; zero or a second heuristic would be misleading.

- [ ] **Step 5: Check and commit**

```bash
git diff --check
git add codex-rs/tui/src/chatwidget/context_ledger.rs codex-rs/tui/src/chatwidget/tests/context_ledger.rs codex-rs/tui/src/chatwidget/context_usage.rs
git commit -m "fix(tui): disambiguate Context Ledger sources"
```

---

### Task 5: Clarify enabled versus available skills in `/skills`

**Files:**
- Modify: `codex-rs/tui/src/skills_helpers.rs`
- Modify: `codex-rs/tui/src/chatwidget/skills.rs`
- Modify: `codex-rs/tui/src/bottom_pane/skills_toggle_view.rs`
- Test: `codex-rs/tui/src/skills_helpers.rs`
- Test: `codex-rs/tui/src/bottom_pane/skills_toggle_view.rs`

**Interfaces:**
- Consumes: protocol skill `enabled` and `scope`; Task 2's default-disabled outcome.
- Produces: `skill_scope_label` exposed within the TUI; `SkillsToggleItem.origin: String`; enabled-first stable ordering and truthful header copy.

- [ ] **Step 1: Expose the existing scope vocabulary**

Change `skill_scope_label` to `pub(crate)` and retain its exact labels:

```rust
User => "yours"
System => "bundled"
Repo => "repo"
Admin => "admin"
```

Do not introduce a second origin vocabulary.

- [ ] **Step 2: Carry scope into management rows**

Add `origin: String` to `SkillsToggleItem`. In `open_manage_skills_popup`, set it from `skill_scope_label(core_skill.scope)`. Append ` · Source: {origin}` to the description in `build_rows`, not to the skill name, so search and mention identity remain unchanged.

- [ ] **Step 3: Order enabled skills before candidates**

Before constructing the view, sort the `(enabled, SkillMetadata)` values stably by:

```rust
(!enabled, skill_display_name(skill, &colliding_names))
```

The enabled group appears first; each group is alphabetical. Search relevance continues to control filtered results after the user types.

- [ ] **Step 4: Replace the popup explanation**

Use exactly:

```text
Only enabled skills are shown to the model. Available skills stay off until you select them.
```

Keep automatic persistence and existing toggle controls. The normal mentions/list picker remains enabled-only through the existing `enabled_skills_for_mentions` filter.

- [ ] **Step 5: Check and commit**

```bash
git diff --check
git add codex-rs/tui/src/skills_helpers.rs codex-rs/tui/src/chatwidget/skills.rs codex-rs/tui/src/bottom_pane/skills_toggle_view.rs
git commit -m "fix(tui): separate enabled and available skills"
```

---

### Task 6: Document and prepare verification for the complete slice

**Files:**
- Modify: `docs/context.md`
- Modify: `readme.md`
- Coordinator-only after worker review: `docs/GUIDE.md`
- Coordinator-owned verification mapping after this slice: `tools/verify-elpis/surfaces.toml` through the separate verification-selector plan.

**Interfaces:**
- Consumes: Tasks 2–5 production behavior and Task 1 test names.
- Produces: one documented config example and exact focused commands for the deferred final Linux verification.

- [ ] **Step 1: Update the context contract**

Document this portable example without Masih's path:

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

State that dev rules are ordinary Markdown instruction rows in the Context Ledger, not skills; configured roots replace the managed fallback; fresh dev rules default on; explicit exclusions persist; skills contribute metadata only after enablement and bodies remain lazy.

- [ ] **Step 2: Update readme claims**

Add only implemented behavior. Do not describe Masih's source path as a product default, and do not claim that hidden skill metadata has a measured ledger token value. Preserve the manual-memory and pruning boundaries.

- [ ] **Step 3: Record focused tests for the shared verification manifest**

The required focused commands are:

```text
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core-skills default_disabled_skills_require_one_explicit_enable --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-core --lib configured_dev_rule_roots_replace_managed_fallback --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui --lib context_ledger --locked
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test -p codex-tui --lib enabled_skills_render_before_available_candidates_with_origins --locked
```

Do not edit the workflow or upload the branch in this task. The separate verification-selector plan makes `tools/verify-elpis/surfaces.toml` the single command list and then migrates Linux CI to it. Record these four filters as required rows for that plan; do not add a second workflow list here.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/context.md readme.md
git commit -m "docs: define curated skill and dev rule behavior"
```

Stage only files that changed.

- [ ] **Step 5: Coordinator records deferred execution status**

Record the exact commit SHA and the four pending commands in the SDD ledger. Do not run them yet and do not upload the branch. They join the final focused Linux batch after all functional issues are closed; a later pass on a different SHA is not evidence for this slice.

- [ ] **Step 6: Reconcile the spec and task ledger**

The coordinator updates `docs/GUIDE.md` and ignored `TASKS.md` with the exact commit, deferred local verification status, remaining risks, and manual acceptance status. There is no GitHub run because pushing is forbidden. Do not mark the slice verified; Masih remains the sole arbiter.
