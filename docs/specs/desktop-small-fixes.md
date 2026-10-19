# Desktop small fixes · 19 October 2026

Contract: Masih's `handoff/desktop-small-fixes.md` (five requested behaviors).

- Sending with Enter shows the submitted message before thread creation or turn submission finishes. The engine item replaces it in place without a duplicate or flicker. A failed submission keeps the draft recoverable and shows the error. Navigation never moves a pending message into another chat.
- Sidebar Up/Down traverse visible navigation, search, project/group headings and chat rows. Home/End reach the ends. Enter activates the focused control. Text editing and open menus keep their own keys.
- A saved General setting and the Agent runs group menu hide the entire group. The group menu deletes listed run history through the existing confirmation, active-run handling and Undo path. Groups over the existing 100-chat trash limit offer a labeled 100-run batch. Ordinary chats are excluded from the requested targets.
- The send button stays amber in both themes and both enabled/disabled states. Its top-left and bottom-right cuts are parallel to the composer. Disabled remains visibly distinct. Keep the current icon and report earlier icons from Git.
- One shared button variant/token owns this cut-corner primary shape.

Plan: add failing real-key/click UI checks, make narrow changes to the existing page/preferences/button sources, run affected files, inspect light/dark and narrow captures, review the diff, commit, run the complete gate and install that exact commit through the installer.

Constraints: no engine/runtime changes, package installs, network calls, real-profile test writes, user-app launches, pushes or publications. Preserve unrelated changes. Use existing deletion safety and components.

Evidence lives in `~/.cache/elpis-tests/desktop-small-fixes/`; final counts, commits, icon history and unchecked behavior go in the handoff Report. Masih's acceptance remains open.
