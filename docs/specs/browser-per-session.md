# Session browsers — 19 October 2026

Masih's browser-per-session worker brief is the acceptance contract.
Each existing chat and each empty chat tab owns its pages, selection, address,
navigation history, annotations and agent control. Switching chats switches the
browser. A fresh chat starts empty. Closing or deleting a chat closes its pages.
App restart restores pages and navigation history under their original chat.
Cookies and website storage remain shared in the existing browser partition.

Agent MCP processes authenticate with a private capability. The engine overwrites
session metadata on each call, including inherited agent connections. Tool arguments
and window focus cannot select another session. A private reconnect record keeps
loaded sessions connected after the desktop restarts.
Concurrent calls in separate sessions use separate queues. Closed-page calls fail.
Persistence errors appear in the browser, and preserve the previous saved state.

Verify first with failing native Electron journeys (real clicks and keys), socket
positive/negative isolation and bridge start/resume/fork checks. Check restart,
close/delete, stale callbacks and concurrent calls. Review light/dark captures in
`~/.cache/elpis-tests/browser-per-session/`, typecheck, full desktop gate, then
commit and install through the authorized installer. User acceptance stays open.
Rollback: the installer prints the previous launch symlink target.
