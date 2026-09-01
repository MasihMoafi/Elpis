# OpenAI Model and Reasoning Selection

## Status

Approved in chat by Masih on 2026-08-31. This document records the acceptance
contract before implementation. Automated checks will be evidence; only Masih's
manual acceptance can mark the behavior verified.

## Intent

Restore Codex-quality OpenAI subscription model and reasoning selection inside
Elpis without logging out, copying credentials, restarting a running process, or
discarding Elpis-owned context and session state.

## Observed Failure

The current failure is a provider-transition defect, not a proven authentication
failure:

- the status-only Codex account RPC reports ChatGPT authentication;
- the affected Elpis session started on the static `openrouter/free` catalog and
  then switched its active thread to `openai` and `gpt-5.6-sol`;
- the TUI model catalog remains the catalog created for the startup provider;
- the fallback OpenAI group is hardcoded to Sol, Terra, and Luna rather than
  querying the authenticated OpenAI catalog;
- selecting one of those fallback entries does not open the reasoning picker;
- provider-aware persistence clears `model_reasoning_effort`.

This explains both user-visible symptoms: OpenAI's subscription catalog is not
available after a provider switch, and the same path removes the reasoning choice.

## Scope

### Included

1. Query the OpenAI model catalog through Elpis's existing ChatGPT authentication,
   even when the thread started on another provider.
2. Expose the returned visible OpenAI models in `/model` using their real metadata.
3. Open the supported reasoning-level picker before committing an OpenAI selection.
4. Apply provider, model, and reasoning to the active thread as one logical choice.
5. Persist provider, model, and reasoning together for later launches.
6. Keep `/model` usable after the mid-session provider switch without a restart.
7. Compare the affected path with the current committed sibling Codex checkout:
   catalog discovery, model visibility, reasoning metadata, selection, active-thread
   update, persistence, and status display.

### Excluded

- a wholesale import or merge from sibling Codex;
- a full audit of all requirements R1 through R12;
- changes to authentication format or credential ownership;
- changes to pruning, compaction, memory, permissions, or session history;
- redesign of Auto routing, OpenRouter, Ollama, Anthropic, Gemini, or Bedrock;
- release, tag, push, or automatic process restart.

## Constraints

1. Reuse the existing Elpis `AuthManager`; never render, log, copy, or migrate a
   bearer token.
2. Do not modify `~/.elpis/auth.json`, `~/.codex/auth.json`, state databases, goals,
   checkpoints, or memories during build and automated verification.
3. Do not stop, signal, replace, or restart a running Elpis or Codex process.
4. Preserve provider-neutral session state when changing the inference provider.
5. Keep protocol extensions backward-compatible through optional fields.
6. Make the smallest change that passes the behavioral acceptance harness.
7. Work only in `fix/openai-model-reasoning-picker` until Masih accepts integration.

## Requirements and Acceptance Tests

### R1. Authenticated OpenAI catalog is reachable after another provider starts the session

When the active bootstrap provider is not OpenAI and ChatGPT authentication is
present, Elpis requests the OpenAI catalog through the same app-server, auth manager,
and cache/refresh semantics used by the Codex model-list path. `/model` shows the
visible models returned by that path.

Acceptance test: bootstrap with a static non-OpenAI catalog and a mocked authenticated
OpenAI catalog containing a unique model. Assert that the unique model appears under
OpenAI. The test must fail against the current hardcoded group.

Negative test: return a hidden OpenAI model and assert it is absent from the picker.

### R2. Model metadata controls reasoning choices

Selecting an OpenAI model with multiple supported reasoning levels opens the
reasoning picker and displays exactly those levels.

Acceptance test: supply a unique model with two unique effort values, select it, and
assert that the reasoning popup contains both and does not commit a selection yet.
The test must fail against the current direct-selection action.

Negative test: provide one supported non-advanced effort and assert Elpis applies only
that effort without inventing additional levels, matching Codex behavior.

### R3. Provider, model, and effort update the active thread together

After the user chooses an effort, the thread-settings update contains the OpenAI
provider ID, selected model, and selected effort in one request. The provider client
is rebuilt by the existing core settings path; the thread is not restarted.

Acceptance test: inspect the emitted thread-settings update and assert all three
fields are present. Assert there is no shutdown, resume, new-thread, or authentication
operation.

Negative test: cancel or escape the reasoning popup and assert that provider, model,
effort, and persisted configuration remain unchanged.

### R4. Persistence retains reasoning

The configuration batch produced by a provider-aware OpenAI choice writes `model`,
`model_provider`, and `model_reasoning_effort` together and disables Auto routing. It
must not clear the chosen effort.

Acceptance test: choose a specific effort and assert the generated edits contain all
three values. The test must fail against the current provider selection builder,
which clears `model_reasoning_effort`.

Negative test: provider selections that do not support reasoning, such as the existing
local-model path, may explicitly clear stale effort and must not inherit an OpenAI-only
choice.

### R5. The picker remains correct after the switch

Once OpenAI becomes active, reopening `/model` uses the prefetched OpenAI catalog,
not the startup provider's static catalog and not a hardcoded fallback list.

Acceptance test: start from a non-OpenAI provider, complete an OpenAI selection, reopen
the picker, and assert that the unique authenticated OpenAI model remains selectable
with its reasoning metadata.

Negative test: assert that startup-provider models are not mislabeled as OpenAI models.

### R6. User state and processes are preserved

Automated work does not mutate authentication or continuity files and does not manage
running processes. Installing the built binary, if performed, uses an atomic sibling
replacement and affects only a future natural launch.

Acceptance check: compare the pre/post hashes and metadata of the two auth files and
confirm no process-control command was run. Masih then performs the real TUI check.

## Architecture

### Provider-scoped catalog request

Add an optional `modelProvider` field to the app-server `model/list` parameters. With
no field, behavior remains identical to Codex. With `openai`, the catalog processor
resolves the configured OpenAI provider, creates its model manager with the existing
app-server `AuthManager` and Elpis home, and uses the normal cache/online refresh policy.
No credential crosses the protocol boundary.

During TUI bootstrap, retain the normal startup-provider catalog. If the account is a
ChatGPT account and the startup provider is not OpenAI, request the OpenAI catalog once
and store it as the OpenAI provider's catalog. A failed auxiliary RPC must not abort TUI
startup; it yields an unavailable OpenAI group with an honest message. Network/cache
fallback inside a successful RPC retains the existing Codex model-manager semantics.

### Provider-aware TUI catalog

Extend the TUI catalog container to retain catalogs by provider while preserving the
existing primary-catalog API for unrelated callers. Model-picker code resolves models
against the currently active provider. The OpenAI group is built from the OpenAI
provider catalog and is absent or disabled when that catalog is unavailable; it is
never synthesized from three hardcoded slugs.

### Provider-aware reasoning selection

Carry an optional provider ID alongside a model preset through the existing reasoning
and advanced-reasoning popups. Ordinary same-provider selections retain the upstream
Codex path. A cross-provider OpenAI selection waits until the effort is chosen, then
emits one provider-aware selection event.

The app handles that event by updating local model and effort state, submitting one
thread-settings request containing provider, model, and effort, and persisting the
same values in one configuration batch. Existing core logic rebuilds the model client
when the provider changes, so no thread restart is introduced.

### Error behavior

- Auxiliary OpenAI catalog failure does not prevent Elpis from opening on another
  provider.
- The picker does not fabricate a separate hardcoded cross-provider model list; it
  renders only the provider-scoped catalog returned by the model manager.
- Persistence failure is surfaced using the existing model-selection error path.
- A thread-settings rejection leaves an error in the transcript; it is not described
  as a successful switch.
- Canceling any picker stage makes no state change.

## Expected Files

The implementation may touch only the narrow path confirmed by fail-first tests:

- `codex-rs/app-server-protocol/src/protocol/v2/model.rs`
- `codex-rs/app-server/src/models.rs`
- `codex-rs/app-server/src/request_processors/catalog_processor.rs`
- `codex-rs/tui/src/app_server_session.rs`
- `codex-rs/tui/src/model_catalog.rs`
- `codex-rs/tui/src/chatwidget/model_popups.rs`
- `codex-rs/tui/src/app_event.rs`
- `codex-rs/tui/src/app/event_dispatch.rs`
- `codex-rs/tui/src/app/thread_settings.rs`
- `codex-rs/tui/src/config_update.rs`
- colocated tests and snapshots for those files.

If implementation requires authentication, context, session-history, or provider-core
changes outside this list, stop and return to Masih for a scope decision.

## Evaluation

1. Add positive and negative behavioral tests and demonstrate the relevant tests fail
   before production changes.
2. Implement the minimum code necessary for those tests.
3. Run focused tests for protocol serialization, provider-scoped catalog listing,
   model/reasoning popup events, thread-settings construction, and config edits.
4. Check disk usage and run applicable Rust checks with
   `CODEX_SKIP_BWRAP_BUILD=1`, formatting only edited files.
5. Build the `elpis` binary. If the installed binary is updated, replace it atomically
   without restarting a process or touching authentication.
6. Produce a critical-path comparison against sibling Codex with each item marked
   `pass`, `fail`, or `unverified`.
7. Give Masih this manual acceptance path:
   - launch Elpis naturally;
   - open `/model` from a non-OpenAI provider;
   - select a currently available OpenAI subscription model;
   - select one of that model's advertised reasoning levels;
   - reopen `/model` and confirm the selection remains available;
   - make one real turn and confirm the visible provider, model, and effort;
   - confirm the prior goal, context, and conversation remain present.

Passing automated checks reaches test evidence only. The task remains unverified until
Masih completes and accepts the manual path.
