# OpenAI Model and Reasoning Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make authenticated OpenAI subscription models and their supported reasoning levels selectable inside a running Elpis session, including sessions that started on another provider.

**Architecture:** Extend `model/list` with an optional provider ID, build the requested provider's model manager with Elpis's existing `AuthManager`, and reuse Codex's current asynchronous picker-refresh pattern to populate a provider-scoped OpenAI catalog. Carry provider, model, and effort through one TUI selection action and one configuration batch so the active thread and next launch agree without restarting either process.

**Tech Stack:** Rust, Tokio, Elpis app-server JSON-RPC v2, Ratatui TUI, existing model-provider and config-edit crates.

**Spec:** `docs/superpowers/specs/2026-08-31-openai-model-reasoning-selection-design.md`

## Global Constraints

- Reuse the existing Elpis `AuthManager`; never render, log, copy, or migrate a bearer token.
- Do not modify authentication, continuity, state database, goal, checkpoint, or memory files during automated verification.
- Do not stop, signal, replace, or restart a running Elpis or Codex process.
- Preserve provider-neutral session state when changing the inference provider.
- Keep protocol extensions backward-compatible through optional fields.
- Work only in `fix/openai-model-reasoning-picker` until Masih accepts integration.
- Prefix every Cargo command with `CODEX_SKIP_BWRAP_BUILD=1` and format only edited files.
- No retrieval engine, memory-promotion pipeline, telemetry upload default, release, push, or unrelated upstream synchronization is in scope.

---

### Task 1: Provider-scoped model catalog RPC

**Files:**
- Modify: `codex-rs/app-server-protocol/src/protocol/v2/model.rs`
- Modify: `codex-rs/app-server-protocol/src/protocol/common.rs`
- Modify: `codex-rs/app-server/src/models.rs`
- Modify: `codex-rs/app-server/src/request_processors/catalog_processor.rs`
- Test: `codex-rs/app-server/tests/suite/v2/model_list.rs`

**Interfaces:**
- Consumes: the existing `CatalogRequestProcessor.auth_manager`, `Config.model_providers`, `Config.codex_home`, and model-manager cache semantics.
- Produces: `ModelListParams.model_provider: Option<String>` and provider-scoped `model/list` results. `None` preserves the existing startup-provider behavior.

- [ ] **Step 1: Add the fail-first protocol serialization test**

Add a case beside `serialize_list_models` that serializes:

```rust
let request = ClientRequest::ModelList {
    request_id: RequestId::Integer(7),
    params: v2::ModelListParams {
        model_provider: Some("openai".to_string()),
        ..Default::default()
    },
};
```

Assert that `params.modelProvider == "openai"`. Keep the existing default serialization assertion and update it to include `"modelProvider": null`.

- [ ] **Step 2: Run the protocol test and verify RED**

Run:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server-protocol serialize_list_models -- --exact
```

Expected: compilation fails because `ModelListParams` has no `model_provider` field.

- [ ] **Step 3: Add positive and negative app-server behavior tests**

In `model_list.rs`, add a test fixture with a non-OpenAI bootstrap provider and two injected provider catalogs:

```rust
ModelListParams {
    cursor: None,
    limit: None,
    include_hidden: Some(false),
    model_provider: Some("openai".to_string()),
}
```

The positive assertion requires a unique visible OpenAI model and its exact reasoning metadata. The negative assertion requires a hidden OpenAI model to be absent when `include_hidden` is false. Add an unknown-provider request and assert JSON-RPC invalid-request rather than silently falling back to the startup provider.

- [ ] **Step 4: Run the app-server tests and verify RED**

Run:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-app-server --test all model_list -- --nocapture
```

Expected: the provider-scoped test fails because the request cannot choose a provider.

- [ ] **Step 5: Implement the minimal provider-scoped catalog path**

Add the optional field:

```rust
#[ts(optional = nullable)]
pub model_provider: Option<String>,
```

In `CatalogRequestProcessor::model_list`, resolve the manager as follows:

```rust
let models_manager = match params.model_provider.as_deref() {
    None => self.thread_manager.get_models_manager(),
    Some(provider_id) => {
        let provider = self.config.model_providers.get(provider_id).cloned()
            .ok_or_else(|| invalid_request(format!("unknown model provider: {provider_id}")))?;
        codex_model_provider::create_model_provider(
            provider,
            Some(Arc::clone(&self.auth_manager)),
        )
        .models_manager(
            self.config.codex_home.to_path_buf(),
            self.config.model_catalog.clone(),
        )
    }
};
```

Change `supported_models` to consume a `SharedModelsManager`, then list with `RefreshStrategy::OnlineIfUncached`. Keep pagination and hidden-model filtering unchanged.

- [ ] **Step 6: Run focused protocol and app-server tests and verify GREEN**

Run both commands from Steps 2 and 4. Expected: provider-scoped positive and negative cases pass, and the legacy default request remains compatible.

- [ ] **Step 7: Commit the backend slice**

Stage only the five files listed above and commit:

```bash
git commit -m "fix(models): list catalogs by provider"
```

---

### Task 2: Refresh and retain the authenticated OpenAI catalog in the TUI

**Files:**
- Create: `codex-rs/tui/src/app_server_session/models.rs`
- Create: `codex-rs/tui/src/chatwidget/model_popup_state.rs`
- Modify: `codex-rs/tui/src/app_server_session.rs`
- Modify: `codex-rs/tui/src/app_event.rs`
- Modify: `codex-rs/tui/src/app/event_dispatch.rs`
- Modify: `codex-rs/tui/src/chatwidget.rs`
- Modify: `codex-rs/tui/src/chatwidget/constructor.rs`
- Modify: `codex-rs/tui/src/chatwidget/model_popups.rs`
- Modify: `codex-rs/tui/src/model_catalog.rs`
- Test: `codex-rs/tui/src/app/tests/model_catalog.rs`
- Test: `codex-rs/tui/src/chatwidget/tests/popups_and_settings.rs`
- Test: `codex-rs/tui/src/chatwidget/snapshots/`

**Interfaces:**
- Consumes: Task 1's `ModelListParams.model_provider` and current Codex's `FetchModels`/`ModelsLoaded` request-ID pattern from sibling commit `5fc7840c`.
- Produces: provider-keyed model catalogs and in-place picker refresh that preserves the highlighted row and any open reasoning child.

- [ ] **Step 1: Write the fail-first provider catalog tests**

Add a test that starts the TUI with a static non-OpenAI catalog, feeds a successful OpenAI `ModelsLoaded` result containing `unique-openai-model`, opens `/model`, and asserts the unique model appears under OPENAI with its source metadata. Add these negative cases:

```rust
assert!(!picker_text.contains("hidden-openai-model"));
assert!(!picker_text.contains("gpt-5.6-sol")); // no fabricated fallback row
```

Also assert that a stale request ID, an empty response, or an error leaves the last usable catalog intact.

- [ ] **Step 2: Run the TUI catalog tests and verify RED**

Run:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui --lib model_catalog -- --nocapture
```

Expected: the unique model is absent because Elpis still renders its hardcoded OpenAI group.

- [ ] **Step 3: Port the smallest live-refresh state machine from current Codex**

Introduce provider-aware events:

```rust
FetchModels {
    request_id: uuid::Uuid,
    provider_id: Option<String>,
}
ModelsLoaded {
    request_id: uuid::Uuid,
    provider_id: Option<String>,
    result: Result<Vec<ModelPreset>, String>,
}
```

`AppServerSession::fetch_models` sends `model/list` with `model_provider: provider_id.clone()`. `ChatWidget` tracks the latest request ID per provider and ignores stale, failed, and empty responses. Extend `ModelCatalog` with provider-keyed storage while retaining its current primary-catalog API for unrelated callers.

- [ ] **Step 4: Replace the hardcoded OpenAI fallback with the fetched catalog**

Change `push_openai_model_group` to read the OpenAI provider catalog, filter `show_in_picker`, and attach the full `ModelPreset` to the selection action. If the catalog is unavailable, show one non-selectable explanation row; do not synthesize Sol, Terra, or Luna.

When `/model` opens from a non-OpenAI provider, render cached choices immediately and dispatch a new OpenAI fetch. When OpenAI is active, fetch OpenAI as the primary catalog. Refresh the open parent picker in place and preserve the selected model name.

- [ ] **Step 5: Run the TUI catalog tests and verify GREEN**

Run the command from Step 2. Expected: the unique visible model appears, hidden and fabricated rows do not, stale/error/empty results retain the last usable list, and highlight preservation passes.

- [ ] **Step 6: Commit the catalog UI slice**

Stage only the Task 2 files and commit:

```bash
git commit -m "fix(tui): refresh OpenAI models from account catalog"
```

---

### Task 3: Carry provider, model, and reasoning as one selection

**Files:**
- Modify: `codex-rs/tui/src/app_event.rs`
- Modify: `codex-rs/tui/src/chatwidget/model_popups.rs`
- Modify: `codex-rs/tui/src/app/event_dispatch.rs`
- Modify: `codex-rs/tui/src/app/thread_settings.rs`
- Modify: `codex-rs/tui/src/config_update.rs`
- Test: `codex-rs/tui/src/chatwidget/tests/popups_and_settings.rs`
- Test: `codex-rs/tui/src/config_update_tests.rs`
- Test: relevant TUI snapshots under `codex-rs/tui/src/chatwidget/snapshots/`

**Interfaces:**
- Consumes: Task 2's provider-scoped `ModelPreset` and the existing thread-settings update RPC.
- Produces: one provider-aware selection payload and one config batch containing `model`, `model_provider`, and `model_reasoning_effort`.

- [ ] **Step 1: Write fail-first picker behavior tests**

For an OpenAI preset with two unique efforts, select the model row and assert that the reasoning popup opens and that no update or persistence event has yet fired. Escape the popup and assert no model, provider, effort, or persistence event fires. For a preset with one supported effort, assert the action applies exactly that effort without inventing another choice.

- [ ] **Step 2: Write the fail-first persistence test**

Change the provider-aware builder contract to:

```rust
build_provider_model_selection_edits(
    "unique-openai-model",
    "openai",
    Some(&ReasoningEffort::High),
    None,
)
```

Assert exact edits for `model`, `model_provider`, `model_reasoning_effort = "high"`, disabled auto-routing, and cleared context-window override. Retain a negative local-provider case that passes `None` and explicitly clears stale effort.

- [ ] **Step 3: Run the picker and config tests and verify RED**

Run:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui --lib model_reasoning_selection -- --nocapture
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui --lib config_update_tests -- --nocapture
```

Expected: cross-provider OpenAI selects immediately instead of opening reasoning, and provider persistence clears reasoning effort.

- [ ] **Step 4: Implement one provider-aware selection event**

Replace the model-only provider events with payloads that include effort:

```rust
ApplyProviderModelSelection {
    provider_id: String,
    model: String,
    effort: Option<ReasoningEffort>,
}
PersistProviderModelSelection {
    provider_id: String,
    model: String,
    effort: Option<ReasoningEffort>,
}
```

Carry the provider ID through the ordinary and advanced reasoning popups. After the final effort choice, update local TUI state, send one thread-settings update containing provider/model/effort, then persist the same tuple. Escape emits nothing.

- [ ] **Step 5: Make persistence retain supported reasoning**

Change `build_provider_model_selection_edits` so `Some(effort)` writes `model_reasoning_effort`; `None` clears it. Keep local-provider callers passing `None`. Preserve the existing auto-routing and context-window behavior.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run both commands from Step 3 plus the focused thread-settings tests:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo test -p codex-tui --lib thread_settings -- --nocapture
```

Expected: positive and negative picker, cancellation, thread-settings, and config-edit cases pass.

- [ ] **Step 7: Commit the atomic selection slice**

Stage only the Task 3 files and commit:

```bash
git commit -m "fix(tui): retain reasoning across provider switches"
```

---

### Task 4: Verification and user handoff

**Files:**
- Modify only if evidence changes: `TASKS.md`
- Inspect: all files changed by Tasks 1-3

**Interfaces:**
- Consumes: all prior tasks.
- Produces: automated evidence and a manual acceptance checklist; it does not mark the task verified.

- [ ] **Step 1: Check disk and changed-file scope**

Run:

```bash
du -sh codex-rs/target
git status --short
git diff --check
```

Confirm no auth, state, goal, checkpoint, memory, pruning, or unrelated files changed.

- [ ] **Step 2: Format only edited Rust files**

Run `rustfmt` on the explicit paths changed by Tasks 1-3. Do not run repository-wide formatting.

- [ ] **Step 3: Run focused regression checks**

Run the green commands from Tasks 1-3 again and record exact pass/fail counts.

- [ ] **Step 4: Run the applicable compilation check**

Run:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo check --workspace --all-targets --exclude codex-sandboxing
```

Report any known baseline failure separately from failures introduced by this branch.

- [ ] **Step 5: Build without installing or restarting**

Run the narrow package build that produces `elpis`. Do not replace the installed binary during this task unless Masih explicitly asks after reviewing the evidence.

- [ ] **Step 6: Verify protected state and processes**

Compare pre/post metadata or hashes for `~/.codex/auth.json` and `~/.elpis/auth.json`. Confirm no process-control command was executed. Do not print file contents.

- [ ] **Step 7: Update task evidence without claiming user acceptance**

Record automated results in `TASKS.md` and leave the status as implemented or awaiting user acceptance. Commit only the evidence update.

- [ ] **Step 8: Hand Masih the manual acceptance path**

Ask Masih to launch Elpis naturally, open `/model` from a non-OpenAI provider, choose a currently available OpenAI subscription model, select an advertised reasoning level, reopen `/model`, make one turn, and confirm provider/model/effort plus prior context remain visible. Only Masih's acceptance can mark the behavior verified.

## Deferred Upstream Improvements

- Max/Ultra effort ignition animation: valuable UI parity, but separate from the functional repair and must not block it.
- Per-turn cost telemetry: useful for Elpis evaluation, but independent of model selection.
- Memory-search telemetry: Codex's current implementation measures explicit substring memory tools, not semantic RAG. Elpis must keep retrieval in an external MCP service.
- Rate-limit banners and newer reliability metrics: audit separately after the picker is accepted.
