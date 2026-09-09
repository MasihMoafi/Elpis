# Zed reuse checkpoint — 2026-09-08

Clone result, 2026-09-09: `gh repo clone zed-industries/zed ... -- --depth 1 --filter=blob:none --no-checkout` succeeded with proxy disabled. Local repository is `.test-data/upstream/zed`, HEAD `f29c8eaf13682ef5a4a70a81eb4838b247cf7211`. This is a filtered Git clone without a working-tree checkout; selected useful source files are separately available under `.test-data/upstream/zed-ui`. No full build or complete checkout is claimed.

2026-09-09: retrieved the actual Zed `message_editor.rs`, `config_options.rs`, and `agent_model_selector.rs`, plus codex-acp's `codex_agent.rs` and `thread.rs`. Adapted Apache-licensed `handle_set_config_model` into `src/model-catalog.js::effortForModel`: retain supported effort, otherwise use the advertised default; raw model IDs retain existing effort. Explicit model changes now update the existing thread through Elpis's turn/start instead of discarding chat. Attribution is in NOTICE. This is actual bounded code adaptation, not an imported Rust/GPUI UI.

Pinned adapter source: `c81fa46d897275ed014065a3947596bf0fd1975b`; downloaded pinned `src/thread.rs` SHA-256 `c8b8d4687ba06d4bed71a6be792b035285c5fadf61748947191fafbe2b988c31` matches the inspected source. The installed old build failed the chat-retention test (run-1788928429713); the updated development build passed all 36 checks (run-1788928518392), including preservation of prior messages at the real inference endpoint.

Zed's configuration UI consumes agent-advertised select/boolean options and calls the adapter to apply them. Full dynamic settings parity remains open; no GPL UI implementation was copied. A fresh filtered/no-checkout clone is in progress after GitHub connectivity recovered; earlier failures below are historical, not current evidence of blockage.

Masih explicitly requested cloning and reusing Zed, rather than recreating existing functionality. The normal VS Code profile now has the review VSIX installed. A separate Elpis-review window has opened the chat through a temporary development launcher; its marker is `.test-data/review-driver/opened.json`.

The requested shallow clone via `gh repo clone zed-industries/zed ... -- --depth 1 --filter=blob:none`, with the proxy disabled, failed: GitHub GraphQL connection timed out. No successful local checkout or copied Zed implementation is claimed. The clone destination is `.test-data/upstream/zed` when connectivity is restored. No repeat download or proxy change was attempted.

Published source inspected independently:

| Component | Declared license | Reuse implication |
| --- | --- | --- |
| `crates/agent_ui` | GPL-3.0-or-later | Native Rust agent UI, depends on GPUI and many editor/agent crates; not a drop-in VS Code webview. |
| `crates/language_models` | GPL-3.0-or-later | Multi-provider orchestration, depends on provider and editor integration crates. |
| `crates/open_ai` | GPL-3.0-or-later | Provider client source can inform/reuse under its GPL terms; not Apache merely because the Codex repository is Apache. |
| `crates/gpui` | Apache-2.0 | Rust native UI framework; potentially useful for a standalone Elpis app, rather than a VS Code webview. |
| `zed-industries/codex-acp` | Apache-2.0 | Codex/ACP adapter, distinct from Zed's UI and provider stack. |

Sources: https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent_ui/Cargo.toml ; https://raw.githubusercontent.com/zed-industries/zed/main/crates/language_models/Cargo.toml ; https://raw.githubusercontent.com/zed-industries/zed/main/crates/open_ai/Cargo.toml ; https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/Cargo.toml ; https://github.com/zed-industries/codex-acp . These are mutable main-branch manifests, not pinned checkout evidence.

Apache-2.0 allows commercial use and modification/distribution subject to its terms, including license/notice preservation and marking modified files. It is not a noncommercial license. Zed's components have their own licenses. No project-wide relicense or GPL code import has been performed.

Next implementation gate: obtain the checkout, pin its revision, identify a bounded reusable provider/agent component and its dependencies, and retain its license. Reuse does not remove the need to test the integration with Elpis's tools and context projection. Keep the existing review build available while assessing that boundary.

The existing fixes were demonstrated by failing local real-runtime reproductions followed by passing provider round trips (including missing/disabled controls). They fix our fork/adapter integration, not vendor services. Live acceptance remains open; details and evidence paths are in COMPLETION.md.

Follow-up, 2026-09-08: all download attempts explicitly ran `nope`. The filtered shallow/no-checkout clone stopped at gh's GraphQL lookup; API tarball, codeload and GitHub archive routes timed out. The failed archive downloads received zero bytes, so large source files were not the demonstrated cause. Raw source downloads through `gh api --method GET https://raw.githubusercontent.com/...` succeeded: both licenses, agent_ui manifest and entry source, language_models manifest and entry source, and OpenAI, Google, Anthropic and OpenRouter provider implementations are now under ignored `.test-data/upstream/zed-source/` (227,179 bytes total). This is a selected main-branch source snapshot, not a complete or revision-pinned Git checkout. No downloaded implementation has been imported into Elpis. Pin a revision and retrieve required dependencies before integrating any of it.
