# Elpis for VS Code (Linux)

**Elpis: Open** runs the installed `elpis` in an editor tab. It is the Elpis of
your terminal: the same binary, home, login, models and commands. In that tab,
`/ide` turns on editor context: Elpis gets the selection and the open files of
this window. The connection is local. It respects workspace trust and the
**Elpis: Editor Access** setting.

The extension does not bundle a runtime. It runs `elpis` from PATH, else from
`~/.local/bin`. **Elpis: Executable** selects a different binary. **Elpis: Home**
gives the binary an `ELPIS_HOME`. When it is empty, `elpis` uses its own home.
When the binary reports a version that is not the `elpisRuntime` version in
`package.json`, the extension shows a warning.

## Chat view (frozen)

The chat view is off by default. **Elpis: Use Chat View** turns it on. Then
**Elpis: Open** and **Elpis: Open Chat** open the chat view. Each chat view runs
its own `elpis app-server` process. It does not share a live runtime with the
terminal, but its History shows the chats of this folder from the terminal and
from the chat view. A setting whose description starts with "Chat view only" has
no effect on the terminal.

Type `/` in the chat composer to search commands. Arrow keys select, Tab completes,
Enter runs, and Escape dismisses. Supported commands: `/model`, `/permissions`,
`/new`, `/clear`, `/resume`, `/settings`, `/compact`, `/prune`, `/review`, `/copy`,
`/usage`, `/mcp`, `/hooks`, `/plugins`, and `/debug-config`. Unknown commands and
unsupported arguments remain in the draft rather than being sent to the model.
Commands do not run while a response is active. `/review` reviews uncommitted
changes; `/compact` requires an existing conversation. This is not the full TUI
command set.

## Install

You need Linux, VS Code 1.136 or later and an installed `elpis`
(`elpis --version`). From this directory:

```sh
npm ci
npm run package
code --install-extension ./elpis-editor-$(node -p 'require("./package.json").version').vsix
```

The package has no production npm dependencies and loads no CDN. On Masih's
workstation, source `~/.bash_aliases` and run `nope` before downloads.

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

Remove the `elpis.*` settings if desired. Removal does not delete Elpis credentials, config or conversation
rollouts. For isolated profiles, use the same `--user-data-dir` and
`--extensions-dir` arguments for installation/removal.

## Reproduce checks

```sh
npm test
npm run test:editor
ELPIS_EDITOR_TEST_RUNTIME=/absolute/path/to/elpis npm run test:editor
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
