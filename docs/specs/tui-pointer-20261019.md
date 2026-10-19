# TUI pointer repair — 19 October 2026

Masih cannot drag-select/copy text or use clicks in the terminal Agents view.

Acceptance:
- Dragging a draft during startup or a live thread highlights the intended characters; copying yields that exact text. Startup copy must keep the draft and pending submission intact.
- Selection survives streaming redraws; copying does not interrupt a running turn.
- Clicking an agent selects it and shows its conversation using the painted filtered/scrolled rows. Filter tabs use their painted hit areas; headings, margins and protected dialogs do not select rows. Enter retains the existing open behavior.
- Provider labels reuse the actual Claude/Antigravity bridge mapping and preserve native OpenAI, Anthropic and custom provider identity.
- Existing Ledger, scrollbar, agent filters, keyboard controls and clipboard failures retain their behavior.
- A focused regression fails before each fix, then passes; actual terminal checks cover light and dark themes.

Plan: inspect input/capture ownership, reproduce, apply the smallest shared-routing fix, run focused checks and inspect terminal captures.
Boundary: isolated branch from installed source; disposable homes and loopback fixtures; no desktop edits, live inference, auth/config changes, installation or publication.
Stop and clarify if resolving these reports requires changing expected gestures or provider/session ownership.
