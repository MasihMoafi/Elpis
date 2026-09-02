# Smart Prune mechanism verification — 2026-09-02

## Scope

This record covers the cache-stability construction and its failure boundaries. It does
not claim a provider-side cache hit, lower cost, lower latency, or unchanged task quality.

- Branch: `integration/elpis-stable`
- Tested code commit: `060a44a` (`fix(context): make pruning accounting honest`)
- Platform: Linux
- Build load: one Cargo job, one Rust test thread, process pinned to CPU 0-1 at low priority

## Command

Run from `codex-rs/`:

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    -u http_proxy -u https_proxy -u all_proxy \
    CODEX_SKIP_BWRAP_BUILD=1 CARGO_BUILD_JOBS=1 RUST_TEST_THREADS=1 \
    taskset -c 0,1 nice -n 15 \
    cargo test -p codex-core --test all --locked suite::smart_prune -- --nocapture
```

## Result

```text
test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 979 filtered out
```

The suite checks admission before first main-model exposure, exact later logical-prefix
stability, stable main and isolated optimizer cache keys, OFF-mode byte-exact passthrough,
and bounded fail-open behavior. See the parent protocol for the precise acceptance rules
and the limits of this evidence.
