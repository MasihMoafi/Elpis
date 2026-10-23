# A166: Open and control a running delegated helper

Session intent: a Claude chat's `elpis-agents.delegate` helper stays visible and
controllable through the desktop while its first turn is running.

Use the existing bridge owner and subscription routing. Keep helper permission
ceilings and engine isolation. No Rust builds, installs, pushes, or real-home writes.

Acceptance: an isolated shared bridge, the real delegate MCP server and desktop
HTTP server open a running native helper, deliver its history and subsequent live
items, and accept and report sandbox permission changes. Unknown threads and
grants above a helper's ceiling must fail without granting access.

Write and run this regression before production changes. Run Node tests at nice
19, serially. Inspect the engine's live settings path; change Rust only if needed.
Stop after diagnosis and failing proof if the repair needs larger architecture.

The native helper owns a private engine (`shared-runtime.mjs:316`); owner routing
omitted `thread/items/list` and `thread/settings/update`. Both reached an engine
without that loaded thread. The permission menu also used the global submission
`busy` flag; an open chat's permissions can change independently of a submission.

Regression before routing repair: 4 failed, 0 passed; history GET and permission
POST returned HTTP 502 / `runtimeCode: -32600`, including `thread not found`.
After repair: 4 passed, 0 failed; the same active turn remains in progress through
Ask, Auto and Full, and unknown threads and above-ceiling grants are refused.

Rust already publishes accepted permission updates into the active turn's
`live_permissions` in `codex-rs/core/src/session/thread_settings.rs:54` and checks
revocation/grants in `session/live_permissions_tests.rs:133` and `:242`.
No Rust changes or local Rust build are required.

Verification (all Node runs at nice 19, one test file at a time):
- `bridge/helper-desktop.test.mjs`: 4 passed, 0 failed (the CI entry imports the
  same MCP regression); settings snapshots and later live deltas reach SSE.
- `bridge/bridge.test.mjs`: 124 passed, 0 failed, with an isolated home.
- `tools/elpis-claude/test/resume-list.test.mjs`: 9 passed, 0 failed; monitored
  temperature peaked at 69 C.
- `tests/test-inventory.test.mjs`: 2 passed, 0 failed; inventory check and
  `git diff --check` passed.

The packaged renderer and real Claude inference were not run. The UI lock change
was source reviewed; the regression exercises the renderer's exact HTTP/SSE
requests. Helper permission ceilings remain enforced, including read-only helpers.
