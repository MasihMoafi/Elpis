# Local acceptance evidence — 2026-09-08

Implemented candidate, **not accepted by Masih**. No marketplace publication,
push, credential copying, or replacement of the installed Elpis TUI.

## Setup

- Linux Ubuntu 24.04; VS Code 1.136.1, revision a44adf7f53e00964ab890f9f8758a334f1fc15bc (installed Snap).
- Built-in TypeScript service; strict `tsconfig.json`; function returns string but assignment declares number (diagnostic 2322).
- Elpis standalone app-server built from baseline `35c0cb9472c7ab7ec950d5b823be7da00bc31a0d`, Rust sources unchanged.
- Offline bounded build, two jobs, two test threads, nice 10, debug info off, incremental off: **passed in 9m31s**. Existing core/app-server warnings remain. Target occupies about 4.2 GiB.
- App-server SHA-256: `8ce0a4299abff580ab3582ea9b932aefc8d6d42b0d5ee12b5f04d0c532ecf134`.
- Daily-driver SHA-256 remained `1e7c15694e572f3dbba801f67139a8d3e20b023309a981e8b6065a81f65f8ecb`.

## What has run

| Check | Evidence and boundary |
| --- | --- |
| RPC transport | Four passing Node tests: concurrent IDs/error, disconnect, timeout, and shared connection initialization. |
| Editor tools | Real extension host reads unsaved random sentinel; disk and disabled bridge cannot return it. Real TypeScript 2322, definition and two call-site references; plaintext no-provider case explains unavailable result. |
| Edits | Rejection leaves text; newer user edit rejects stale proposal; cancellation rejects pending proposal; successful correction removes diagnostic without saving. |
| Visible UI | Actual webview Send renders a streamed tool-derived reply. Native diff and actual Reject/Apply notification buttons tested. With real X11 window focus, Ctrl+Z restores original text and diagnostic. |
| Runtime path | Real Elpis subprocess invokes dynamic editor tools; local deterministic Responses provider captures their results at inference. This establishes plumbing/behavior, not live-model quality. |
| Compression | Existing manual Ace RPC changes captured next-request input from 47,617 to 25,726 bytes and retains the unsaved sentinel. Same fixture without pruning retains raw output. Deliberately omitting the fact from a pruning conclusion causes the retention assertion to fail. No compression defaults changed. |
| Recovery | Real turn cancellation permits another turn; killing runtime reports disconnection; reconnect gets a new thread. |
| Isolation | Distinct Session instances use separate workspaces/threads and reject cross-workspace editor reads. Separate-window worktree use remains on the manual checklist. |
| Packaging | VSIX built and CLI-installed into isolated profile; extension listing reports `elpis-local.elpis-editor@0.1.0`. Final package rerun is recorded in the task checkpoint. |

Exact initial pipeline capture: `.test-data/run-1788862695248/provider-requests.json`
(19 requests) and `result.json`. Its final UI-target-discovery phase failed after
the runtime cases passed; it is not a fully passing suite. UI/undo evidence:
`.test-data/run-1788863546750/result.json` and `chat.png`. That run's later live
startup failed, so its overall exit is also not a full-suite pass. Subsequent
passing final runs are recorded below and in the task checkpoint.

The initial editor launcher encountered the Snap GTK schema mismatch. Tests use
the installed Snap's matching schema/module directories, `--ozone-platform=x11`,
Xvfb and `xdotool` to focus only the isolated test display. Electron otherwise
chose Wayland and reported its test window unfocused: undo checks were unreliable
until the launcher was corrected. No production undo workaround was added.

The first live startup inherited the host's upstream `CODEX_HOME` and failed
SQLite initialization. The client now follows the Elpis TUI's `ELPIS_HOME` /
`~/.elpis` boundary and offers an explicit machine-scoped home setting. Credentials
were not copied. The configured `gpt-6-astra` then received a provider 400 saying
it is unsupported for this ChatGPT account; model metadata alone did not prove
access. The test profile can override the model without changing Elpis defaults.

Final packaged-code run `.test-data/run-1788863953719` passed all **16**
editor/runtime/UI assertions, including normal undo after X11 focus was fixed.
The additional live-model case was **blocked by the account usage limit** when
using the listed `gpt-5.4-mini` model. The provider reported a retry date of
September 13, 2026. No live-model conversation completed; this is a remaining
acceptance gap, not a passing test. No further account retries were attempted.

**Final deterministic suite passed (exit 0):**
`.test-data/run-1788864080476/result.json`, `provider-requests.json`,
`ui-provider-requests.json`, and `chat.png`. This loaded the installed VSIX's
production code and passed all 16 assertions against the real editor and
Elpis-built runtime. The optional live-model case was excluded from this run
because its independently recorded account limit is an external blocker.

## Masih's plain test checklist

1. Install the VSIX and select the Elpis-built server path. Open Chat; confirm runtime, model and project identity, then complete a conversation.
2. Add a unique unsaved comment and ask Elpis for it. Turn editor access off, start a new conversation, and confirm it cannot report that comment.
3. In TypeScript, assign a string-returning function to a number. Ask for the real diagnostic, definition and references; inspect the returned locations.
4. Ask for a fix. Review the diff and reject once: text must remain unchanged. Repeat and edit the file yourself before approval: Elpis must refuse the stale proposal. Propose again, approve, confirm the error clears, then press Ctrl+Z in the editor. Save only when you choose.
5. Cancel a running turn and continue. Stop the dedicated test runtime and reconnect; the status must explain the disconnection.
6. Open two different worktrees in separate windows with different unsaved comments. Check each conversation and approval operates only on its own worktree.
7. Optionally run explicit Experimental pruning and review the evidence. Automatic pruning remains unchanged. Accept or report issues; no agent may mark this verified on your behalf.

## Limitations

Linux local file workspaces only; no untitled/new uncreated documents, remote
files, or external-library locations. Whole-document proposals only. Native
runtime tools stay read-only and escalation is declined. VS Code must have a
working provider; empty diagnostics alone does not establish that it does.
Conversation UI history is not resumed after closing a panel. The optional live
provider check is separate from deterministic compression controls. Zed/ACP
integration and marketplace publication are not included.
