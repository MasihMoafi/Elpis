# Elpis editor completion

## Current candidate — extension 0.1.11

The Codex login option uses the locally saved Codex ChatGPT account through transient runtime authentication; Elpis configuration and history remain in Elpis home. The previously selected Elpis login was a different account. A live Luna reply succeeded using the Codex account, whose usage endpoint reported 37% used. Send now uses neutral theme colors and SVG Send/Stop icons.

Runtime-backed settings, Ask/Auto/Full permissions, same-conversation model/mode changes, markdown/code copying and expandable tool results are implemented. Returning to the configured model preserves the thread, including the runtime's compatibility-compaction path. History supports rename, archive, restore and resume with workspace validation. Tool history includes editor tools, native commands/files, MCP results and reasoning summaries. Raw reasoning is not displayed. Auto preserves version checks, cancellation and undo; Full requires affirmative confirmation. Native modal responses are substituted in VS Code test mode.

Evidence: 28 Node checks and 43 editor/runtime checks pass in run-1788935578722. The earlier installed replay run-1788933949054 also included a live Codex-account Luna turn: it read an unsaved sentinel, checked diagnostics, proposed/applied a fix through IDE tools, checked diagnostics again and left disk unchanged. Live OpenRouter/free also called editor_read and returned its tool-only sentinel. All eight offline OpenAI/OpenRouter/Anthropic/Gemini adapter positive/negative cases pass in the history worktree's providers-1788934647357. Formatting, exact code copying, archive/restore, and inert HTML/unsafe-link checks pass against actual VS Code. Direct Anthropic/Gemini live checks lack keys in the current environment. Full reference/settings parity and user acceptance remain open: all ten original screenshot files are absent at the supplied paths.

Reference update: the ten screenshot files were subsequently found in Trash and inspected. They remain available for comparison; no resend is needed. Remaining reference controls include review delivery, speed, context usage, queued/steered follow-ups, reasoning-level visibility, attachments, automatic IDE selection context and the header/menu layout. These are not claimed complete.

Requested reading: Simon Willison's [red/green TDD](https://simonwillison.net/guides/agentic-engineering-patterns/red-green-tdd/) and [how coding agents work](https://simonwillison.net/guides/agentic-engineering-patterns/how-coding-agents-work/). The evaluations above record failing reproductions and real tool-execution evidence rather than relying on generated-code inspection alone.

Older sections below are dated evidence, not the current installed-state report.

## Single Send/Stop and adapter reuse — extension 0.1.7

The composer has one Send control that becomes Stop during a turn. Clicking it interrupts the real runtime without submitting or discarding a draft; keyboard submission while busy does not become an accidental Stop. The separate Stop button is removed. The old UI failed the dedicated extra-button test (run-1788927652284).

Adapted codex-acp's Apache-licensed model/effort selection logic with pinned-source attribution in NOTICE. Selecting an explicit model within the same provider now keeps the thread and compatible thinking effort. The old installed build failed the chat-retention assertion (run-1788928429713). The revised evaluation asserts both the new model and prior conversation at the inference endpoint. Returning to the inherited configured model still resets the session; full parity is not claimed.

Twenty-three Node checks and 36 installed-editor/runtime checks pass, final `.test-data/run-1788928769595/result.json`. These include real unsaved editor reads, language tools, Reject/Apply, version protection, undo, thread resume, and combined Stop. The inference provider is controlled test code, while Elpis and VS Code are real. Screenshots `send-stop-active.png`, `send-stop-idle.png`, `edit-apply-review.png`, and `edit-applied.png` show the actual controls and edits. The real user's review window was reloaded to 0.1.7; `/tmp/elpis-0.1.7-review.png` records it. Live account quota remains external to these checks.

The filtered Zed clone now exists at `.test-data/upstream/zed`, without checkout, at `f29c8eaf13682ef5a4a70a81eb4838b247cf7211`. Source reuse details are in ZED-REUSE.md. Remaining deficits include full settings and approval-mode parity, archive controls, and live vendor acceptance; user acceptance remains open.

## Model/thinking repair — extension 0.1.6

Masih's actual review window was still loading 0.1.3 assets despite later packages being installed. Its selected model was Luna in both workspace settings and runtime identity; its failed reply reported an account usage limit. The same window now loads 0.1.6, with its saved chat restored and the composer Thinking picker opened for inspection.

A real-editor test reproduced the model-selection/Send race before the fix (`run-1788911498774`). Send now locks immediately while selection is saved, retaining the draft until acknowledgment. Thinking has a direct composer control populated from advertised capabilities. Failed turns render their error in the conversation; JSON provider errors show their message, with wrapping to prevent sidebar overflow.

Twenty-two Node checks and 36 installed-editor checks pass (`.test-data/run-1788912120897/result.json`). The controlled inference endpoint asserted both the selected model ID and high reasoning effort before returning a reply; a rejected request visibly reports its error. Screenshots `model-thinking-selected.png` and `provider-failure.png` record the behavior. Actual-window screenshot: `/tmp/elpis-0.1.6-thinking-review.png`. No successful live inference through the quota-limited account is claimed.

Known limitation: runtime history returned the user's old failed turn as completed with no error metadata. Existing errors cannot be recovered from that response; error-bearing history responses are rendered when supplied. Human acceptance and broader reference parity remain open. Unfinished approval-mode changes are isolated in the sibling provider-completion worktree and are not included in 0.1.6.

## Runtime approval review — extension 0.1.5

Installed replay: 35 checks passed with no failure in `.test-data/run-1788900947127/result.json`. The approval sentinel test also passed against the installed extension's Session and bundled runtime. Installed version is 0.1.5; existing user windows were not reloaded.

Native command, file-change and permission requests now reach an explicit reviewer instead of being automatically rejected. Commands show their command/directory; file changes require a received diff and open that diff; permission requests display the requested profile and grant only turn scope. Cancellation invalidates pending decisions immediately. Editor buffer edits retain their existing versioned review. IDE context is now toggled beside the composer model picker.

Twenty Node tests passed. The real bundled runtime requested approval for a controlled command: rejection left the sentinel absent, acceptance created it (`node test/approval-runtime.js`). Thirty-five editor checks passed in `.test-data/run-1788900729635/result.json`; the narrow composer screenshot was inspected. Native file-change and permission review have callback-level coverage, not yet full runtime/UI acceptance. The native modal itself has not been visually exercised here. Full-access and automatic-review policy selection remain unimplemented; this is not full reference parity.

## Provider catalogs — extension 0.1.4

Installed-package replay: all 35 checks passed with no failure in `.test-data/run-1788899857342/result.json`. Extension 0.1.4 is installed in the normal VS Code profile; existing windows may retain their loaded version until reloaded.

OpenRouter, Anthropic and Gemini now load provider catalogs instead of bundled suggestions. Native/OpenAI still use Elpis `model/list`. Anthropic/Gemini keys come from the selected provider's SecretStorage entry or its environment key; keys never enter the webview or query strings. Errors leave custom model entry available. Catalog availability does not prove a selected model will accept inference or tools.

The catalog-only sentinel test failed on the old lists before implementation. Fifteen Node checks and 35 editor/runtime checks passed (`.test-data/run-1788899546818/result.json`), including provider-only fixture selections, cancellation and credential routing. Live no-proxy OpenRouter catalog access failed to connect; no live vendor success is claimed. Existing approval/settings parity gaps remain open.

API references: [OpenRouter models](https://openrouter.ai/docs/api-reference/list-available-models), [Anthropic models](https://platform.claude.com/docs/en/api/models/list), [Gemini models](https://ai.google.dev/api/models).

## Sidebar, model menu and history — extension 0.1.3

Final installed replay after the inherited-model selection correction: all 35 checks passed in `.test-data/run-1788898093511/result.json`. The dedicated review window was reloaded and the actual user catalog opened in the sidebar; no inference was requested.

Verification: ten Node checks and 35 full editor/runtime/UI checks passed; the installed replay is in `.test-data/run-1788897804070/result.json`. Actual-home sidebar catalog screenshot: `.test-data/sidebar-review/sidebar-models.png`. Sidebar/menu/history and theme screenshots were inspected. Inherited configuration remains labelled "Configured model" until the runtime identifies it; a recommended catalog default is not presented as the user's configured selection.

Open Chat now opens an Elpis view in VS Code's secondary sidebar, leaving the editor visible. The composer has an in-place, searchable model menu fed by Elpis, with supported reasoning levels sent as `turn/start.effort`. Escape and outside clicks dismiss the menu without changing selection. The runtime/default model source and custom IDs remain available; non-native vendors retain their previously documented suggestions.

History searches persisted editor chats from the current project, supports additional pages, restores transcripts, and resumes the underlying thread after restarting the app-server. The eval resumes a chat and reads a new unsaved marker through its retained editor tools; negative cases cover unmatched search and foreign-workspace reads. It lists editor-source chats in the selected workspace, not every TUI session in Elpis's home.

Settings opens VS Code's real Elpis settings; Open config.toml opens the current runtime home's file without changing it. The Enter/Ctrl+Enter preference updates live; Shift+Enter inserts a newline. Keyboard checks use CDP pointer events to focus the sidebar input. Other webview button checks use DOM clicks with visibility assertions; native picker controls use Playwright. Native pruning confirmation still uses the previously documented test substitution.

This candidate targets the installed VS Code 1.136 API for secondary-sidebar contribution. The complete custom settings page and broader Codex approval/account parity are not implemented. Native tools remain read-only and editor edits require review. Multi-folder windows select a project when the view is first opened.

## Runtime catalog correction — extension 0.1.2

Installed verification: eight Node tests and 30 editor/runtime/UI checks passed. Evidence: `.test-data/run-1788895607422/result.json`. The actual user-home model catalog is captured separately in `.test-data/catalog-review/actual-elpis-models.png`; no model generation was requested for that review.

The 0.1.1 native/OpenAI picker was wrong: a short static list hid current Elpis models. Those choices now come from the selected runtime's `model/list`, using the configured Elpis home and executable without starting a chat thread. Pagination and hidden models are respected. Catalog errors are displayed, with current/custom choices still available; no stale native list is substituted. Other vendors still have bundled suggestions, not live vendor catalogs.

A direct read-only probe of the bundled runtime against the user's Elpis home returned GPT-6-Astra, GPT-5.6-Sol/Terra/Luna, GPT-5.5 and Codex Spark. The regression supplies a model only through a real runtime catalog and selects it in the editor. Node checks cover pagination, hidden entries, errors and the absence of a thread/start request. `CODEX-REFERENCE.md` records the remaining interface requirements from the user's screenshots; this correction does not claim sidebar/history/settings parity.

## Model picker and chat layout — 0.1.1

Installed-package replay: all 29 checks passed in `.test-data/run-1788893559630/result.json`, including the narrow viewport with a long custom model name. Version 0.1.1 is installed in the normal profile, and a fresh review window was opened. Visual acceptance remains Masih's.

The model control now opens searchable, named suggestions for OpenAI, OpenRouter, Anthropic and Gemini. A custom-ID option remains available; cancelling either picker preserves the existing selection. Suggestions are bundled and work offline, not an account-specific or exhaustive live model catalog. A listed model does not imply your account can use it. IDs were checked against the OpenAI model docs, Anthropic model documentation and Gemini model documentation on 2026-09-08; OpenRouter uses its routed IDs.

The chat now has a compact header, settings toggle, welcome view, rounded composer, pinned input and independently scrolling conversation. daisyUI sizing/radius variables accompany the IDE color mapping. New messages follow the bottom unless the reader has scrolled up. Settings are accessible via the top-right ellipsis, and provider/model selection is inside the composer.

Verification: six Node checks (including a failing-before model-choice regression) and 29 real editor/runtime/UI checks in `.test-data/run-1788893333733/result.json`. The UI test chooses named models from all four providers, enters a custom ID, cancels a model selection, and verifies the saved settings. Light/dark/high-contrast and narrow-layout screenshots were inspected. Narrow layout keeps Send inside the viewport without horizontal scrolling. Existing controlled-provider/runtime tests remain; no new live-vendor acceptance is claimed.

User review: click the model name at the bottom of the composer, choose a provider, then choose a named model. Confirm the layout in your usual IDE theme and width. API key, runtime, editor access and experimental pruning are under the ellipsis.

Model references: https://developers.openai.com/api/docs/models/all ; https://platform.claude.com/docs/en/models/overview ; https://ai.google.dev/gemini-api/docs/models ; https://openrouter.ai/docs/api-reference/list-available-models .

This branch continues the concise experiment candidate. It is an implementation for review, not Masih-accepted parity with the Codex extension.

## Priorities and scope

Installed-package replay also passed all 27 checks: `.test-data/run-1788886322140/result.json`, using the normal-profile installation and its bundled runtime. The pruning-modal substitution limitation below still applies.

Theme/control follow-up (2026-09-08): a failing light-theme reproduction preceded removing the forced dark theme. daisyUI now uses VS Code's live semantic colors. The expanded control audit exposed another real bug: provider, model and editor-access controls wrote folder settings without declaring resource scope. These settings now declare that scope.

Verification: 27 passing checks in `.test-data/run-1788885785640/result.json`, plus five Node tests. This count includes three theme checks repeated with a populated conversation. Light, dark and high-contrast screenshots in that directory were visually inspected. Coverage includes provider/model and runtime pickers, cancelled selection, masked key storage/removal, editor-access toggling, Send, active/idle Cancel, reconnect, actual edit approval/rejection and undo, and pruning through the real runtime. VS Code refuses native modal dialogs in extension-test mode, so pruning confirmation responses are substituted; the test does not prove the native dialog appearance or mouse interaction. Runtime selection uses VS Code's simple file dialog. Webview clicks use DOM automation, not physical mouse hit testing.

The corrected Linux package was built and installed in the normal VS Code profile, and the Elpis review window was opened. Live vendor connectivity and final user acceptance remain outstanding. Review checklist: switch light/dark themes with Elpis open; choose a provider/model; send a message; cancel a running turn; reject/apply a proposed edit; check the experimental Prune confirmation before approving it.

1. Repair final-only replies and false-success test reporting.
2. Make provider selection real: OpenAI, OpenRouter, Anthropic and Gemini; exact model IDs; keys in VS Code SecretStorage; existing Elpis authentication/home preserved.
3. Repair provider tool loops, then verify real editor interaction and package a Linux extension with its Elpis app-server.
4. Human acceptance and remaining Codex-style interface features: sidebar integration, conversation history/resume, richer Markdown/diffs and other IDE hosts.

Both old agents stopped after a bounded experiment. The live-model failures recorded then were account/model failures, not evidence of lost internet service.

## What changed

Provider/model, API key and Runtime buttons are available in chat. Selecting a different provider/model starts a new conversation so one provider's conversation is not silently forwarded to another. Exact model IDs are editable; displayed presets are convenience defaults, not availability guarantees. The extension adds no proxy or model service.

Keys are entered through a native password input and stored by VS Code SecretStorage, never passed to the webview. Clearing a stored override restores existing environment/runtime authentication; it does not erase environment credentials. A Linux package can include `bin/elpis-app-server`; explicit machine-scoped runtime settings take precedence. Elpis's home remains `ELPIS_HOME` or `~/.elpis` unless explicitly configured.

OpenRouter's actual built-in route is Chat Completions, despite older provider documentation describing Responses. The runtime previously ignored streamed tool calls and omitted their results from follow-up requests. The fix accumulates fragmented calls, preserves IDs and parallel calls, rejects truncated calls, and returns tool results in the proper role.

Gemini's native adapter previously lost function-call thought signatures. They now survive in a tagged opaque reasoning record in existing runtime history and return on the matching Gemini function-call part. Other provider requests filter these records out. This is not a new memory pipeline or a claim of complete vendor reasoning-feature parity. Signed text parts, vendor-hosted tools and multimodal parity remain outside the implemented tool-signature fix.

## Install and inspect

The final local Linux VSIX and runtime are generated artifacts under this directory; use the artifact paths reported after verification. In VS Code, run **Extensions: Install from VSIX**, then **Elpis: Open Chat** in a trusted local workspace. Select provider/model and enter an API key if needed. For an existing Elpis login, choose **Elpis configuration**. **Runtime** can select a separately built app-server; the TUI executable cannot serve this protocol.

The project adds no extension telemetry. Provider inference, existing Elpis session/audit persistence and VS Code's own behavior remain distinct; telemetry settings are not a guarantee that chats never leave the machine. These changes do not audit account-wide synchronization.

## Acceptance checklist

- Open chat and confirm the selected provider/model; send a small request.
- Add unsaved text in a TypeScript file; ask Elpis about it and navigate a definition/reference.
- Ask it to fix a diagnostic. Reject first, then approve; inspect the review and undo the edit.
- Edit the buffer while a proposal is pending; Elpis must preserve the newer version.
- Disable editor access, cancel a turn and reconnect; verify explicit failures/recovery.
- Use separate project/worktree windows and confirm each accesses its own buffers.

Passing automated checks does not constitute user acceptance.

## Recorded verification — 2026-09-08

- `cargo test --offline --locked -p codex-core --lib chat_completions::tests`: 13 passed. Includes fragmented/parallel Chat calls, malformed-call rejection, tool-result serialization, native endpoint/header fixtures, and serialized Gemini signature retention. Built the app-server with two low-priority jobs and isolated artifacts; existing compiler warnings remain. No whole-workspace test/clippy claim.
- `npm test`: five passed, including all four provider IDs reaching `thread/start`, selected-key environment mapping, final-only replies and duplicate-completion handling.
- Real app-server adapter evaluation: eight passed (four wire formats, each enabled/disabled). Tool-only facts reached the next inference request only when enabled; all replies rendered once. Signed Gemini function-call parts survived actual runtime history. Built-in endpoints cannot be overridden, so offline HTTP captures use custom fixture providers with the corresponding built-in wire formats; these do not establish live vendor acceptance.
- Installed VSIX/bundled-runtime replay: 16 editor/runtime/UI checks passed, no failure field. Real unsaved TypeScript reads, navigation/diagnostics, native Reject/Apply review, stale/cancelled edits, undo, cancellation/reconnect and controlled compression all exercised. Evidence: `.test-data/run-1788882391119/`; screenshot `chat.png`. Installed-runtime adapter captures: `.test-data/providers-1788882392302/`.
- The missing-runtime negative run now exits 1 and records ENOENT, correcting the original false-success launcher. Evidence: `.test-data/run-1788881448511/`.
- Linux x64 package installed successfully into an isolated VS Code profile. Its stripped bundled runtime SHA-256 is `cf0437dea13a0c96763b920a84b95b4d69c7a1c299f919e859b1d26842ec2f59`. No installed daily-driver replacement, merge, push or publication was performed.

The small live OpenRouter/free conversation timed out after 90 seconds; a separate 10-second direct authenticated connectivity check also returned `ETIMEDOUT`. This establishes a current direct-connectivity failure, not its cause or an exhausted internet allowance. OpenAI, Anthropic and Gemini API keys were absent from this process environment. No account/quota/authentication success is claimed for those vendors, and the previous blocked OpenAI account was not retried. The live synthetic test is explicitly opt-in: `test/provider-live.js`.

Current artifact: `elpis-editor-linux-x64.vsix` (about 87 MB), including its Elpis app-server. Install it through **Extensions: Install from VSIX**, then run **Elpis: Open Chat**. Rebuild locally with `npm run package:linux`; `ELPIS_APP_SERVER` may select an explicitly built runtime. The original experiment worktrees remain intact.

Remaining acceptance: live provider usage once connectivity/credentials permit, the provider/key pickers with Masih, and literal concurrent Git-worktree windows. The current suite exercises separate sessions/workspaces; it does not add a new paired-Git-worktree claim. Sidebar/history/Markdown parity is the next interface milestone. The installed TUI has not been replaced; the provider fixes currently ship in this branch's bundled app-server.

## Reuse research

[Zed's repository](https://github.com/zed-industries/zed) is primarily GPL-3.0-or-later, with Apache components where marked. Its [Codex ACP adapter](https://github.com/zed-industries/codex-acp) is Apache-2.0. Zed's multi-provider UI/runtime and the Codex adapter are different components. No Zed source was copied into this candidate; it uses the existing Apache-licensed Elpis/Codex runtime and native VS Code APIs.

Google documents the required [thought-signature round trip](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures). This motivated the failing signed-tool fixture, not a claim of live Gemini acceptance.
