# Every test binary in the workspace — September 20, 2026

## Decision question

The existing verification surfaces run the interface, the engine, the two
integration suites, and the model catalogs. Nothing had ever run the rest. What
is in there?

## Method

`cargo test --profile dev-small --workspace --lib --bins --no-run` produced 152
test binaries. Each was run with its own empty `TMPDIR`.

## Result

**10,391 passed, 13 failed.** Every failure sat in a crate no surface covers, so
none of them was new; none was introduced by the current release cycle, and the
crates involved have not changed since it began.

Resolved during this survey:

| Crate | Failing | Cause |
| --- | ---: | --- |
| `codex-linux-sandbox` | 3 | Adding `.elpis` beside `.codex` to the protected metadata names left three expectations listing the old set. |
| `codex-app-server-protocol` | 1 | Two generated TypeScript fields advertised `?: number \| null` for values the wire omits rather than nulls. |
| `codex-app-server-transport` | 3 | Two were an artifact of this survey: a long temp path exceeded the Unix socket limit. The third failed one run in three, waiting one second for an event every neighbouring wait allows five. |
| `codex-thread-store` | 1 of 4 | Four tests forced the rollout compatibility write through `memory_mode`, which the memory-pipeline deletion removed, so their patches became empty and exercised nothing. |

Still open:

- **`codex-thread-store`, 3 tests.** Now failing on the behavior they were
  written to check. Clearing git information writes `git: {}` into the rollout
  instead of omitting the key. A rollout whose declared session id disagrees
  with its filename is adopted instead of rejected — the mismatch guard exists
  but this path does not reach it.
- **`codex-app-server`, 1 test.** `detect` returns a plugin that is configured
  but absent from the installed marketplace; the filter that should drop it
  does not.
- **`codex-core-plugins`, 1 test.** Environmental, and only on Masih's machine:
  the skills loader resolves the real `~` rather than the Elpis home it was
  handed, so the test reads his personal `~/.elpis/config.toml` and its extra
  skill roots. It passes anywhere `HOME` is clean, including CI.

## What this changes

The honest coverage number for this repository is the workspace number, not the
four-suite number. `scripts/verify-elpis` does not select these crates; until it
does, a change like the `.elpis` rename can break three tests and nothing says
so. Wiring them in should wait until the five open failures are closed, because
a gate that is known-red teaches everyone to ignore it.
