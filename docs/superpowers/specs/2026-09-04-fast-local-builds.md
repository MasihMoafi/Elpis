# Fast, measurable Elpis builds

## Goal

Make ordinary Elpis check/build cycles and locally optimized candidate builds materially faster,
bounded by an 80 C thermal guard, without weakening the shipping profile silently.

## Acceptance

- [x] `check`, `dev`, `optimized`, and `shipping` select explicit Cargo operations; none runs a
      broad test suite.
- [x] `optimized` uses a distinct `local-release` profile with LTO disabled, incremental output,
      optimization level 1, 256 codegen units, and no debug information.
- [x] The wrapper probes and reports the Rust 1.96 parallel front end and bundled LLD; unavailable
      accelerators fall back to the selected Cargo profile rather than blocking the build.
- [x] The default job count is half the logical CPUs capped at eight; an explicit positive override
      is accepted.
- [x] A temperature at or above the configured limit prevents Cargo from starting.
- [x] Crossing the temperature limit during a build terminates the Cargo process group and exits
      nonzero.
- [x] Every run reports mode, profile, jobs, elapsed milliseconds, peak temperature when readable,
      and artifact bytes when a binary was produced.
- [x] Optimized artifacts retain the existing atomic installer and path-leak check before install.
- [x] Ledger, Smart Prune, generic TUI, and mixed-known-path edits select focused checks; unknown
      or safety-owned paths still select the conservative full surface.
- [x] Long builds run in a named detached terminal while independent source work continues.

## Measured evidence

- first replacement-profile build: 726,453 ms, 77 C peak;
- changed-source optimized rebuilds: 18,645 ms and 20,199 ms, at most 76 C;
- warm no-change optimized rebuild: 1,553 ms, 65 C;
- wrapper and changed-file selector shell harnesses pass.

The shipping profile itself remains deliberately unchecked here. It is the unchanged release
profile and must be measured in a detached terminal before claiming a shipping-speed improvement.

## Non-goals

- Removing tests from explicit functional or shipping acceptance surfaces.
- Making the ThinLTO shipping profile appear faster without measuring it.
- Installing a linker, compiler cache, package, or remote service.
- Sharing Cargo targets between divergent worktrees.
