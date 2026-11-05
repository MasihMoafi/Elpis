# A166: Open and control a running delegated helper

Intent: a Claude chat's `elpis-agents.delegate` helper stays visible and controllable in the desktop while its first turn runs. Use the existing bridge owner and subscription routing; keep helper permission ceilings and engine isolation.

Acceptance: an isolated shared bridge, the real delegate MCP server and the desktop HTTP server open a running native helper, deliver its history and later live items, and accept and report sandbox permission changes. Unknown threads and grants above a helper's ceiling fail without granting access.

Cause: the native helper owns a private engine (`shared-runtime.mjs:316`), but owner routing omitted `thread/items/list` and `thread/settings/update`, so both reached an engine without that loaded thread. The permission menu also used the global submission `busy` flag, though an open chat's permissions can change independently of a submission.

Rust already publishes accepted permission updates into the active turn's `live_permissions` (`codex-rs/core/src/session/thread_settings.rs:54`) and tests revocation and grants (`session/live_permissions_tests.rs:133`, `:242`). No Rust change is needed.

Evidence (Node, nice 19, one file at a time):
- Before the routing repair: 4 failed, 0 passed; history GET and permission POST returned HTTP 502 / `runtimeCode: -32600`, including `thread not found`.
- After: `bridge/helper-desktop.test.mjs` 4 passed, 0 failed (the CI entry imports the same MCP regression). The active turn stays in progress through Ask, Auto and Full; settings snapshots and later live deltas reach SSE; unknown threads and above-ceiling grants are refused.
- `bridge/bridge.test.mjs` 124 passed, 0 failed, with an isolated home; `tools/elpis-claude/test/resume-list.test.mjs` 9 passed, 0 failed; `tests/test-inventory.test.mjs` 2 passed, 0 failed; inventory check and `git diff --check` passed.

Not run: the packaged renderer and real Claude inference. The UI lock change was source-reviewed; the regression sends the renderer's exact HTTP/SSE requests. Helper permission ceilings stay enforced, including for read-only helpers.
