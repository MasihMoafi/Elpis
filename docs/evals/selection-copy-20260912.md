# Drag selection and clean copying — September 12

The installed CLI (SHA256
`24a96237abaf1f4431c33e119e6bb4e8f568c34d0ee1f0a1139324f0b3fc6c13`)
fails two distinct user requirements. No selection repair has been installed by
this investigation.

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
