# Elpis desktop

The Elpis desktop app is a Next.js and shadcn interface in an Electron window, connected to the private Elpis runtime socket. The browser version and the desktop share one interface and the native thread storage. Requirements are in [SPEC.md](SPEC.md); verification commands and opt-in checks are in [TESTING.md](TESTING.md).

## Run

From this directory, run `npm ci`, put GitHub's build of this commit in `out/` with `node scripts/actions-build.mts` (no local builds on Masih's laptop; [build rules](../../docs/LOCAL_BUILD_RULES.md)), then `npm run desktop` (or `desktop/launch.sh`). The desktop starts or reuses the installed Elpis runtime; no terminal window is needed.

- `ELPIS_ENGINE_BIN` selects another installed engine with its bundled provider bridge.
- For a browser, start Elpis, run `npm run web` and open its private URL.
- `ELPIS_APP_BRIDGE_SOCKET` selects an existing Unix socket and turns off automatic runtime startup.
- `desktop/launch.sh --desktop-entry` prints a `.desktop` launcher for this checkout (`StartupWMClass=elpis-desktop`, with the Elpis website's mark as icon). The script installs nothing.

The ready-made Logo workflow traces with SVG Studio, which is not in this repository. Its Tracer's shell reads two variables from the environment Elpis starts with:

- `SVG_STUDIO_MODULE`: SVG Studio's built `mcp-server/dist/vectorize.js`, default `~/Desktop/p/svg/mcp-server/dist/vectorize.js`.
- `ELPIS_LOGO_SCRIPTS`: the logo skill's `scripts` folder, default `~/Desktop/p/skills/logo/scripts`.

When either is missing, the Tracer stops and says so.

## Connection and restore

Closing the app leaves the shared runtime and its conversations running. After a runtime disconnect the app reconnects, restores subscriptions and refreshes state, and keeps the composer draft. The app never replays a write whose result is unknown; inspect the conversation before you send it again.

After reopening, the desktop restores the selected chat, exact unsent drafts, named projects and appearance, whatever its loopback port. The optional web version keeps draft recovery per window. A failed send keeps its text. Retrying a failed first agent message uses the conversation already created.

Provider history is paged within the size limit of the desktop connection. A history item larger than the page budget produces an explicit error, and its saved content is kept.

## Chats, projects and agents

Chat names, sidebar sections, search and deletion are requirements: [SPEC](SPEC.md#sidebar-and-chat-list) items 1–11. Headless (`exec`) runs and chats with no listed maker sit in Background runs; Workflow runs sit in Workflows. Both sections are off by default. Deleting a chat deletes its agents. A chat with forks is archived instead, so the forks keep working (`bridge/client-thread-actions.mts`).

Projects use existing folders, chosen natively or by absolute path. Switching projects sets the folder for new work and filters chats by their recorded folder; existing chats keep their own folder. The app reports unavailable or duplicate folders and storage failures.

The Context Ledger's Subagents switch, when on, permits delegation; it never requires an agent to be spawned. A change applies from the next turn, also in an open chat.

## Models and providers

A chat's model and reasoning effort can change for its next turn. A switch of provider in the middle of a chat is limited to subscription models, because the engine has no provider per turn.

- Leaving a subscription model for a native model waits for the current subscription turn to finish. A switch while busy is rejected and keeps the current selection.
- Changing an arbitrary API provider needs a new conversation.
- The model prefix labels the provider (`claude/` Claude subscription, `agy/` Gemini/Antigravity).

Provider edits, including clearing a stored key, apply to new conversations and agents. Existing conversations keep their original provider configuration and credentials. Clearing a stored key does not revoke it at the provider. A workflow's workers use the provider configuration captured by its root, so start a new root conversation to use changed settings there.

## Settings

Settings has fourteen pages, modelled on the ChatGPT app: General, Notifications, Appearance, Keyboard shortcuts, Voice, Personalization, Models & accounts, MCP servers, Usage & limits, Git, Worktrees, Hooks, Configuration and Archived chats. General and Notifications are saved on this device (`lib/preferences.ts`; the desktop reads Confirm before closing natively). Everything else goes through the native versioned config writer, which protects against stale writes.

- **Models & accounts** shows each provider's own sign-in (OpenAI/ChatGPT, Claude, Gemini). It edits OpenRouter, local and custom API endpoints that use the native Responses protocol. API keys can be replaced or cleared and never reach the renderer. Explicit API providers use their own credentials and model IDs. Managed or command-based authentication stays read-only.
- **MCP servers** lists the configured servers, showing only whether each has credentials, and adds, removes or enables them. RAG appears there with its provider, model and key settings; `/rag` instructions use one canonical prompt across providers.
- **Voice** sets WhisperType's OpenRouter model and the fallback engine.
- **Usage & limits** shows each account's limits and the selected chat's context.
- **Personalization** holds custom instructions (`developer_instructions`) and memories.
- **Configuration** holds the defaults for approval, sandbox, web search, output and reasoning summary, the background model and Smart Prune.
- **Git** edits `project_root_markers`, **Worktrees** edits `desktop.git-worktree-root`, and **Hooks** enables or trusts discovered hooks in `hooks.state`.

## Beside the chat

- **Browser:** the Browser button opens websites beside the workspace, with tabs, address entry, history, reload/stop and reply links. Hiding the pane or reloading the interface keeps the tabs; closing the app ends them. Websites use a separate session without access to the Elpis runtime.
- **Dictation:** the composer microphone uses the configured WhisperType MCP server (local, OpenRouter or Codex sign-in). It transcribes with the chat's own provider: ChatGPT sign-in for ChatGPT, the Voice model for OpenRouter, and the fallback for providers with no transcription Elpis can reach. It shows its route and inserts text without sending. Recording and transcription can be cancelled, and changing chats cancels them. Limits: two minutes, 8 MB.
- **Workflows:** requirements in [SPEC.md](SPEC.md#workflows); ordering and folder ownership in the [README](../../readme.md#how-it-works).
- **Improve Elpis:** Ctrl+K → **Improve Elpis…**, or right-click → **Change this…**, starts a Luna chat with a source component and a captured region. The chat edits a fresh `improve/*` worktree, then presents the committed diff and the exit codes of the build and the tests for review. When a requirement is missing, the app explains it beside the affected action.
