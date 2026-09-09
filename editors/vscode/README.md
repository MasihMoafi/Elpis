# Elpis for VS Code (Linux)

Type `/` in the chat composer to search commands. Arrow keys select, Tab completes,
Enter runs, and Escape dismisses. Supported commands: `/model`, `/permissions`,
`/new`, `/clear`, `/resume`, `/settings`, `/compact`, `/prune`, `/review`, `/copy`,
`/usage`, `/mcp`, `/hooks`, `/plugins`, and `/debug-config`. Unknown commands and
unsupported arguments remain in the draft rather than being sent to the model.
Commands do not run while a response is active. `/review` reviews uncommitted
changes; `/compact` requires an existing conversation. This is not the full TUI
command set.

With the same project open in VS Code, the existing Elpis CLI's `/ide on` includes
the editor selection and open-file metadata. `/ide off` disables CLI inclusion.
The connection is local, scoped to the project and Elpis home, and respects
workspace trust and the editor-access setting.

The published Linux x64 VSIX bundles the tested Elpis app-server. Extension
versions are separate from Elpis CLI versions.

An installable local VS Code extension with chat, live unsaved document reads,
diagnostics, definitions, references, and approval-gated editor edits. Elpis's
existing app-server owns inference, tools, continuity and compression. VS Code
supplies its own installed language providers. Masih accepted extension 0.1.17
on 2026-09-09. See `RELEASE.md` for release verification and limits.

## Install

Download `elpis-editor-linux-x64.vsix` from the
[extension 0.1.17 release](https://github.com/MasihMoafi/Elpis/releases/tag/extension-v0.1.17).
You need Linux x64 and VS Code 1.136 or later. Install with:

```sh
code --install-extension ./elpis-editor-linux-x64.vsix
```

Building from source additionally needs Node/npm and an
**app-server built from this Elpis repository**. The installed `elpis` TUI does
not have an `app-server` subcommand. Upstream Codex's app-server does not establish
Elpis compression or continuity support; do not substitute it for this runtime.

From this directory:

```sh
npm ci
ELPIS_APP_SERVER=/path/to/codex-app-server npm run package:linux
code --install-extension ./elpis-editor-linux-x64.vsix
```

On Masih's workstation source `~/.bash_aliases` and run `nope` before downloads.
The package includes its styles and script; it does not load a CDN or download a
model. It has no production npm dependencies.

If no Elpis-built server is available, build the existing standalone target from
the repository root after reading `docs/LOCAL_BUILD_RULES.md`:

```sh
cd codex-rs
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 \
  CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_INCREMENTAL=false \
  nice -n 10 cargo build --locked -p codex-app-server --bin codex-app-server
```

This builds `target/debug/codex-app-server`. It does not replace the daily-driver
binary. Cold builds take time and disk; use a known writable target directory
via `CARGO_TARGET_DIR` if needed. Either put a copy on PATH named
`elpis-app-server`, or set **Elpis: Executable** in VS Code's user settings to the
absolute path of that artifact. The setting is machine-scoped so repositories
cannot select an executable on your behalf. The default is `elpis-app-server`.

The server reads normal Elpis configuration and authentication (`~/.elpis`, or
`ELPIS_HOME` / the machine-scoped **Elpis: Home** setting). Inherited `CODEX_HOME`
is ignored, matching the Elpis TUI and avoiding Codex's separate database.
Authenticate with Elpis first. The extension
does not read, copy, render, or change credentials. Optional **Elpis: Model**
selects a model; leaving it empty retains the configured model/provider.

Open a trusted local project and run **Elpis: Open Chat** from the command
palette. In a multi-folder workspace, choose the folder for the conversation.
The identity line shows executable, runtime user agent, model and workspace.
Each window/folder uses its own child process and fresh thread. Closing the panel
stops that process; existing Elpis rollouts remain on disk.

## Working with code

Ask Elpis to list open documents, read their current unsaved contents, query a
diagnostic, or find definitions and references. Positions are zero-based. Only
existing local files beneath the selected workspace are accessible through the
bridge; untitled documents, remote/virtual files and external library source
locations are not supported. VS Code's provider must support the requested
language operation. Empty results explain that a provider may be unavailable,
still starting, or have no result; no diagnostics alone is not proof of health.

For an edit, Elpis first reads the current version and proposes replacement
text. Applying the proposal opens a native diff and asks you to **Apply** or
cancel. A rejection, changed document version, access withdrawal, or cancelled
turn prevents the edit. Successful edits stay unsaved and have an undo boundary;
save them yourself. Elpis must query diagnostics again after the language
service refreshes. Native runtime tools are read-only and their escalation
requests are declined; the editor approval path owns edits in this integration.

**Editor access** blocks editor tools immediately. Previously seen text remains
in that conversation: use **New conversation / reconnect** for a clean negative
control. **Cancel** interrupts a turn and invalidates pending proposals. A failed
or disconnected runtime gives a status; reconnect starts a fresh thread.
History can reopen saved conversations after closing a panel.

**Smart Pruning (Experimental)** optimizes fresh tool output before its first
admission to model-visible history. `/prune` enables it for subsequent turns;
the Context Ledger provides an on/off control. It does not invoke the old manual
history rewrite. Existing prompt-prefix preservation is distinct from whether
the provider serves a cache hit. Optimizer calls have their own cost and may
fail; the runtime retains original output when optimization cannot be admitted.

**Context Ledger** shows the last reported context usage, estimated source
attribution, estimated pruning reduction, reported optimizer usage, and latest
attempt status. Unreported values remain unknown, and estimated token reduction
is not presented as net billing savings. Goal controls use the runtime's existing
set/read/clear operations. These surfaces require a current Elpis app-server;
the original extension bundle predates its Smart Pruning notifications.

## Remove

```sh
code --uninstall-extension elpis-local.elpis-editor
```

Remove any dedicated server copy you installed and the `elpis.*` settings if
desired. Removal does not delete Elpis credentials, config or conversation
rollouts. For isolated profiles, use the same `--user-data-dir` and
`--extensions-dir` arguments for installation/removal.

## Reproduce checks

```sh
npm test
npm run test:editor
ELPIS_EDITOR_TEST_RUNTIME=/absolute/path/to/codex-app-server npm run test:editor
```

The editor harness uses Xvfb and xdotool, an isolated user profile and extensions directory,
and VS Code's built-in TypeScript language service. It writes exact fixtures,
results and controlled-provider request captures under `.test-data/run-*`.
`ELPIS_EDITOR_TEST_EXTENSION` may point to an installed VSIX's extension folder
to test the packaged code. The runtime harness uses a local deterministic model
provider and fresh runtime home; it does not copy authentication. Its compression
on/off and deliberately missing-fact cases test the real pipeline, not general
model summarization quality.

Set `ELPIS_EDITOR_TEST_CDP` to an unused local port to exercise the actual webview
and native approval controls. `ELPIS_EDITOR_TEST_LIVE=1` additionally uses existing
Elpis authentication for one live conversation; `ELPIS_EDITOR_TEST_MODEL` selects
its model (default `gpt-5.4-mini`). This changes only the isolated editor profile.

If your installed Snap has a GTK schema mismatch, use its Electron executable
with matching Snap `GSETTINGS_SCHEMA_DIR` and `GIO_MODULE_DIR` for the test
process only; record the concrete paths with local evidence. This is a test
launcher workaround, not an extension requirement.

## Why this interface, and other editors

[ACP clients](https://agentclientprotocol.com/get-started/clients) include VS Code
and Zed integrations. The [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)
translates to app-server, accepts `CODEX_PATH`, and permits client MCP servers.
That is useful reuse for generic ACP chat, but compatibility with the Elpis TUI
binary is not established. [ACP's documented baseline client APIs](https://agentclientprotocol.com/protocol/v1/overview)
cover file reads/writes, terminals and permissions; they do not standardize
diagnostics, definitions or references. Those require an additional editor
bridge. A direct app-server client is the smaller implementation here.

The bridge uses [VS Code APIs](https://code.visualstudio.com/api/references/vscode-api)
and [language commands](https://code.visualstudio.com/api/references/commands):
`TextDocument.getText`, `languages.getDiagnostics`, definition/reference provider
commands, and versioned `TextEditor.edit`. Zed could reuse an ACP transport or
the Elpis app-server plus a native editor tool bridge. It would still need its
own language-provider and approval/undo integration; this task does not build it.
