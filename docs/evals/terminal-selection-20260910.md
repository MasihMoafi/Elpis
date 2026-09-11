# Terminal and release investigation — September 10, 2026

The release goal is still open. Passing focused checks does not establish that
the terminal glitch is fixed or that the full candidate is ready to publish.

## Full TUI regression check, 2026-09-11

At `de5a23e5`, the optimized TUI library suite passed: 3,145 passed, zero
failed, five ignored, in 18.20 seconds. Evidence:
`.tmp/final-candidate/tui-final-snapshot-review.log`. Snapshot updates were
reviewed against the corrected queue shortcut, spinner removal, full-width
dialogs, and unknown context capacity. Tests now keep footer tips deterministic,
use the production terminal renderer for the update prompt, explicitly select
plugin feature states, and retain visible approval warnings in history fixtures.
The debug badge is asserted separately from profile-independent header snapshots;
this run exercised the optimized profile, not a separate debug execution.

The broader verification run is tracked in
`.tmp/final-candidate/full-surface-post-tui.log`. It subsequently completed with
exit code zero in 1,099,115 ms; the result is recorded in
`full-surface-post-tui-result.json`. This does not resolve native selection or
constitute an installed CLI/IDE release check or Masih's acceptance.

## Installed candidate after full checks, 2026-09-11

The optimized CLI was rebuilt and installed, SHA256
`7a8dd64e0d763450af18a6446fd1ee41189be7883f8d84f2ff0e0e6e87d55729`.
The official IDE packaging command produced a 43-file VSIX; its stripped runtime
SHA256 is `f6ab4e7a838162058d824cbd4e6d71a32e5566074323477033bbad57e8b83ac9`.
It passed the unprivileged, offline, read-only Ubuntu smoke check. Both the package
and the installed extension passed six conversations across empty/file/folder
windows. The CLI passed Tab/resize, two queued follow-ups recalled with Up, and
three exact native drag-copy trials in the VS Code integrated terminal.

Evidence under `.tmp/final-candidate/`: `post-full-optimized-build.log`,
`ide-current-package.log`, `packaged-runtime-post-tui-clean.log`,
`packaged-ide-post-tui-startup.log`, `installed-ide-post-tui-startup.log`, and
`cli-post-tui-controls.log`. Installed hashes were checked. The CLI was opened
on the desktop and `shown-installed.png` inspected. Existing VS Code windows
need reloading to use the replacement extension.

These remain local candidates with version labels 0.2.0 and 0.1.19, not a new
public release. Rollback copies are under
`~/.local/share/elpis/release-recovery/post-tui-20260911-Od3bhz/`.
The VTE selection limitation remains open; no claim that all glitches are fixed
or that Masih has accepted the candidate is supported.

Current editor source also passed 44 unit checks and six real startup conversations
across empty, single-file, and folder windows against runtime SHA256
`39cf21d98901fe299f8c10e255762c126f305c3744225b36d96c8540228a812c`.
The source checkout required restoring cached npm dependencies and building its
generated assets first. Initial missing-asset and test-driver failures were retained.
The driver now tolerates destroyed execution contexts, with a failing-then-passing
focused check and an unexpected-error control. Three startup screenshots were
captured and inspected. Evidence: `.tmp/final-candidate/editor-post-tui-unit.log`,
`editor-post-tui-startup-window.log`, and `webview-context-final.log`; screenshots
are in `/tmp/elpis-ide-startup-CaWqVM/{empty,file,folder}/startup.png`.

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
the selection/typing issue, the full failure audit, final
CLI/IDE verification and installation, and the authorized release.

## Queue follow-up, 2026-09-11

Commit `53942103` fixes Ctrl+Q being swallowed while the slash-command popup is
open. The previously failing queued `/compact` regression now passes. Native
terminal evidence also passes: queue `/compact` and a second message during an
active response, press Up, and both return to the composer. Tab only toggles the
ledger; the fixture provider received exactly one request throughout the check.

The optimized executable SHA256 is
`443a3c9c035908a22568f334072eb96f7c56a72f2d32cf4ab6509e3f59eb1165`.
Build: 40,319 ms, peak 71°C. This candidate has not been installed or released.
Complete TUI suite: **2,959 passed, 181 failed, 5 ignored**. The failures still
require review; this queue result does not resolve the VTE selection failure.

Local evidence: `.tmp/final-candidate/tui-slash-queue-full.log`,
`slash-queue-optimized-build.log`, `slash-queue-native.log`, and
`slash-queue-native/result.json` in the same directory. Generated `.snap.new`
files are unaccepted diagnostic evidence. The previous full verification process
stopped during compilation without a result file and must be rerun.

## Regression follow-up, 2026-09-11

Commit `66cffdd1` recognizes both runtime spellings of archived-session guidance
and presents `elpis unarchive`. The positive cases cover resume/fork and both
spellings; the negative case preserves an unrelated startup error. Both tests pass.

Six visual snapshots were individually reviewed and updated for the removed
spinner, ledger shortcuts, and explicitly unmeasured context. Status visibility
tests now allocate the component's requested height. The manual-memory composer
test drains only the initial skill-list operation before asserting that blocked
input cannot submit a turn. These checks pass in commit `becb0734`.

The complete TUI suite reports **2,970 passed, 171 failed, 5 ignored** in
`.tmp/final-candidate/tui-status-memory-full.log`. The full-surface check caught a
formatting issue, corrected in `12660d48`, and restarted under
`.tmp/final-candidate/full-surface-after-format.log`. No full-surface pass or new
installation/release is claimed.

## UI fixture review, September 11

Commit `4fd4c759` updates 25 snapshots where the main dialog content is unchanged
and only the ledger differs. The complete set of replacement ledger text was
reviewed: shortcut hints, unmeasured context, and the existing pruning status.
The comparison is recorded in `.tmp/final-candidate/ledger-snapshot-review.json`
and `ledger-snapshot-verification.json`; the latter confirms unchanged main content
and no unreviewed replacement ledger text for all 25 snapshots.

Three app snapshots were reviewed separately against the current header/ledger
design. Their shared header renderer excludes the build-only debug badge from
snapshot comparison. Completion tests now use the listed `/rename` command and
retain their draft-preservation and suffix checks.

The optimized test build passed in 209,514 ms, peak 73°C. The complete TUI run,
including the restored pruning policy, reports **3,000 passed, 141 failed,
5 ignored** in `.tmp/final-candidate/tui-ledger-fixtures-full.log`. This batch
corrects stale fixtures; it does not prove the remaining terminal glitch resolved.

## Preview isolation, September 11

Settings previews now render their selected items without the global live-session
banner, which previously hid the actual preview values. Five existing behavior
checks failed before this change and pass afterward. Synthetic chat-widget tests
also seed an absent project root, so an unrelated `/tmp/.git` marker cannot supply
their project name. Explicit project-root fixtures still provide their own values.

All 17 preview checks and nine terminal-title checks pass. Thirteen snapshots were
reviewed: selected preview values, the synthetic project fallback, and the already
reviewed ledger text are the only changes. The optimized test build passed in
243,101 ms, peak 72°C. The complete suite reports **3,019 passed, 122 failed,
5 ignored**, with no new failing tests relative to the preceding run. Evidence:
`.tmp/final-candidate/preview-isolation-build.log`, `preview-isolation-accepted.log`,
`project-title-isolation.log`, and `tui-preview-isolation-full.log`. No new release
or installation has occurred; terminal-selection limitations remain open.

## Stable fixture review, September 11

Another 14 snapshots have unchanged main-pane text; their only changes are the
already reviewed ledger labels and wrapping. The exact paths and replacement
ledger text are retained in `.tmp/final-candidate/remaining-ledger-only-review.json`.
The session-picker stale-indicator test now swaps frame buffers between renders,
as the real terminal draw path does. Its existing positive/negative indicator
assertions failed before this correction and now pass.

The shared `/usage` snapshot sanitizer substitutes a fixed fixture version.
Eighteen snapshots differed only in the release version; all 45 status tests now
pass (`.tmp/final-candidate/status-version-fixture-final.log`). The test build
passed in 193,004 ms, peak 73°C with one thermal pause. These are fixture
corrections, not evidence that the terminal-selection issue is resolved.

The final complete run reports **3,050 passed, 91 failed, 5 ignored** in
`.tmp/final-candidate/tui-fixture-final.log` (21.34 s). No newly failing tests were
introduced relative to the preceding 122-failure run. Release and installation
remain pending the outstanding functional work and acceptance.

## Context wording and current executable, September 11

The shared context category now says `Reasoning + compaction` and explains that
these are retained-history estimates, not the effort setting. The new rendering
check failed before the correction; positive cases pass at narrow and wide widths,
and the negative case omits the category. All 22 active context-report checks pass (one ignored),
and the rendered Ledger agrees with the shared label and colors.

Related tests now inspect popup content separately from the surrounding header
and Ledger when checking notice lifecycle; their full-screen snapshots still use
the full widget. The permission-cycle check observes its queued policy event,
and the footer-spacing check uses sufficient width and recognizes the empty rail.
The final full TUI run reports **3,059 passed, 83 failed, 5 ignored**, with no new
failures relative to the preceding committed baseline. Logs:
`.tmp/final-candidate/context-label-before.log`, `context-label-after.log`,
`context-ledger-label-final.log`, and `tui-context-final.log`.

The optimized CLI build passed in 247,122 ms, peak 72°C. Its SHA256 is
`c85e05208afa5f5a8eacbf5428da3a5a790e710b50fac8f194fe304df5ec62e6`;
the companion app-server SHA256 is
`39cf21d98901fe299f8c10e255762c126f305c3744225b36d96c8540228a812c`.
The new CLI passed the actual VS Code integrated-terminal check: resize and Tab,
two queued inputs restored for editing, and three exact native drag-copy trials
during a response, with only one provider request. This uses the existing
installed IDE extension to host the terminal; it is not a new IDE package test.
Evidence: `.tmp/final-candidate/context-ui-native-terminal.log`,
`context-ui-native-terminal-result.json`, and `context-ui-native-terminal.png`.
The screenshot was inspected: both restored inputs and the selection are visible,
and there is no visible red caret artifact in this captured frame. This does not
settle intermittent VTE selection. Neither new binary has been installed or released.

The IDE ledger's own mapping also now labels this field `Reasoning + compaction
(estimated)`. Its DOM-rendering check failed before the text change and passes
afterward, including the missing-attribution control. All 44 editor unit checks
pass with the new local app-server selected as the test runtime. Evidence:
`.tmp/final-candidate/ide-ledger-label-before.log`, `ide-ledger-label-after.log`,
and `editor-unit-context-final.log`. The native-terminal screenshot above does
not serve as visual acceptance of this separate IDE ledger text change.

The refreshed local pruning audit records **1,884,230 estimated tokens removed**,
**8,147,106 optimizer tokens**, 1,026 attempts across 20 sessions, and 36 missing
usage reports. It covers 637 available rollouts and reports no malformed records.
This is gross one-time compression, not proven net savings. Data is retained in
`.tmp/final-candidate/smart-prune-usage-refresh.json`; the HTML was regenerated,
viewed and committed in `b1860852` with this timestamped data.

## Independent terminal control, 2026-09-11

The installed official Codex CLI 0.153.4 was run in the same GTK/VTE harness with
the local streamed sentinel. Its first attempt never submitted a turn and supplies
no selection evidence. The settled-input trial disabled startup updates and plugins
in its isolated profile and waited 1,500 ms before pressing Enter.

In `donor-selection-settled-1`, VTE reported selection changing from true to false
during the drag, and clipboard retrieval failed. In `donor-selection-frozen-1`,
pausing the CLI processes before dragging allowed exact sentinel copying. These
are one live-output trial and one frozen-output control, not a reliability estimate.
Both recorded two local `/responses` requests; their purpose has not been audited,
so the recorded request timing is not a valid performance comparison with Elpis.
The frozen result's generic check label says “during stream”; the stream was open
but CLI output was paused for selection. Evidence is under `.tmp/final-candidate/`.

This supports an output-related terminal interaction shared with the donor CLI.
It does not establish a fix, or show that all reported typing artifacts have the
same cause. The native selection issue remains open.

## Minimal output control, 2026-09-11

A Node emitter printed the same stationary selection sentinel and label inside
the existing GTK/VTE harness, with no Elpis process or provider requests. In one
trial per condition, repainting the label every 125 ms failed native selection;
updating only its indexed palette color through OSC 4 also failed. The otherwise
identical static control copied the exact sentinel. Evidence:
`.tmp/final-candidate/repaint-isolated-1/result.json`,
`palette-isolated-1/result.json`, and `static-isolated-1/result.json`.

This rejects palette-only animation as a demonstrated workaround in this harness.
It does not establish reliability rates or resolve the user's typing artifact.
The emitter and wrappers are scratch controls, not shipped implementation changes.
