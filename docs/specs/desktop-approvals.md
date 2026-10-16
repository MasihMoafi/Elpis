# Desktop approvals — 17 October 2026

Intent: answer MCP elicitations and permission escalation in the existing approval
card. Masih supplied the acceptance harness and authorized local implementation.

Acceptance: exact protocol responses, only offered persistence choices, typed and
validated MCP forms, turn/session permission grants and denial. Invalid answers
stay pending; duplicate/stale answers cannot execute twice. Unknown future methods
remain readable. Command/file/input behavior stays intact.

Browser: engine server default `approve`, with `browser_open` using `auto`. When
the engine requests approval, offered session persistence prevents repeat prompts.
This adapts ChatGPT's access gate to a chat, not an origin allowlist. Evidence:
local Codex bundle 26.928.31416, `.vite/build/bootstrap-B7ariqxX.js` (`bne`, `Doe`)
and `main-BbeJ4AAR.js` (`jx`, `Dx`, allowedOrigins); TUI MCP form handling and
`mcp_tool_call.rs::session_mcp_tool_approval_key` (server/tool, no arguments).

Plan: failing bridge/UI regressions → extend the shared approval card and bridge
validation → configure browser approvals → locked build, typecheck, UI/desktop/
bridge suites → inspect light/dark screenshots in `/tmp/elpis-approvals/`.

Constraints: worktree and temporary mock fixtures only; no installed-app/profile
changes, live inference, staging, commits, uploads or dependency installs.
Rollback: restore only this task's edits, preserving pre-existing changes.
User acceptance remains open after automated checks.

Native eval: `tests/browser.runtime.mjs --only-approvals` now scripts local tool
discovery and two browser opens, requiring the first card and no repeat prompt.
Both available worktree binaries opened the real browser without emitting an
approval. The native card round-trip remains unverified; no new Rust build or
installed runtime was used. Bridge and renderer regressions demonstrate the new
request/response behavior independently.

User check: in Ask mode, allow a browser request for this session, then interact
without repeated prompts. Submit a form with number/boolean/enum fields. Grant
permission escalation for a turn/session, then test denial on a fresh request.
