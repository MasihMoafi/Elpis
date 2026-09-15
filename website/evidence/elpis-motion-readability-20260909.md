# Motion readability correction — 2026-09-09

Masih reported insufficient ledger contrast, streaming glitches, and startup/
Elpising motion that moved too quickly to read. This supersedes the earlier visual
acceptance assumptions; passing snapshots did not establish comfortable motion.

## Corrections

- Startup holds the full Elpis name for 1.4 seconds, then dissolves over 0.9 seconds.
- Elpising holds readable text for 1.8 seconds before a 0.9 second dissolve and
  0.9 second coalesce. Disabled animation remains static.
- Coalesce lasts 420 ms. Each queued line must be at least 500 ms old before it
  enters terminal history. Previously the oldest line's age gated the entire batch,
  allowing younger lines to leave the viewport before completing their effects.
- Ongoing effects move with the viewport and remain attached to surviving rows
  when committed rows leave its front. Previously those changes cleared effects,
  producing an abrupt jump to fully visible text.
- Ledger accents retain the orange/yellow family with a larger brightness spread.
  Truecolor dark-background contrast ratios are 6.04, 10.69, 13.47, and 7.08 against
  RGB(17,18,20). Labels and marker shapes still identify categories independently.

The native capture now includes populated context attribution, the Elpising cycle,
stream commit ticks, and accumulated history; the earlier empty-ledger capture did
not adequately cover this complaint. This is still a Rust widget replay, not an
end-to-end provider or desktop smoothness benchmark. X11 desktop capture returned
a black image under Wayland, so it cannot establish anything about the visible UI.

## Verification

127 focused tests pass: motion 7, startup 4, streaming 56, ledger 51, and status
indicator 9. Two initial test assertions incorrectly assumed one effect per line;
the renderer creates word effects. The corrected movement tests preserve the
existing effect count and already-revealed characters instead of assuming a count.
Both native export tests pass.

Inspected populated-ledger, mid-stream, and startup captures. An audit of all 170
stream frames finds all five sample response lines complete exactly once; after
each line becomes fully visible, none disappears or duplicates during the remaining
capture. Startup captures retain the full name at 0, 400, 1200, and 1400 ms and
show it dissolving at 1800 ms. This covers the simulated native widget path, not
every provider/terminal combination or finalization case. Previously identified
unrelated baseline test failures remain outside these focused checks.

Evidence: `/tmp/elpis-readable-checks.json`, `/tmp/elpis-readable-final-motion.log`
(supersedes initial movement assertions), `/tmp/elpis-readable-frame-audit.json`,
and `/tmp/elpis-readable-visual-export.log`. Native replay and screenshots are in
`~/Desktop/tmp/elpis-design-playground/actual/`. The replay strips OSC 8
hyperlink control sequences as a terminal would; raw captured cells retain them.
No claim that every previously reported terminal glitch is diagnosed.

## Installation

Guarded optimized build succeeded in 239.9 seconds, peak 70 C, no thermal pauses.
Built and installed SHA-256 match:
`9490f4d6f8356eb6588f9b4788e71418f3727310338695c361978be6115eb60d`.
Version is 0.2.0. The native replay and populated-ledger screenshot were opened;
the image viewer process was verified. User visual acceptance is still pending.
The installed executable also passes the isolated pseudo-terminal startup/theme
check: capitalized title, no ASCII banner, dark background, appearance picker,
persisted Light selection, and clean exit. Log: `/tmp/elpis-readable-installed-pty.log`.

Rollback to the previous installation:

```bash
scripts/install-elpis-binary.sh ~/.local/share/elpis/release-recovery/readable-motion-20260909/elpis-before
```
