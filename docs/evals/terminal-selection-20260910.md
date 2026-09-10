# Terminal and release investigation — September 10, 2026

The release goal is still open. Passing focused checks does not establish that
the terminal glitch is fixed or that the full candidate is ready to publish.

## Later queue, startup, and IDE checks

The next optimized candidate is
`a026a83a3321752a6ecbbbadd10e7a7265f84f449afc4ce9b0f65bb806073e28`.
It is built but not installed. Its changes are committed in `7b25ef10`
(reachable queue shortcut), `b95b9abd` (startup delay), and `612b6c49`
(context-test expectations).

- Ctrl+Q is the default explicit queue shortcut; Tab remains ledger-only.
  A real VTE test failed before the binding change, passed with a profile override,
  and then passed with the rebuilt default. Two messages remained unsent during
  the active response, and Up returned both to the composer for editing.
- Startup no longer waits for a 2.3-second cosmetic minimum. The loading animation
  still runs while initialization is pending. The rebuilt candidate reached ready
  in 229 ms with animations enabled in the controlled test. The earlier animated
  candidate took 2,473 ms; three reduced-motion controls took 131–196 ms. These are
  local fixture measurements, not a claim about every account or project.
- 100 focused Rust checks passed: queue/Tab (6), startup (5), keymap (64), and
  context-usage (25), with two manual visual tests ignored. The new ready-work
  test ensures completed initialization does not wait for the entrance animation.
- The candidate passed a real VS Code integrated-terminal test using native keys
  and mouse events: Tab hide/show during a response, panel shrink/expand, draft
  preservation, two queued messages recalled with Up, and three exact drag-copy
  trials. The installed binary also passed three selection trials in that
  terminal. These results do not erase the VTE failures recorded below.
- All 44 editor unit tests passed against the installed 0.1.19 runtime. The runtime
  extracted from its VSIX matches the installed runtime and passed the shipping
  smoke test in cached Ubuntu 24.04: unprivileged fresh home, read-only root,
  no network, no account, successful initialization and configuration read.

The first full verification sequence passed the workspace check and 38 dashboard
tests, then stopped on two context checks. One expected the old Tab help text;
the other was a stale uppercase `ELPIS` assertion in a shared test helper, not a
production context-measurement failure. Both expectations were corrected.
The full sequence is being rerun in `full-surface-after-queue.log`.

The complete updated TUI binary still reports **2,938 passed, 202 failed,
5 ignored**. Those failures remain to be audited. No broad snapshot acceptance
or claim of full correctness has been made.

Additional local evidence: `queue-native.log`, `queue-default-fixed.log`,
`selection-no-motion.log`, `queue-startup-build.log`,
`queue-startup-test-build.log`, `queue-startup-focused.log`,
`tui-full-after-queue.log`, `vscode-terminal-queue.log`,
`vscode-terminal-verified-result.json`, `vscode-terminal-verified.png`,
`editor-unit-final.log`, and `ide-clean-container.log`. The first IDE terminal
attempt injected text before startup was complete; later attempts used the
recorded ready event and native key events. A screen-reader-mode trial had
different Tab focus behavior; the passing combined test used normal keyboard
mode and the DOM terminal renderer.

## Earlier probe and redraw checks

- `Elpising…` uses the animated orange-yellow palette; its separate leading
  spinner stays removed. The Elpis name keeps its original static color.
- The terminal diff does not erase unchanged blank row tails. Identical frames
  emit no cell updates; changing one label does not clear other rows.
- Unix startup queries synchronized-output support with DECRQM 2026 and enables
  synchronized drawing only after a supported response. Unknown/unsupported
  terminals use ordinary drawing. This does **not** by itself fix selection.

The optimized CLI built in 125.710 seconds with two jobs, one compiler thread,
and a 71°C observed peak. Its SHA-256 is
`b74f54c6c73c2883ef40ab131b78ecbc654f529b434011fd221f42f01ef6cc61`.
It is not installed. The installed CLI remains
`d94d86f7ee81698aec3a7ec9408caa2c2d63cf8ea7378e201bc1a31ff7f3ae66`.
The guarded test build passed; terminal-probe tests (9), terminal-diff tests (6),
and status-indicator tests (10) passed. A captured running frame was inspected
to confirm the Elpising colors and absence of the leading spinner.

## Selection experiment

The harness launches the real CLI inside GTK/VTE 0.76, under Xvfb, with an
isolated profile and a local streaming Responses fixture. It types a draft,
closes/reopens the ledger with Tab, and uses native pointer events and the X
primary selection to copy a unique streamed marker. No paid provider is used.

- The earlier diff-only candidate passed 2 of 8 drag trials.
- Pausing the CLI before selection passed 3 of 3 trials.
- A static terminal control passed. Replaying captured terminal output can
  reproduce the failure without running Elpis.
- Removing synchronization sequences made one replay control pass, but the
  capability-aware CLI still failed all 8 held-drag trials. Its startup log
  reported `synchronized_output_supported=Some(false)`, and its output trace
  contained no synchronization sequences. Synchronization is not the sole cause.
- With a continuous 12-step drag and exact-text assertions, both installed and
  candidate binaries passed 2 of 3 trials. The selection failure remains open.

VTE's `Terminal::process_incoming()` compares a pending selection with the
PRIMARY clipboard after output modifies its screen and may call `deselect_all()`.
`Terminal::start_selection()` pauses PTY reads, but already pending output is
relevant to the reproduction. This is evidence about the terminal interaction,
not a claim that every reported typing glitch has the same cause.
See [VTE 0.76 source](https://github.com/GNOME/vte/blob/0.76.0/src/vte.cc).

## Broader verification

The complete pre-probe TUI unit binary reported **2,922 passed, 215 failed,
5 ignored**. Of the failure reports, 131 are snapshots and 84 are other
assertions. Five explicitly contain unexpected local Ollama model events.
Some queue tests still use Tab to queue, which conflicts with the requested
ledger-only binding. These results need review; neither snapshots nor behavioral
failures have been blindly accepted or dismissed as harmless.

The full verification surface passed its diff and formatting stages and is
running the workspace check under the two-job limit. It was resumed in a detached
runner to avoid a tool-session timeout; compiler cache is retained. A separate
watcher pauses its process group at 75°C and resumes at 70°C.

## Local evidence

Evidence is under `.tmp/final-candidate/`: `probe-build.log`,
`probe-test-build.log`, `probe-unit-tests.log`, `terminal-diff-tests-final.log`,
`elpising-tests-final.log`, `elpising-visual/busy.png`, `selection-probed.log`,
`selection-continuous.log`, `frozen-repeat.log`, `replay-filters.log`,
`selection-traced-probe/`, `tui-full-tests.log`, `full-tui-failures.json`, and
`full-surface-detached.log`. These are local evidence, not release artifacts.

One worktree remains. No new release has been published. Remaining work includes
the selection/typing issue, the queue shortcut, the full failure audit, final
CLI/IDE verification and installation, and the authorized release.
