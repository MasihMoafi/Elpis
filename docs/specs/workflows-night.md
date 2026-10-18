# Workflows · 19 October 2026

Contract: complete the five outcomes in `night-workflows.md`: scroll pans both
views; Ctrl/Cmd+scroll and trackpad pinch zoom; nodes keep identity colors; six
Love Spot characters have editable prompts; Space opens numbered patterns; runs
use the shared ACP node transport.

Space → number → Enter rewires the current nodes: 1 sequential, 2 parallel,
3 existing Kahn graph waves, 4 recursive, 5 voting. Escape cancels. Recursive
feedback carries completed answers from the previous round, with an explicit
1–100 round limit. Other dependency cycles fail before any agent starts.

`bridge/workflow-acp.mjs` schedules `runAcpNode`: completed dependency answers,
bounded concurrency, checks, cancellation, timeouts and persisted results.
The existing approval panel answers ACP permission requests. Elpis ACP sessions
use named permissions for writable folders and read-only checks; other adapters
retain their own permission implementation. Multiple writers keep the existing
optional worktree isolation; integration requires a clean, unchanged source.

Evidence: `tests/night-workflows.test.cjs` failed on all five baseline cases;
`bridge/workflow-acp.test.mjs` failed on the baseline native execution path.
Final commands/counts and four inspected screenshots are in the handoff report.
Live model execution, installation and Masih's functional acceptance remain open.
The coordinator owns the guide and task-status updates.
