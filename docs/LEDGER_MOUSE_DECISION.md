# Context Ledger mouse decision

September 17, 2026. Resolved by Masih: **no mouse.** Clicking a Context Ledger row
to activate a file is not a feature Elpis will have. Do not re-open this.

## What was actually wrong

`handle_context_ledger_mouse_click` exists and is correct, and its unit tests pass
— because they call the handler directly. In a real session it is never reached.
Elpis only turns on mouse reporting (`\x1b[?1002h\x1b[?1006h`) when entering the
alternate screen for an overlay; `set_modes` deliberately does not claim the mouse
on the normal screen, so the terminal never sends a click while the ledger is on
screen. The feature shipped dead in v0.2.0 and in every build since.

## Why it was not "fixed"

This is not a fresh trade-off: Masih **accepted the opposite fix one day earlier.**
On 2026-09-16 he tested and accepted "two-finger swipe no longer acts like a double
Escape", whose cause was recorded as *Elpis holding the mouse for the whole session*.
Handing the wheel back to the terminal outside overlays is that accepted fix. Making
ledger clicks work means undoing it and re-breaking two-finger scrolling.

Every X11 mouse mode (`?9`, `?1000`, `?1002`, `?1003`) reports the wheel as well as
the buttons. Claiming the mouse for the inline chat therefore takes the wheel away
from the terminal, and the inline chat's history lives in the terminal's own
scrollback. Drag-to-select goes too. Both need Shift to bypass. Trading working
scrollback and text selection for a row toggle is a bad trade.

## What to do instead

The ledger is keyboard-driven: `Tab` focuses it, arrows or `j`/`k` move, `Space`
or `Enter` toggles, `Esc` closes. One row was not: the Smart Prune switch was
reachable only by an undocumented `p` or by a click, so removing the mouse left
it unreachable. It is now the first stop on the same cursor, above the sources. The footer hint
already advertises `Tab controls`. Ctrl+click on a row still opens the file, because
that is the terminal following an OSC 8 hyperlink, not Elpis reading a click.

## Standing rule

Do not add mouse interaction to any surface drawn on the normal screen. If a future
surface genuinely needs the mouse, it belongs in an alt-screen overlay, which
already owns the mouse while it is up.

## Why dragging to select still feels rough (2026-09-18)

Masih reported that dragging with the left button to copy model output is "not
very smooth". Nothing is intercepting the drag: the inline chat never claims the
mouse, so the selection belongs to the terminal, exactly as decided above.

What fights it is repainting. While a turn is running Elpis asks for a frame
every 40 ms (`elpis_motion::FRAME_TICK`) to animate the status header and the
composer shimmer. A terminal drops or flickers a selection when the region under
it is rewritten, so selecting while the model works means selecting against 25
repaints a second.

The setting that governs this already exists and is not written down anywhere:

```toml
[tui]
animations = false
```

With it off, `frame_animations_enabled` is false, no periodic frame is scheduled,
and Elpis repaints only when something actually changes. Selection then behaves
like any other terminal program's.

Not done, and deliberately: pausing animation while a drag is in progress is
impossible without claiming the mouse, which is the trade this document already
refused.
