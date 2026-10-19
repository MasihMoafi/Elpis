# A12 installed updates and clean quit

Goal: every Elpis and standalone Love Spot window exposes the installed update and can save and restart its app into it. First adoption needs the integrator to reopen the pre-feature build when chats are idle.

- Detect desktop launcher or engine selection changes through filesystem events; read current selections again on Restart, without idle polling.
- One shared control uses existing title-bar/Button styling in chat, Settings, Workflows and standalone Love Spot; unavailable outside desktop. Explicit Restart preserves app mode and opens the selected launcher once after all this app’s windows flush.
- Fail closed on active conversations, local ACP workflows or Lab (including preparation/integration), rejected/failed draft or browser saves, and invalid/missing launchers. Keep windows and local drafts available, show an actionable error, and allow retry.
- Ctrl+Q and tray Quit share the save path and close all windows, including when Close to tray is enabled; ordinary Close still follows the saved preference.
- Pending private workspace writes and hidden Quick Entry text must be acknowledged before the board server closes. Quick Entry reloads its saved text on the first show after reopening; later shows preserve its live textarea. No provider inference, force-kill, profile migration or runtime shutdown that could interrupt terminals; bridge-join08a446480 remains intact.
- After freezing all windows, inspect the Files store across every project/document, including hidden and saving files. Unsaved source edits refuse Quit/Restart with Save/revert guidance; failed saves retain exact text and continue blocking. Never write or discard source edits automatically. A missing store accessor is allowed before initialization; an installed invalid or throwing accessor fails closed.
- Explicitly flush the latest workflow graph before the native storage barrier, even while its 300 ms debounce is pending. Missing workflow hook is valid; refused graph/native storage saves keep all windows editable for retry. Preserve ordinary file preview behavior and do not dispatch synthetic unload events.
- Verification: failing baseline event/IPC/control case, focused unit cases for both selections and failure/retry, private native real key/click proof with multiple windows and saved text; light/dark captures inspected. No installations or ship commits.

A17: diagnose duplicate dock icons separately using actual app identities; do not change IDs or icons without a reproduction. Integrator owns activation/rollback to its checked prior bundle.
