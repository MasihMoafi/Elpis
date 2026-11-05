# Elpis desktop

A Next.js/shadcn app in an Electron window, connected to the private Elpis runtime socket. Browser and desktop share one interface and native thread storage. Requirements are in [SPEC.md](SPEC.md); verification commands and opt-in checks in [TESTING.md](TESTING.md).

## Run

From this directory: `npm ci`, `npm run build`, then `npm run desktop` (or `desktop/launch.sh`). The desktop starts or reuses the installed Elpis runtime; no terminal window is needed. `ELPIS_ENGINE_BIN` selects another installed engine with its bundled provider bridge. For a browser, start Elpis, run `npm run web` and open its private URL. `ELPIS_APP_BRIDGE_SOCKET` selects an existing Unix socket and disables automatic runtime startup. `desktop/launch.sh --desktop-entry` prints a `.desktop` launcher for this checkout (`StartupWMClass=elpis-desktop`, the Elpis website's mark as icon); the script installs nothing.

The ready-made Logo workflow traces with SVG Studio, which is not in this repository. Its Tracer's shell reads, from the environment Elpis starts with, `SVG_STUDIO_MODULE` (SVG Studio's built `mcp-server/dist/vectorize.js`, default `~/Desktop/p/svg/mcp-server/dist/vectorize.js`) and `ELPIS_LOGO_SCRIPTS` (the logo skill's `scripts` folder, default `~/Desktop/p/skills/logo/scripts`). When either is missing, the Tracer stops and says so.

## Connection and restore

Closing the app leaves the shared runtime and its conversations running. After a runtime disconnect the app reconnects, restores subscriptions and refreshes state, keeping the composer draft. A write whose result is unknown is never replayed automatically; inspect the conversation before resending.

The desktop restores the selected chat, exact unsent drafts, named projects and appearance after reopening, whatever its loopback port. The optional web version keeps per-window draft recovery. Failed sends keep their text; retrying a failed first agent message uses the conversation already created.

Provider history is paged within the desktop connection's size limit. A history item larger than the page budget produces an explicit error; its saved content is kept.

## Chats, projects and agents

Chat names, sidebar sections, search and deletion are requirements: [SPEC](SPEC.md#sidebar-and-chat-list) items 1–11. Headless (`exec`) runs and chats with no listed maker sit in Background runs, Workflow runs in Workflows; both sections are off by default. Deleting a chat deletes its agents; a chat with forks is archived instead, so the forks keep working (`bridge/client.mjs`).

Projects use existing folders, chosen natively or by absolute path. Switching projects sets the folder for new work and filters chats by their recorded folder; existing chats keep their own folder. Unavailable or duplicate folders and storage failures are reported.

The Context Ledger's Subagents switch permits delegation when on; it never requires spawning an agent. A change applies from the next turn, also in an open chat.

## Models and providers

A chat's model and reasoning effort can change for its next turn. Switching provider mid-chat is limited to subscription models, because the engine has no per-turn provider. Leaving a subscription model for a native model waits for the current subscription turn to finish; a busy switch is rejected and keeps the current selection. Changing an arbitrary API provider needs a new conversation. Providers are labelled from the model prefix (`claude/` Claude subscription, `agy/` Gemini/Antigravity).

Provider edits, including clearing a stored key, apply to new conversations and agents. Existing conversations keep their original provider configuration and credentials; clearing a stored key does not revoke them at the provider. A workflow's workers use the provider configuration captured by its root, so start a new root conversation to use changed settings there.

## Settings

Fourteen pages, modelled on the ChatGPT app: General, Notifications, Appearance, Keyboard shortcuts, Voice, Personalization, Models & accounts, MCP servers, Usage & limits, Git, Worktrees, Hooks, Configuration and Archived chats. General and Notifications are saved on this device (`lib/preferences.ts`; the desktop reads Confirm before closing natively); everything else goes through the native versioned config writer with stale-write protection.

- **Models & accounts** shows each provider's own sign-in (OpenAI/ChatGPT, Claude, Gemini) and edits OpenRouter, local and custom API endpoints using the native Responses protocol. API keys can be replaced or cleared and never reach the renderer. Explicit API providers use their own credentials and model IDs. Managed or command-based authentication stays read-only.
- **MCP servers** lists the configured servers with credential presence only, and adds, removes or enables them. RAG appears there with its provider, model and key settings; `/rag` instructions use one canonical prompt across providers.
- **Voice** sets WhisperType's OpenRouter model and the fallback engine.
- **Usage & limits** shows each account's limits and the selected chat's context.
- **Personalization** holds custom instructions (`developer_instructions`) and memories.
- **Configuration** holds approval, sandbox, web search, output and reasoning-summary defaults, the background model and Smart Prune.
- **Git** edits `project_root_markers`, **Worktrees** `desktop.git-worktree-root`, and **Hooks** enables or trusts discovered hooks in `hooks.state`.

## Beside the chat

- **Browser:** the Browser button opens websites beside the workspace, with tabs, address entry, history, reload/stop and reply links. Hiding the pane or reloading the interface keeps the tabs; closing the app ends them. Websites use a separate session without Elpis runtime access.
- **Dictation:** the composer microphone uses the configured WhisperType MCP server (local, OpenRouter or Codex sign-in) and transcribes with the chat's own provider: ChatGPT sign-in for ChatGPT, the Voice model for OpenRouter, the fallback for providers with no transcription Elpis can reach. It shows its route and inserts text without sending. Recording and transcription can be cancelled; changing chats cancels them. Limits: two minutes, 8 MB.
- **Workflows:** requirements in [SPEC.md](SPEC.md#workflows); routing and scope limits in the [workflow guide](../../readme.md#workflows).
- **Improve Elpis:** Ctrl+K → **Improve Elpis…**, or right-click → **Change this…**, starts a Luna chat with a source component and captured region. It edits a fresh `improve/*` worktree and presents the committed diff and the build and test exit codes for review. Missing requirements are explained beside the affected action.
