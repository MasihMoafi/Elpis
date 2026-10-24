# Desktop goal and context — 24 October 2026

Masih: "/goal doesn't exist here btw. it should obviously; along with the ES.md and context files should be visible in the tab right."

1. `/goal <condition>`, `/goal`, and `/goal clear` set, read, and clear the selected chat through the runtime's goal RPCs, for Claude and engine chats. Errors are visible; commands never become user turns accidentally.
2. The right side panel offers Context for the selected chat. It shows the runtime goal with Clear, admitted context files using the existing rows, and the project's ES.md. Missing ES.md offers Create; creation never replaces an existing file. Files use the existing rendered, editable Files tab.
3. A chat switch cannot show or mutate another chat's context. Rejected writes preserve the current goal/file state and show a retryable error. Context reads run only while that view is mounted.
4. Verify with failing-then-passing RPC/HTTP and real keyboard/click renderer regressions, positive and negative cases, and inspected 1440×900 light/dark screenshots. Native provider and packaged-app evidence must be reported separately.

Scope: desktop bridge, composer, shared context rows, side panel and focused checks. No install, push, credential copying or real user state changes. Rollback: revert the focused worker commit.

Local verification: renderer 16 passed; bridge/context/slash/inventory 18 passed; package 10 passed; Claude delivery 29 passed, 4 skipped; installed engine/Claude bridge plus packaged Electron and native Claude manifest 2 passed with local scripted inference. Rejected commands retain their text. Light/dark screenshots inspected. Masih’s acceptance and live subscription inference remain unverified.
