# Appearance · 19 October 2026

Contract: Masih's authorized `night-themes.md` handoff. Extend Settings → Appearance
using existing components, device preferences and document-level theme tokens.

- System, Light and Dark remain available. System follows OS changes; explicit
  choices ignore them. Reload retains the selection. Startup stays dark.
- Amber (default), Blue, Teal, Green, Violet, Rose and Orange update accent text,
  buttons, focus rings and HUD tokens immediately across views. Each accent text
  meets 4.5:1 on light/dark surfaces; button text also meets 4.5:1. Default
  preserves the existing neutral light and amber dark appearance.
- Chat font offers Default (interface font), Sans (Inter), Serif (DejaVu Serif),
  Mono (DejaVu Sans Mono) and System UI. Only installed fonts and generic stacks.
  Transcript and composer update together; code retains its separate mono font.
- Save through existing preferences, including cross-window changes. Unknown
  values fall back safely; failed writes show the existing save error.

Plan/check: first run failing UI checks with real mouse/keyboard choices, then
extend preference validation and shared CSS tokens. Run affected UI files, reading
checks, bridge/desktop regressions, typecheck, inventory and renderer build. Inspect
settings/chat captures for three light/dark combinations and a narrow window.
No provider, runtime, installation or network changes. Stop for material ambiguity
or unsafe user-state mutation. Rollback is a focused revert of this task's commit.
Automated evidence is provisional; only Masih accepts the visible behavior.
