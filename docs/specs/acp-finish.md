# Finish ACP control — 2026-10-18

Masih's contract: `/home/masih/.local/state/elpis-audits/handoff/acp-finish.md`.

- Forward session/new stdio commands, arguments and environment, and HTTP URLs and headers into thread-local MCP configuration. Other sessions and saved configuration stay independent. Unsupported transport fails clearly.
- Connect to the existing Elpis shared bridge when available. The ACP session ID is the desktop thread ID. An explicitly selected unavailable bridge fails instead of starting a disconnected engine.
- Before a running prompt completes, the desktop can list, follow, steer and interrupt that same thread. A second ACP prompt steers the active turn and waits for its outcome. No second turn is started.
- Cancellation interrupts the matching turn. Closing ACP disconnects its client without stopping the shared engine or another session.

Plan: add failing scripted-client tests with mock engine and planted MCP answers; map MCP configuration; reuse the shared bridge socket and turn/steer; run regression checks; commit each bounded fix and cherry-pick the ACP series to morning/integrate. Preserve unrelated work and resolve conflicts with both behaviors retained.

Acceptance evidence: real MCP initialize/list/call on fake stdio and HTTP servers; a planted streamed message observed by DesktopClient before completion; distinct desktop and ACP steer inputs reach the same running turn; cancel and disconnect failure cases. Negative controls omit MCP, keep the old private adapter, or disable steering. No live model calls required.

Rollback: revert only the ACP commits. No saved user configuration is changed. Human acceptance and installation remain with Masih and the coordinator.
