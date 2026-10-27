# Matilda on the page — 27 October 2026

Masih approved a small presence he can summon, pin and unpin, and ask to play his favorite music. It must stay quiet and leave other agents working. Replies remain ordinary board conversation; do not send chat screenshots.

1. **Pin (installed):** Masih clarified “on top of the page” and “on every page”. The same compact control lives in the top bar of every app view, including Settings and the standalone Love Spot. Pin stays on across navigation and board pages; Unpin removes the presence everywhere. Existing saved pin choices carry forward. Clicking the avatar opens an anchored mini conversation; pinning never changes drawings, takes focus or changes playback.
2. **Music:** The companion control only mutes/unmutes the existing Linux MPRIS player and restores its exact prior volume. It never pauses, changes track, opens a player menu or guesses an unknown previous volume. Existing explicit conversation commands for favorite tracks remain supported. No launches, downloads, paid service or autoplay on mount.
3. **Conversation (implemented):** Only direct, short commands trigger actions. Questions, quoted commands, negation and implementation discussion do not. Matilda receives the actual action result before replying; no invented success.
4. **Isolation (implemented):** Separate worktree; no edits to other agents' unfinished files. Persistence uses the existing board lock but a separate settings file. The feature neither interrupts turns nor restarts the app. Remove the feature commit to roll back; drawings and saved favorites remain intact.

Verify persistence across two store instances, separate pages, direct-command positive/negative cases, player failure and real MPRIS control on a private session bus. Exercise pin/unpin, keyboard focus, reload and narrow layouts in both themes. Validate the packaged app with a throwaway profile before installing forward.

Initial evidence: 26 bridge checks pass; the top bar, navigation, menu dismissal, focus return, global Unpin and reload pass in light and dark at 1000 px and 360 px. The packaged app with its real bridge passes across Chat, Workflows, Customize, Settings and standalone Love Spot. Evidence: `~/.cache/elpis-tests/matilda-top/native-result.json`. Installed forward with the inline-diagram, instant-message and duplicate-label fixes at `1939457ed`; running windows are left open.

## Inline diagrams and arrow repair — 27 October 2026

Masih reports raw `excalidraw` JSON in chat and misplaced arrows on the board. Render valid diagram fences inline, retain code copying, and preserve ordinary code blocks. Honor line/arrow x/y offsets while preserving absolute-points drawings. Repair only unchanged legacy arrows using their recorded reply; preserve edits and deletions. Visually inspect the real chat and Excalidraw outputs in both themes before presenting a result. No chat screenshots in replies; embed the diagram itself.


## Avatar, music and page context — 27 October 2026

Masih's latest clarification and recording replace the earlier separate-chat-button design: click the avatar to reveal a slim message field immediately below it, as in ChatGPT Pets. Do not open or change the main chat, page, window, draft, selection or composer dimensions. Use the existing persistent Love Spot conversation through the local bridge, with the existing subscription provider. Send only on explicit Enter or Send; paste/typing never triggers a turn. Keep unsent and later-typed text through popup dismissal, failed sends and slow acknowledgements. Show the latest replies in a bounded, readable area and stop polling when the popup closes or the reply finishes.

The same avatar remains draggable by pointer and arrow keys; a drag must not also activate the chat. Remember its position and keep it within the viewport. Escape, outside click or another avatar click closes the mini conversation. Music only toggles mute. Unpin remains available. Use approved generated Pin and Send icons; where the approved collection has no music glyph, use a truthful Mute/Unmute label instead of an unrelated or generic substitute.

Provide one-shot screenshot capture on explicit request through the existing session-scoped tool channel. Let the OS/source picker choose the page; cancellation returns an error without an image. Capture no background stream. Verify actual app controls, chat dimensions, drag persistence, narrow layouts and both themes; inspect native capture of an external test window privately. Floating outside Elpis and automatic capture are separate preferences, not assumed.


Verified and installed as `gui-20261027-matilda-bfe419d3c`. Eight UI checks pass in both themes, including immediate three-message submissions and duplicate-label removal; 65 focused native/unit checks pass. Actual packaged controls and repaired diagram were visually inspected; the production capture path returned a chosen external GTK window on private Xvfb. Evidence: `~/.cache/elpis-tests/avatar-native/`, `avatar-proof/`, `screen-capture-proof/`. Running windows and other agents were left open; Update ready · Restart loads the installed version.
