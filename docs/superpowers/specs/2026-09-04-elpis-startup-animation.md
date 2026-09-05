# Elpis startup animation

## Goal

Show the supplied Elpis logo animation during real authenticated startup work so normal launches
have an Elpis identity without becoming slower.

## Invariants

- The animation covers existing pending startup work and adds no minimum display delay.
- The implementation is Rust-native and performs no startup file or network I/O.
- Existing terminal restoration remains authoritative on completion, error, and cancellation.
- `tui.animations = false` and undersized terminals use a stable compact rendering.

## Acceptance

- [ ] A pending normal-launch future produces the nine-row `ELPIS` logo and multiple animation
      phases when animations are enabled.
- [ ] Readiness returns immediately, even if fewer than two animation frames were displayed.
- [ ] Solar, cyberpunk, synthwave, frost, crimson, and matrix palettes can be selected with keys
      1-6 while startup is pending; solar is the supplied default.
- [ ] Esc or Ctrl+C returns a cancellation outcome so the caller can shut down the app server and
      restore the terminal.
- [ ] A small viewport shows `Elpis is starting` without clipped logo cells.
- [ ] Disabled animation produces a stable frame and does not schedule animation ticks.

## Non-goals

- Requiring first-run onboarding on every launch.
- Writing the Python prototype or a second theme configuration into the product.
- Changing syntax highlighting, the `/theme` picker, provider startup, or session semantics.
- Holding the splash for a fixed duration after Elpis is ready.
