# Renewed scrolling, contrast and memory failures — September 14, 2026

Installed CLI SHA256: `d10ed3c15af00347c137083d2bdec3bd5d0f11c7a8cb0f0fc3e131d52cd5787e`.
One main worktree remains. No running user process was stopped.

## Reproduced and corrected

- Output arriving before a draw resets history to its follow-bottom sentinel;
  wheel-up then failed to move back. The failing offset was 34 instead of 29.
- Downward wheel events accumulated beyond the visible bottom; reversing upward
  still left the viewport at the bottom (30 instead of 27).
- The light-theme white sweep erased letters. Full-cycle measurement found a
  3.36 contrast ratio at 120ms; native VTE captures also showed disappearing text.
- With truecolor enabled and no background-color reply, context categories used
  pale RGB instead of the terminal's foreground.

Wheel events now start from the last rendered viewport position. The light sweep
uses a darker warm gradient and bounded highlight; dark rendering is unchanged.
Unknown-palette category and free-space text use terminal-default foreground.

## Verification

- Guarded offline test build and optimized build succeeded.
- 58 relevant tests passed; one manual motion export ignored. Two forced-truecolor
  checks passed. The four new regressions failed against their original code.
- Native VTE with a local streaming provider passed wheel opening history,
  scrolling to first/latest rows, and returning without interrupting the response.
- Captured 26 light animation frames; inspected frames 10 and 20. Labels and
  ledger text remain visible. Full-cycle numeric contrast check covers three
  light backgrounds. These checks do not prove physical touchpad acceptance.
- 15 existing memory runtime controls passed using a local synthetic provider;
  no paid model requests were made for these evaluations.

Evidence files are under `.tmp/final-candidate/`: `renewed-failures-*-tests.log`,
`renewed-palette-*-tests.log`, `renewed-wheel-after/result.json`,
`light-motion-reported-before/`, `light-motion-reported-after/`, and
`renewed-memory-runtime.log`. Initial native invocations used a relative binary
path and failed to launch; reruns used the absolute candidate path.

## Memory remains unresolved

The actual recent failed save completed its Luna request successfully, then
emitted a warning. Neither receipts nor runtime logs retained the exact failure
reason. This does not identify a checkpoint collision, malformed response, or
any other specific cause. No speculative save-policy change was made.

Backend logging now retains the full error chain when a save fails. This is
diagnostic, not a fix. Existing shared daemons keep their running code until a
safe restart; launching a fresh CLI alone does not replace that backend.
The full user-visible warning is still needed to identify this occurrence.

Recovery binary: `~/.local/share/elpis/release-recovery/scroll-light-20260914/elpis`.
Start the installed UI by typing `elpis`; already-running UI processes retain
their original executable. User acceptance and overall readiness remain open.
