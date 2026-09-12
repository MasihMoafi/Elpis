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
