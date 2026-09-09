# Extension 0.1.17

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
