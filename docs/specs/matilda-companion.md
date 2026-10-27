# Matilda on the page — 27 October 2026

Masih approved a small presence he can summon, pin and unpin, and ask to play his favorite music. It must stay quiet and leave other agents working. Replies remain ordinary board conversation; do not send chat screenshots.

1. **Pin (in progress):** Masih clarified “on top of the page” and “on every page”. The same compact control lives in the top bar of every app view, including Settings and the standalone Love Spot. Pin stays on across navigation and board pages; Unpin removes the presence everywhere. Existing saved pin choices carry forward. Music controls open only when asked for; pinning never changes drawings, takes focus or changes playback.
2. **Music (implemented):** Use the existing Linux MPRIS player. Show its actual track; play/pause and remember the current track as a favorite. “Play my favorite music” reopens the saved track in that player. No player or an unsupported action yields a clear local explanation. No launches, downloads, paid service or autoplay on mount.
3. **Conversation (implemented):** Only direct, short commands trigger actions. Questions, quoted commands, negation and implementation discussion do not. Matilda receives the actual action result before replying; no invented success.
4. **Isolation (implemented):** Separate worktree; no edits to other agents' unfinished files. Persistence uses the existing board lock but a separate settings file. The feature neither interrupts turns nor restarts the app. Remove the feature commit to roll back; drawings and saved favorites remain intact.

Verify persistence across two store instances, separate pages, direct-command positive/negative cases, player failure and real MPRIS control on a private session bus. Exercise pin/unpin, keyboard focus, reload and narrow layouts in both themes. Validate the packaged app with a throwaway profile before installing forward.

Evidence: private-bus music controls and persistence pass; board pin/unpin and narrow layouts pass in light and dark. The packaged standalone app with its real bridge also passed pin/unpin, Enter, reload persistence, readable player failure, unchanged drawing and no agent-start/interrupt requests. Installed forward as `ae76cf5ab`; the running app was left open. Evidence: `~/.cache/elpis-tests/matilda-pin/native-result.json`.
