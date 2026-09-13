# Drag selection and clean copying — September 12

## Current installed candidate

CLI source `1741efdd` is installed at `~/.local/bin/elpis`, SHA256
`423a11b2260e55ab008c717b1399081dc0c4ebeae28791c707c2eeb59f94ac9c`.
The installed-binary `mouse-installed-smoke` passes cross-boundary copy during
streaming. Previous binary: `~/.local/share/elpis/release-recovery/mouse-selection-20260912/elpis-before`.
Full production and packaged IDE acceptance remain separate, unfinished gates.
The sections below preserve earlier failures and intermediate candidate states.

### Corrected xterm evaluation

The terminal-only probe isolated the failure to the test configuration. xterm's
`allowSendEvents: true` forcibly disables its `allowXXXOps` settings, including
mouse operations (documented in xterm 390's installed-package manual). The fixture
now leaves that setting at its default and uses XTest input. It accounts for the
two-pixel terminal border and finds the window by class, since Elpis changes its
title. The F12 screen-print action is paused during selection. Earlier resource,
modifier and coordinate hypotheses were not product defects.

`xterm-live-correct` and `xterm-cross-light` pass release/Ctrl+C copy, clipboard
retention after dismissal, and continued streaming; the cross-boundary screenshot
was inspected. `xterm-wheel-valid` reaches first/latest history and returns via q.
The corrected `xterm-live-control` still fails on the old installed source
`2265c0d0`, preserving a valid negative control. No additional Elpis source change
or Rust rebuild was needed for these harness corrections.

## Original baseline

The original installed CLI (SHA256
`24a96237abaf1f4431c33e119e6bb4e8f568c34d0ee1f0a1139324f0b3fc6c13`)
failed two distinct user requirements before this investigation's repairs.

## Reproduced failures

1. Native GTK/VTE drag during an active local-fixture response loses its selection
   before release. PRIMARY clipboard is unavailable. Evidence:
   `.tmp/final-candidate/selection-user-followup/result.json` and `terminal.log`.
2. After completing the response, with animations disabled solely as an isolated
   control, dragging from the identity row into `preserve this draft` copies the
   identity, composer border, neighboring Context Ledger header, and prompt
   marker. Expected clipboard: `preserve this draft`. Actual clipboard:

   ```text
    Elpis · model gpt-5.6-terra · location ~/Desktop/p/Elpis/.tmp/fin
   │                                                                 │CONTEXT LEDGER  ≈520 tokens in context
   › preserve this draft
   ```

   Evidence: `.tmp/final-candidate/composer-copy-user-followup/result.json` and
   `composer-selected.png`, visually inspected. Disabling animation does not
   solve clean copying and is not proposed as the product fix.

## Claude Code comparison

Installed Claude Code 2.1.260 was launched in an isolated profile and workspace,
with a fake API key and an unreachable localhost provider. No model request was
submitted. Its fullscreen draft selection remained highlighted and displayed a
copy-on-release confirmation. The VTE clipboard itself was unavailable; capturing
and decoding its OSC 52 output proved the payload was
`❯ COMPOSER_COPY_SENTINEL_734129`, including a prompt marker and nonbreaking space.
Do not claim this case copied only draft text.

Evidence: `.tmp/final-candidate/claude-selection/selected.png`, `output.ansi`,
`copied-text.json`, and `check.cjs`. Screenshots were inspected. This is a composer
comparison, not proof of Claude's behavior during live inference or transcript
selection. Its [official fullscreen documentation](https://code.claude.com/docs/en/fullscreen#use-the-mouse)
describes application-owned mouse selection and automatic copying on release.

## Required repair

Elpis currently delegates selection to the terminal. Its mouse event handler
handles ledger clicks and middle-button paste, but not selection drag/release;
it does not enable terminal mouse capture. A terminal selection operates on
display cells and cannot distinguish source text from Elpis decorations or panes.
Reducing repaint traffic cannot implement the requested clean-copy behavior.

Selection needs source-text boundaries for the transcript and composer, stable
selection state across live updates, and explicit clipboard copying. It must
exclude the identity row, prompt/border decorations, and neighboring ledger
when selecting chat text. Preserve user text, including intentional indentation,
Unicode, and real newlines; do not strip characters heuristically from the final
clipboard. Keep animations and do not send, edit, or interrupt the draft/agent
as a side effect of selecting. Verify scrolling, resize, and mouse-mode cleanup
as part of integration, in both native VTE and VS Code's terminal.

## Composer implementation progress

Transcript layout now carries optional source-text mappings through prefixing and
wrapping. User messages retain their source text and logical-line identity before
wrapping; rich Markdown maps rendered text rather than its original markup.
Composed table content establishes a new logical source. Mutating a wrapped
fragment excludes hidden text from other rows and leaves earlier snapshots intact.
The mapping has not yet been connected to transcript mouse selection.

`transcript-source-regression-test-build.log` passed (160,393 ms, peak 64°C).
`transcript-source-full-tests.log` passed: 3,177 tests, 0 failed, 5 ignored.
Six new checks cover nested prefixes, Unicode, repeated wrapping and whitespace,
logical newlines, immutable source snapshots, appending to wrapped fragments,
and formatted Markdown at widths 8, 12, 28, and 80. Existing rendering snapshots
pass without updates. No new optimized artifact or installation was made for
this layout-only step; interaction and release validation remain pending.

The boundary follow-up permits starting a draft selection on its identity row,
border, or prompt gutter. It uses the actual rendered identity rectangle to
bound this region and keeps the neighboring ledger outside it. Pointer rows
above/below the textarea map to the first/last visible source endpoint,
independent of horizontal position.

- `selection-boundary-test-build.log`: successful build.
- `selection-boundary-full-tests.log`: 3,171 passed, 0 failed, 5 ignored.
  Added identity/border/gutter and adjacent-ledger checks, plus Unicode selection
  clamping above/below the text area.
- `selection-boundary-optimized.log`: successful optimized build.
- `selection-boundary-busy/result.json` and
  `selection-boundary-light-busy/result.json`: both pass the original
  identity-to-draft drag using the application selection handler during an open
  local-fixture response. Copy and Ctrl+C restore exactly the draft, without
  changing it, interrupting, or making another request. Both screenshots were
  inspected: only the draft is highlighted, with readable dark/light contrast.

These checks still use the test-only mouse-capture wrapper. Transcript selection,
scrolling, normal-runtime capture, and release installation remain unfinished.

The follow-up routing change releases Context Ledger focus when the composer
handles a drag. Ctrl+C copies a nonempty composer selection before interrupt or
side-conversation return handling; with no selection, existing key routing is
preserved. Active popups/modal views do not expose the underlying selection.
The same clipboard function handles release and keyboard copy.

Verification for this follow-up:

- `selection-routing-final-test-build.log`: successful build.
- `selection-routing-full-tests.log`: 3,169 passed, 0 failed, 5 ignored.
  The new focus test selects a draft while the ledger is focused and verifies
  Backspace edits only that selection without sending an operation. An initial
  version asserted immediate ordinary character insertion, which is deferred by
  paste detection; the direct editing check replaces that timing assumption.
- `selection-routing-optimized.log`: successful optimized build.
- `selection-routing-busy/result.json`: real GTK/VTE, animations enabled,
  response open. Focus ledger, select draft, replace the clipboard with a control
  value, then Ctrl+C. Clipboard returns exactly `preserve this draft`; draft
  remains and only the original request exists. Response stays open.
  `composer-selected.png` was inspected and retains the source-only highlight.
- `selection-routing-idle/result.json`: the same clipboard replacement/Ctrl+C
  check also passes after the response completes, with the draft preserved.

These files are under `.tmp/final-candidate/`. Mouse capture is still enabled
only by the test wrapper. This follow-up is not installed and does not establish
transcript selection or normal-runtime mouse-mode completeness.

The textarea now maps mouse coordinates to source byte ranges, paints selection,
and returns only selected source text on release. Typing/backspace/delete replace
the selected draft range. Rendering does not mutate the selected source. Composer
geometry excludes the prompt, border, and neighboring ledger; masked inputs and
active popups are not routed through this selection path. App events forward the
copy payload to the existing clipboard backend.

Five new tests cover soft wrapping in both directions, Unicode and real newlines,
tabs versus displayed spaces, selected-text editing, and rejecting a drag starting
outside the textarea. The last check is the textarea boundary contract, not proof
that the eventual application controller skips chrome when a drag starts there.
The full TUI suite passed: 3,168 passed, zero failed, five existing ignored.
Evidence: `.tmp/final-candidate/composer-selection-full-tests.log`.

An optimized executable passed two real GTK/VTE clipboard checks using a test-only
wrapper that enables mouse reporting. With animations enabled, both the active
response and completed-response cases copied exactly `preserve this draft`, with
no prompt or ledger text. The active response's connection remained open; no
extra provider request was sent. Screenshot inspected. Evidence:
`.tmp/final-candidate/composer-selection-{busy,idle}-padded/result.json` and
`composer-selection-busy-padded/composer-selected.png`. The initial fixture ended
one pixel short because it omitted VTE's left padding; those failed results are
retained in `composer-selection-{busy,idle}/result.json`. The corrected endpoint
is immediately after the final character's cell.

A further busy-response capture waited 1.2 seconds after release and retained the
selection highlight while the response stayed open; its exact clipboard check
also passed. Evidence: `composer-selection-busy-settled/result.json` and the
visually inspected `composer-selected.png` in that directory.

This is not a completed or installed selection feature. Global mouse capture
remains disabled in the normal runtime. Transcript selection, cross-region drag
handling, scrolling, selection-aware copy shortcuts, mouse focus transfer from
the Ledger, and mouse-mode lifecycle still need integration and terminal checks.
The user's existing installed executable is unchanged by this work.

## Pager geometry follow-up

While tracing transcript selection geometry, a focused regression reproduced
missing content when the pager's content rectangle has a nonzero screen origin:
three ordinary rows became three empty-row markers. The clipping loop compared
content-relative row offsets with absolute screen coordinates. It now clips
against zero and the content height. Footer geometry also fits the available
width, empty and single-row viewports are handled explicitly, and offset-buffer
height addition saturates.

Evidence under `.tmp/final-candidate/`:

- `pager-geometry-before-tests.log`: origin-invariance check fails against the
  previous renderer. The initial tiny-viewport no-panic check passed; it was
  strengthened to assert the visible percentage text.
- `pager-geometry-after-tests.log`: all 21 pager checks pass, including the two
  new cases. Existing snapshots required no updates.
- `pager-geometry-after-build.log`: test build passed, 166,968 ms, peak 68°C.
- `pager-geometry-full-tests.log`: 3,180 passed, zero failed, five ignored.

This patch has not been installed and does not establish that the user's main
terminal glitches are gone. The installed CLI remains the Up-recall candidate
with SHA256 `ca221c9fdaf1b700abde51418dd413d585c5ded9b8e7c60f44c31ca32d91e05b`.
Normal mouse capture remains off. Actual transcript selection, scrolling, and
mouse-mode lifecycle are still outstanding.

## Transcript viewer selection under integration

The transcript viewer now handles dragging, source-text highlighting, copy on
release, Ctrl+C copying, and wheel movement through a held document. Selection
uses the last displayed cells and live tail, so incoming events cannot change
what the initial click selects. The agent continues receiving output behind the
held view. Navigation resumes the live view; width changes and backtrack preview
discard stale selection coordinates. Clipboard ownership transfers to the chat
when the viewer closes, preserving copied text on Linux.

The source-row layout preserves Unicode, logical newlines, and the underlying
text across soft wraps while excluding the prompt decoration. Adjacent spans
with matching styles are combined. Row styles and hyperlinks survive the held
view; selecting a short range does not scan text from every unselected row.

Evidence under `.tmp/final-candidate/`:

- `transcript-copy-before-absolute/`: the previous viewer fails the native copy
  check with mouse reporting supplied by the fixture.
- `transcript-copy-close-before-detail.log`: the intermediate implementation
  copies the sentinel, then loses it on close (`afterClose: null`).
- `transcript-selection-row-style-full-tests.log`: 3,185 passed, zero failed,
  five ignored. New cases cover wrapping/Unicode, partial selection and real
  newlines, footer boundaries, full-row backgrounds including blank padding,
  incoming cells before and after mouse-down, resizing, and backtrack preview.
- `transcript-selection-row-style-build.log`: test build passed, 176,340 ms,
  peak 65°C. `transcript-selection-row-style-optimized.log`: optimized build
  passed, 43,567 ms, peak 72°C.
- `transcript-copy-row-style-{dark,light}/result.json`: native GTK/VTE checks
  pass. Dragging and Ctrl+C copy exactly the sentinel; the fixture delivers more
  text during the drag, verifies it appears after closing the viewer, and checks
  that the clipboard survives closing. One request remains open throughout.
  Both `selected.png` captures were inspected: the selection is readable and the
  original full-width message background is preserved.

Visual inspection rejected an intermediate implementation that reduced the
message background to the text width. The initial style test was too narrow;
it was corrected to compare with a paragraph styled across its entire area.
Earlier logs and captures are retained as intermediate evidence.

These native checks use the existing **test-only mouse-reporting wrapper** and a
local Responses fixture, not a live provider. Normal mouse capture remains off.
Main inline transcript selection, integrated scrolling/mouse lifecycle, xterm
acceptance, long-history performance, and final CLI/IDE gates remain open. This
is not an installed or released selection feature.

The built candidate SHA256 is
`e4db9cefc558c4cd64113c776aae4a129323fcbfba45dc5de8ea0c1a2cedfe20`.
The installed CLI remains `ca221c9fdaf1b700abde51418dd413d585c5ded9b8e7c60f44c31ca32d91e05b`.

## Synchronized selection repaint — September 12 follow-up

### Normal mouse integration — latest candidate

### Cross-boundary copy and suspend fixes — subsequent candidate

`cross-live-dark` reproduced decorative table dividers in copied text when
dragging from a completed user message into the live table. Table separators now
retain their visible style but carry empty selection metadata. `cross-live-fixed`
and `cross-live-fixed-light` pass: the copied words are exactly the selected user
message, table headings, and sentinel, allowing whitespace differences. Release,
Ctrl+C, retention after dismissal, and continued provider streaming are checked.

`mouse-suspend-live` and `mouse-suspend-repeat` reproduced enabled mouse modes
while the shell held control after Ctrl+Z. Tracing changed the timing and passed;
that traced run alone was not accepted as proof. Suspend now raises SIGTSTP on
the calling thread before re-enabling terminal modes. This suspends the Elpis
process rather than broadcasting SIGTSTP to its process group; separate tool
processes may continue. Untraced `mouse-suspend-fixed` and
`mouse-suspend-fixed-light` both confirm disabled modes while stopped, then exact
live-table copying after foreground resume with the original stream still open.

The final `suspend-fixed-test-build.log` and `suspend-fixed-optimized.log` pass.
`suspend-fixed-full-tests.log`: 3,191 passed, zero failed, five ignored.

xterm 390 was downloaded without the proxy and unpacked under the temporary eval
directory; no system package was installed. The harness required GdkX11 3.0,
UTF-8 locale, correctly escaped X resource translations, and a screen-print
action. Earlier xterm probes failed setup and are not product evidence.
`xterm-live-locale` and `xterm-live-held` reach the live table but fail copy: the
clipboard retains its control value. Pausing screen-print keystrokes during the
drag did not resolve it. The captured print row for the sentinel is 16 (10x20
cells), while the post-delta screenshot shows it two rows higher; inspect native
mouse coordinates and pre-drag display geometry next. xterm acceptance remains
unproven, and this candidate is not installed.

Normal startup now enables button-motion and SGR mouse reporting. It does not
enable all-pointer-motion events. The common terminal restore path disables mouse
reporting. Wheel-up opens the existing transcript viewer and scrolls upward;
wheel-down scrolls that viewer, and its documented `q` key returns to chat.
Escape retains the existing backtrack behavior.

The installed `2265c0d0` baseline fails the new live-table copy probe: mouse release
leaves `clipboard control` unchanged. Candidate `1eb35dc6` passes with test-only
capture. The normal-capture candidate then passes without that wrapper in
`mouse-live-direct` and `mouse-live-light`: exact source text copied on release
and Ctrl+C, clipboard retained after dismissal, one provider request still open.
An unfinished Markdown table is the valid live-tail fixture; unfinished ordinary
prose is intentionally newline-gated, as the controller tests establish.

Additional direct-candidate checks:

- `mouse-composer-direct`: light-mode busy draft copies exactly, draft survives,
  Ctrl+C copies, and the original stream stays open.
- `mouse-wheel-before`: baseline fails to open history under mouse capture.
- `mouse-wheel-close`: wheel opens history, reaches row 001, returns to the latest
  row, and `q` restores chat without interrupting. The earlier `mouse-wheel-direct`
  incorrectly expected Escape to close; retain that failure as a fixture correction.
- `mouse-restore-direct`: after normal exit, VTE answers DEC mode queries with
  disabled state for both 1002 and 1006. This checks terminal state, not just bytes
  that Elpis intended to send.

Live selection, busy composer, and wheel-top screenshots were inspected.
`mouse-integration-test-build.log` and `mouse-integration-optimized.log` pass;
`mouse-integration-full-tests.log`: 3,191 passed, zero failed, five ignored.
Cross-boundary drag, suspend/resume, xterm, and final release acceptance remain
open. xterm is not installed on this workstation. This candidate is not installed.

### Live-row snapshot follow-up

The main renderer now retains logical source lines, exact display rectangles,
and clipping offsets for active, hook, and pending-usage cells. Mouse selection
combines their visible rows with retained finalized history. Painting is limited
to the constituent rectangles, so a narrower live area does not erase the ledger.
Resize invalidates the cached live geometry. Wrapping the selection snapshot is
deferred until mouse-down rather than repeated during every animation frame.

`live-cell-test-build.log` and `live-cell-optimized.log` both pass.
`live-cell-full-tests.log`: 3,191 passed, zero failed, five ignored. New checks
cover a clipped source-aware streaming cell at a nonzero origin, Unicode, bullet
exclusion, and an invisible zero-height cell. Native history regression
`live-cell-history-regression` passes release/Ctrl+C copy and clipboard retention
while the provider stream stays open; its selected screenshot preserves the ledger.

Live-tail probes `live-cell-before` and `live-cell-static-before` failed setup:
the unfinished line did not appear. Running-command probes `live-command-before`
and `live-command-output-before` also did not expose the requested sentinel.
These are not negative controls or proof of working native live selection.
Native live/cross-boundary acceptance, scrolling, capture lifecycle, and installation
remain open. Normal mouse reporting is still disabled.

Inline selection now uses Tui's existing capability-gated synchronized update,
including cursor restoration and flushing. Unsupported terminals retain plain
drawing. This removes an unsynchronized path; elimination of flicker is unproven.

`selection-sync-test-build.log` and `selection-sync-optimized.log` both finish
with `build_result status=ok`. `selection-sync-full-tests.log`: 3,189 passed,
zero failed, five ignored. Native `selection-sync-native` copies exactly
`ELPIS_SELECTION_SENTINEL_734129` on release and Ctrl+C, retains it after
dismissal, and leaves the single provider stream open. Selected screenshot
inspected. This uses the test-only mouse wrapper; normal capture remains off
pending live-cell selection and lifecycle work. Candidate not installed.

## Main inline finalized history — subsequent candidate

The main chat now uses retained physical history rows for held selection. The
provider continues producing events while the displayed view stays fixed;
Escape dismisses selection without interrupting the agent. This covers finalized
history, including lines already committed by an ongoing streamed response.

The native `INLINE_HISTORY_COPY_EVAL` baseline failed to copy the sentinel.
Dark/light candidate runs in `inline-history-{dark,light}` copied only the sentinel
with Ctrl+C, retained it after Escape, and displayed output received during the
drag after dismissal. Both kept one provider request open. Both screenshots were
inspected and had readable selection highlights. These runs use the test-only
mouse-reporting wrapper and local fixture.

The strengthened `inline-history-release-{dark,light}` runs also assert that
mouse release itself copies the sentinel before replacing the clipboard control
and testing Ctrl+C. Both pass.

The TUI suite passed 3,189 tests with five ignored before the final Escape routing
correction; the native candidate includes and checks that correction. Candidate
SHA256: `bf20e06d936f852fe4dd03183c38e21729f6d1d9186ce3b86eca8badc58d46c8`.
It is not installed. Active-cell selection, dragging across live/history rows,
scrolling, alternate-screen restoration, and normal mouse lifecycle remain open.

## Viewer close and resize restoration

The native fixture originally always passed `--no-alt-screen`. Its first reopen
check failed because history was no longer visible after closing the pager. The
fixture now explicitly selects default alternate-screen mode when requested.

The default path retains inline source rows while the alternate screen is open,
restores them at the original geometry, and discards stale mappings on resize.
The no-alt-screen path rebuilds the transcript from its source when the pager
closes, using the existing transcript replay routine.

Final candidate checks pass in `inline-restored-dark` (no-alt-screen),
`inline-restored-alt-light` (default mode), and `inline-restored-resize-isolated`
(resize while the viewer is open). Each checks mouse-release copying, Ctrl+C,
Escape dismissal, and continued provider streaming. Screenshots were inspected.
The first resize attempt failed while hiding the ledger, before resizing; it
remains recorded as a setup failure, not a pass.

These checks still use test-only mouse reporting. Candidate SHA256:
`fcfc5414d81b245db57b36189cbc54e965dbdf159a1069ba4aeffbd444499ca3`.
Normal capture, scrolling, active-cell selection, and final installation remain open.

The final source test build passed in 251,056 ms (peak 70°C); its complete TUI
suite passed 3,189 tests, with five ignored, in 14.74 seconds. Logs:
`inline-restored-test-build.log` and `inline-restored-full-tests.log`.

## September 13 — swipes must not open the transcript

Masih rejected the automatic wheel-to-transcript transition. Removed that branch
from the main chat mouse handler; double Escape and explicit transcript controls
remain available. Earlier wheel-opening checks above describe superseded behavior.

The native VTE/Xvfb regression sends two wheel events in each direction, while a
fake-provider response is streaming and after completion. It checks that chat stays
open and the stream is not interrupted, then checks double Escape opens the
transcript. The previous installed binary fails with `swipe opened transcript`;
the candidate passes all checks. Its double-Escape screenshot was inspected and
shows the previous message selected. This tests terminal wheel events, not a
physical touchpad gesture. Evidence in `.tmp/final-candidate/`:
`swipe-regression.cjs`, `swipe-before/result.json`, `swipe-after/result.json`, and
`swipe-after/double-escape.png`.

Optimized build passed in 45,675 ms, peak 66°C. Installed CLI matches the tested
artifact, SHA256 `c2ff33c9fbb41ddae246ca01b4253a86aaa95528ffefc2a126274b7b7b7c4681`.
Previous binary retained at
`~/.local/share/elpis/release-recovery/swipe-20260913/elpis-before`.
Existing processes need restarting to use this change. Physical gesture acceptance
remains with Masih; no public release or IDE change was made.
