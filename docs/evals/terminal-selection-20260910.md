# Terminal and release investigation — September 10, 2026

The release goal is still open. Passing focused checks does not establish that
the terminal glitch is fixed or that the full candidate is ready to publish.

## Changes checked

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
