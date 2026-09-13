# Local candidate 0.1.24

The bundled memory saver rejects unsupported UUID-based evidence citations before
overwriting notes. This preserves memory, checkpoint and provenance when a model
alters a source identifier. It does not establish reliable fact selection or
project scoping; those remain open. See `../../docs/evals/memory-lessons-review.md`.

## Local candidate 0.1.23

Ordinary Unix CLI and IDE launches now share a runtime. IDE History can attach to
the CLI conversation while it remains open, show its active response, interrupt
it, and continue the same chat. Editor tools go to one attached editor. Resume
preserves permissions; permission changes wait for runtime confirmation.

Provider credentials reach an already-running server, remain out of transcripts
and configuration, and can be replaced or cleared without losing the chat. The
CLI preserves its login directory when starting the server. Fifty-five extension
checks and actual simultaneous terminal/VS Code checks pass. Publication and
Masih's acceptance remain pending; see `../../docs/evals/followup-20260913.md`.

## Historical local candidate 0.1.22

Resuming a conversation now preserves text and completion events arriving during
attachment. The saved transcript appears before the live continuation. Shared
runtime observers also track external turns and user messages, including attaching
mid-response and interrupting the turn. Fifty-one extension checks cover these paths
and the existing behavior. Automatic live CLI/IDE connection and editor-tool
ownership remain unfinished; this version does not claim simultaneous live sync.

## Extension 0.1.21 candidate — September 13, 2026

History now includes CLI conversations for the current project and Elpis home,
across providers. Resuming keeps the conversation ID, displays the fresh resumed
transcript, and attaches live editor tools. The CLI's restored `/ide on`, `/ide off`,
and `/ide status` use this extension's context service.

The packaged candidate passed 47 Node checks and ten actual VS Code 1.136.1 checks,
including native CLI `/ide` on/off controls, same-ID resume, and a live unsaved
editor read. Light, dark, and high-contrast editor checks passed. No paid provider
calls were used. This does not provide simultaneous
live CLI/IDE chat synchronization: finish and exit the CLI session before resuming
its conversation in the IDE. Full verification details are in
`../../docs/evals/followup-20260913.md`.

## Historical extension 0.1.20 candidate — September 12, 2026

The Linux package now includes the Bubblewrap sandbox executable and its license
beside the app-server runtime. Previously, sandboxed commands depended on a
compatible system installation of Bubblewrap. The updated package can use its
bundled copy on a fresh system.

The current source passed 46 Node tests and six controlled-provider conversations:
two each in empty, file-only, and folder VS Code windows. These checks do not
establish public release acceptance. Native-terminal drag selection remains an
open CLI issue; the VS Code terminal checks pass.

## Historical extension 0.1.17 acceptance

Accepted by Masih on 2026-09-09. Linux x64; VS Code 1.136 or later.

Includes the Elpis runtime for Smart Pruning, context attribution, goals,
provider APIs, and IDE tools. `/prune` enables fresh-output Smart Pruning;
Context displays its live state, estimated reduction, optimizer usage,
source-category estimates, and native goal controls. It honors the user's
existing pruning setting. New installations retain the runtime's default-off
experimental setting until the user enables it.

The runtime source is the tested 38388829 baseline plus the hosted-provider
tool-loop/signature repair from 5eebdd4c (local integration 3655990d). The
`codex-rs` tree in this release is identical to that tested runtime source.
This release branch does not replace the CLI's main branch or latest release.

Verification:

- 40 Node checks.
- Eight actual-runtime, controlled-provider tool-loop cases across OpenAI,
  OpenRouter, Anthropic, and Gemini, including disabled-editor negatives.
- Three actual-runtime Smart Pruning cases: off, admitted compression, and
  malformed optimizer reply with original-output retention.
- 48 source editor checks, including a live Codex-account Luna IDE edit.
- 47 installed extension/editor/runtime checks; light/dark screenshots inspected.
- Unprivileged Ubuntu 24.04 container: fresh home, no credentials, no network;
  initialization and configuration reads succeed using the bundled binary.
- Rust build and formatting checks pass. No separate Rust unit-test build.

The prefix checks compare earlier input, instructions, and tool definitions.
They do not establish provider-internal cache hits or universal losslessness.
Full TUI command and source-by-source admission-control parity remains incomplete.
No automatic durable-memory promotion pipeline is included.
