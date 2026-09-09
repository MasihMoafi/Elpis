# Recovered reference acceptance

2026-09-09 latest user steering supersedes the old text-pill controls: permissions are a shield icon and thinking is a brain icon, both with composer-local popovers. The composer IDE toggle is removed; IDE access defaults on and the review workspace explicitly enables it. Extension 0.1.12 is installed and its loaded chat.js URL and icon DOM were verified in the fresh visible review window (CDP 19626). The old review window/draft was preserved. All 31 Node checks and 44 source editor/runtime checks pass, including actual model/effort requests, permission changes, Full-access cancellation/confirmation, and real editor tools. Inspected light/dark and thinking-menu screenshots in run-1788939695158. The older remaining-scope rows below are historical where superseded by this user feedback; full screenshot parity is not claimed.

The ten user-supplied PNGs were found in Trash and copied unchanged to `.test-data/references/`. Do not ask for them again. This is an implementation/evidence checklist, not user acceptance.

| Reference | Required behavior | Current state / next work |
| --- | --- | --- |
| 22-48-29 | Current model names, selected checkmark, combined model/thinking control | Actual current catalog and same-thread changes work; combine composer control and expose effort slider |
| 22-48-33 | Ask / Approve for me / Full access menu | Runtime policies and confirmation tested; use composer popover instead of native picker and retain truthful mode descriptions |
| 22-48-46, 22-48-49 | Attachment plus, IDE context icon, one Send/Stop, local workspace | SVG Send/Stop works; add attachments and automatic active-file/selection metadata, compact icon layout; disable empty Send |
| 22-48-52 | Recent chats on empty screen; archive action | History/rename/archive/restore tested; show three actual recents on home |
| 22-48-54, 22-48-58 | Searchable history popover with age/filter/archive | Active/archive search works; refine popover layout, timestamps and direct archive affordance |
| 22-48-59 | Account identity, settings, keyboard shortcuts, log out | Correct Codex login and account page work; replace chip toolbar with proper account/settings popover; logout must not delete shared Codex/Elpis credentials |
| 22-49-16 | General: language, review delivery, speed, context usage, send shortcut, Queue/Steer | Send shortcut works; implement remaining controls against runtime and actual preferences; no decorative toggles |
| 22-49-26 | Configuration: config file, visible effort levels, Ultra visibility | Config opens; implement effort visibility using actual advertised capabilities |

Existing evidence: 28 Node checks, 43 editor/runtime checks (`../elpis-ide-default-model` worktree run-1788935578722), live Codex-account Luna IDE read/edit/diagnostics without saving, live OpenRouter/free tool loop, and eight offline provider-adapter positive/negative cases. Installed user window is 0.1.10; 0.1.11 is packaged but not installed. No full-parity claim.

Acceptance for the next changes:

- Queue waits for the current turn; Steer uses `turn/steer` with its actual turn-ID precondition. Stop pauses pending work; it must not silently discard it or immediately start another turn. Queued items can be removed or resumed.
- IDE auto-context includes only workspace file metadata and the active selection, not entire unsaved files. Disabling access removes it from new requests. Prove both with a selection-only sentinel and a negative control.
- Context usage follows the runtime's last context-window token accounting, not lifetime billed tokens or transcript length.
- Review and speed preferences change actual runtime requests. Detached review opens a separate conversation. Do not add a slash command.
- Attachments come from a native file picker; webview-provided arbitrary paths are not authorization. Preserve drafts on failure.
- Every visible control must have a positive/negative behavioral check; capture the actual VS Code light/dark/narrow layouts and compare with the PNGs.
