# Memory contention and native drag selection — September 20, 2026

## Decision questions

1. Does an overlapping automatic memory-save boundary still surface the routine
   `another memory save is already running` warning?
2. Can native GTK/VTE selection hold an exact composer drag while a response remains active?

Masih's visual use remains the acceptance boundary. These checks establish a local candidate,
not a released version.

## Memory-save contention

The focused regression uses the real snapshot locks and covers three cases: a short overlap waits
and succeeds, contention lasting through the one-second bound coalesces as `Ok(None)`, and an
unrelated malformed-settings error remains visible.

Before the source correction, the sustained-contention case failed with exit 101 and
`Error: another memory save is already running`. After the correction:

```text
test memory_save::tests::waits_for_short_memory_lock_but_coalesces_contention_and_surfaces_other_errors ... ok
test result: ok. 1 passed; 0 failed
```

The change does not suppress arbitrary save errors. It converts only the private lock-contention
condition at the bounded deadline into a coalesced save.

## Native selection experiment

Question: does terminal-native selection survive an active response without application mouse
capture?

Fixed conditions:

- isolated home and local synthetic Responses provider;
- 109-column by 37-row GTK/VTE terminal on an off-screen Xvfb display;
- response held open after emitting a sentinel;
- draft text `preserve this draft` typed while the response remains active;
- screenshot capture paused during the gesture;
- twelve-step drag at 40 ms per step, followed by exact X11 PRIMARY selection comparison.

Independent variable: installed Elpis candidate or Codex 0.155.1. The negative evidence showed
three Elpis-only recurring redraw sources: composer/footer motion, the identity/status motion, and
the terminal-title spinner. The latter continued to emit terminal updates about every 100 ms after
the first two were quieted. Each source received a failing scheduler regression before correction.

Final result:

| Candidate | Exact selections | Result paths |
| --- | ---: | --- |
| Elpis candidate | 5/5 | `.tmp/final-candidate/sfj1` through `sfj5` |
| Codex 0.155.1 control | 3/3 | `.tmp/final-candidate/cfj0` through `cfj2` |

Each passing result copied the exact draft while the response remained active. The final Elpis
motion uses a fast 800 ms burst followed by a four-second redraw-free wait shared by the status,
identity, and terminal-title animation. The composer border and approval label remain static while
a task runs. Ordinary terminal mouse capture remains disabled, preserving the existing native
wheel/two-finger scrolling path.

Retained negative evidence:

- `.tmp/final-candidate/sn1` and `sn2`: selection disappeared during the earlier continuous
  repaint candidate;
- `.tmp/final-candidate/sfi0/terminal.log`: title-driven content changes continue through the
  drag before the final title pacing correction;
- `.tmp/final-candidate/sfj0`: selection held with zero drag-time content updates, but an
  evaluator endpoint five pixels short omitted the final letter; the endpoint was corrected
  before the scored repetitions.

## Verification and installed artifact

- The contention regression, composer no-continuous-frame regression, status pacing regression,
  identity pacing regression, terminal-title pacing regression, and existing identity animation
  behavior all pass.
- The terminal-title module passes 5/5 tests.
- `scripts/verify-elpis` selected the full surface: workspace check and all 38 selected command
  groups passed with exit 0. Existing stable-rustfmt notices about the nightly-only
  `imports_granularity` option remain; this is not a zero-warning claim.
- The guarded optimized build passed and was installed atomically. Artifact and installed binary
  share SHA-256 `49f4ef0cfdb22772e0354823e5b24bd554808e90c41ef6139f28a7b103ff3c0c`.

Already-running Elpis processes still map their prior executable. A full Elpis restart is required
before either correction can be accepted in Masih's normal terminal.

## Boundary

The selection result covers composer text during one held-open local response in GTK/VTE. It does
not prove every terminal emulator, cross-region transcript selection, or arbitrary multi-second
drag. The memory result covers overlapping save ownership; oversized provider output and legacy
checkpoint recovery remain covered by their separate U21 checks.
