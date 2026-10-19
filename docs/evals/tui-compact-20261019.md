# T6 · measured compact engine · 19 October 2026

**Uninstalled candidate: 252,874,208 → 182,849,856 bytes; saves 70,024,352 bytes (27.69%).** Engine only; host/tools unchanged.

Both builds use source `333cc1e11`, Rust tree `ae7cdcc013` (identical to installed `a8`), toolchain `1.95.0` and the same CLI features. Bridge `08a` and pointer `a8` remain included.

| This run | Fast control | Compact |
| --- | --- | --- |
| LTO / optimization / units / incremental | false / 1 / 256 / true | thin / s / 4 / false |
| Build wall | 13m04s | 17m47s |
| Cgroup peak | 11.20 GiB | 8.68 GiB |
| Peak temperature | 75°C | 74°C |
| Artifact SHA256 prefix | 89592419 | 328c793c |

Debug none/strip symbols both. Guarded offline builds passed without pauses/stops; mandatory kernel limits verified. I/O controller unavailable; both used ionice 7. [Contract](../specs/tui-compact-20261019.md).

Passed: matching help/version; 12 native light/dark cases (startup selection, exact OSC52 payload, streaming copy without interrupt, scrolling, Agent click/provider identity); 12 bridge regressions including `08a` join/refusal. Five rendered captures inspected: [dark](/home/masih/.cache/elpis-tests/tui-compact-20261019-c2hcogww/bench/compact-dark.png), [light](/home/masih/.cache/elpis-tests/tui-compact-20261019-c2hcogww/bench/compact-light.png).

Limits: one build each; fast dependencies already cached. CLI warm-version medians 50.95/48.94 ms (12 paired samples); coarse TUI timings establish no speed gain. Real inference, code-mode host, OS clipboard and daily use untested; full Rust suite not rerun.

[Versioned receipt](tui-compact-20261019.json) · [full evidence](/home/masih/.cache/elpis-tests/tui-compact-20261019-c2hcogww/comparison.json). Private homes/link trashed; no own processes remain. **Shared target/release/codex is experimental `328c793c`; installed `78ef58f2` and defaults remain unchanged. Root owns shipping.**
