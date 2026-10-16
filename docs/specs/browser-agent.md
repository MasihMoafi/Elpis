# Desktop browser agent — 16 October 2026

Masih requests agent control of the visible in-app browser. The existing parity
inventory selects a stdio MCP adapter and a private Electron Unix socket.

Acceptance: tool calls list/open tabs, navigate/history/reload, click by selector,
snapshot node or coordinates, type, press keys, scroll, read a DOM/text snapshot,
capture an MCP image, read console messages and wait for load/selector. A visible
indicator identifies the controlled tab. Take over revokes access, including waits
and queued calls, until the user enables it again. File URLs and Elpis UI URLs
remain blocked by browser-policy.cjs. Only browser-owned webContents are reachable.

Tests precede implementation: fake-webContents handler tests, private-socket and
stdio MCP tests, desktop registration assertions, then a real isolated Electron
fixture form filled/clicked through MCP with an image result and takeover denial.
No inference, real profile, installed app/bridge, staging, commits or uploads.

Run desktop and bridge suites, TypeScript, locked UI build and browser.runtime.mjs.
Package every new runtime module. User acceptance remains pending. Rollback is
removing this feature's specific hunks and modules, preserving concurrent edits.

Evidence: desktop 84/84, bridge 158/158, real runtime 12/12, TypeScript and locked
build pass. Registration failed before wiring; the expanded runtime caught wheel
events that did nothing. Scrolling uses isolated DOM scrolling at the requested
point. Light/dark indicators and the returned JPEG were inspected. Captures:
`/tmp/elpis-browser-agent-runtime-final/`. lat passes; alint has no config.

Files: `desktop/browser-agent.cjs`, `bridge/browser-mcp.mjs`, their tests; wiring in
`desktop/{browser,main}.cjs`, `bridge/client.mjs`, `desktop/package.mjs`; banner in
`components/browser-panel.tsx` and `lib/desktop.ts`; `tests/browser.runtime.mjs`.
Loaded chats observed elsewhere can ignore resume overrides; a new/forked chat
gets the tools. No live-model call or installation was tested. User check in the
source-built app: request a page/form action, watch it, Take over, then Allow agent
control and retry. Snapshot controls cover the main document, not iframe trees.
