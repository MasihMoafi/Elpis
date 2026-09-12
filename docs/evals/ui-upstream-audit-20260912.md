# UI and compaction audit — September 12, 2026

Masih rejected the installed UI at `635b5b48`. Earlier passing tests did not cover
slash completion through the top-level key router or first-press ledger focus.
This audit does not grant visual acceptance or authorize a premature release.

## Reference

Updated the clean `/home/masih/Desktop/p/codex` reference with
`gh repo sync --source openai/codex --branch main`, without force or local edits.
It moved from `a9519cbc` (August 31) to
[`c4017a87`](https://github.com/openai/codex/commit/c4017a87aacc7558002b7cb510025e967c1d765e)
(September 12). Elpis remains a separate, single worktree. This is a source
comparison against current main, not a claim that a current-main Codex binary was built.

## Differences and causal confidence

| Surface | Current Codex | Rejected Elpis candidate | Finding / correction |
| --- | --- | --- | --- |
| Tab completion | Composer popup handles completion | Ledger intercepts Tab first | Reproduced: `/com` stayed unchanged. Route popup Tab before ledger. |
| Ledger controls | No Elpis ledger | Visible but unfocused panel hides on first Tab; `p` only works when focused | Reproduced. Tab focuses the visible panel, then closes it. Alt+C remains unconditional visibility toggle. |
| Cursor during redraw | Hides before changed-frame writes; caches style | Caches style but paints with visible cursor | Cursor can travel with output writes. Adopt changed-frame hiding; unchanged frames retain visibility. Actual red-artifact acceptance still requires terminal inspection. |
| Frame limiting | Records actual emission time | Records requested deadline | Late deadlines can defeat pacing. Adopt upstream timestamp. Upstream regression test also passed on old Elpis, so it is not evidence of a reproduced timing failure here. |
| Elpising motion | Animated status has its own scheduling | Effect sampled every 125 ms, elapsed delta capped at 100 ms | Nominal 8 FPS and slowed effect progression. Use a shared 40 ms cadence and a moving highlight over the orange-yellow palette, with no separate spinner. |
| Idle frame ownership | Animation owners schedule their own frames | Static identity line drives periodic redraws, incidentally animating permissions | Move permissions scheduling to composer footer; retain the requested animated permissions label. Static identity no longer schedules frames. |
| Streaming text | Adaptive line commits without Elpis reveal hold | 420 ms coalesce and 500 ms minimum line age | Replace disappearing glyphs with a 160 ms foreground transition; reduce the commit hold to 180 ms. Text is readable from its first frame and still animates. |
| Layout | Inline transcript with full-width composer; modal restoration paths | Composer-aligned ledger consumes width and reserves its height | More wrapping, layout work, and changing viewport geometry. This remains an Elpis-specific design tradeoff, not proof of a terminal-library defect. |
| Status text | Whole-grapheme brightness shimmer, separate status timer | Character gradients plus dissolve/coalesce | Adapt the moving highlight to whole graphemes and Elpis colors. Remove the separate dissolve state; glyphs stay intact throughout. |
| Terminal dependencies | Ratatui 0.30.2 and Crossterm 0.29 with OpenAI fork | Ratatui 0.29 and Crossterm 0.28 with older fork revisions; TachyonFX 0.11.1 | Current upstream terminal code is not a drop-in file replacement. Port bounded fixes with tests; a dependency migration needs its own compatibility work. Version drift alone is not proof of the reported glitch. |
| Manual compaction | Provider capability selects streamed V2 | Feature selects V2; stable default is enabled | Active OpenAI config has no V2 override. Legacy endpoint existence alone does not explain this user's delay. |
| Compaction preparation | Step owns prepared tool router; trace input clone conditional | Rebuilds tool router; always clones trace input and prompt input | Extra local preparation work is present. No measured attribution to the reported long delay yet. |
| Compaction retries | V2 stream retry budget capped at two | Same cap of two | No evidence that a larger Elpis retry count explains the delay. |
| Compaction effort | Selected effort or feature-controlled window pin | Current selected turn effort | No upstream rule that compaction always uses low effort. Lowering effort would change behavior, not establish parity. |

Key upstream sources: `tui/src/tui/frame_requester.rs`,
`tui/src/custom_terminal.rs`, `tui/src/custom_terminal/cursor.rs`,
`tui/src/summary_shimmer.rs`, `tui/src/status_indicator_widget.rs`,
`core/src/tasks/compact.rs`, `core/src/compact_remote_v2_attempt.rs`,
`core/src/compact_remote_v2.rs`, and `core/src/session/reasoning_effort.rs`.
Cursor work is particularly recent:
[`33bdf976`](https://github.com/openai/codex/commit/33bdf976ccd1130823d4fe041e4d5075ab511d67).

## Verification contract

- Actual ChatWidget routing: `/com` + Tab completes without executing; no popup
  means Tab enters ledger controls; `p` requests pruning without entering draft text;
  subsequent Tab closes. Preserve ordinary Enter and all-message Up recall.
- Terminal writes: hide cursor before changed output; restore after positioning;
  unchanged frames do not hide/show or reset the style.
- Headless terminal: completion, pruning on/off, close/reopen, active-turn draft,
  Enter-three/Up-once, resize, settled text, and selection. Inspect screenshots.
- Compaction: distinguish dispatch/preparation, provider wait, and completion
  display. Source differences or unrelated session durations are not a latency benchmark.
- Keep original failure evidence and record build, test, artifact, installation,
  and unresolved limitations separately.

## Final local candidate

The readable-motion correction passed **3,155 TUI tests, zero failures, five
existing ignored** (14.46 seconds). The optimized build passed in 106,210 ms,
two jobs, peak 71 C, with no cooling pauses. Logs:
`.tmp/final-candidate/ui-sep12-motion-tests.log` and
`.tmp/final-candidate/ui-sep12-readable-optimized.log`.

The actual headless VS Code terminal passed completion, pruning on/off, ledger
focus/close, resize, Enter-three/Up-once recall, and three exact drag-copy trials.
It made one local fixture conversation request. Animation-phase assertions keep
the activity label and ledger sentence intact; motion screenshots were inspected.
The earlier candidate failed this check with `activity animation removed its label`.
Final evidence: `.tmp/final-candidate/ui-sep12-readable-terminal.log` and
`/tmp/elpis-ide-startup-hnYGdf/folder/{motion-0,motion-1,motion-2,terminal}.png`.

Candidate SHA256:
`b386b39a5fc54b0758e23910b07253a4ba52df422d77fdce4ae00e2991ce894e`.
This identifies the local CLI correction, version 0.2.0, not a public release.
Installed atomically at `~/.local/bin/elpis`; installed and built hashes match.
Rollback executable: `~/.local/share/elpis/release-recovery/ui-correction-20260912/elpis-before`.
The IDE extension/runtime were not changed in this TUI-only correction. The
installed extension's preceding six-conversation check remains recorded in
`.tmp/final-candidate/installed-ide-post-tui-startup.log`: two conversations each
in empty, file-only, and folder windows. Broader preceding verification returned
code 0 in `full-surface-post-tui-result.json`; it is not a fresh workspace-wide run.

The installed correction was also retested in native VTE under Xvfb. Completion
of the selection failed: the PRIMARY clipboard reported `target STRING not
available` after a continuous drag during the active response. The harness was
updated for the corrected Tab focus/close sequence. Evidence:
`.tmp/final-candidate/native-sep12-readable.log` and
`.tmp/final-candidate/native-sep12-readable/result.json`.

A follow-up isolated selection from ledger keys and paused screenshot/text
sampling before the drag, while leaving CLI output running. Selection still
failed (`native-sep12-selection-isolated/result.json`), ruling out ongoing
sampling as a necessary cause in that trial. The preceding combined attempt
stopped earlier on a ledger-close assertion and supplies no selection evidence
(`native-sep12-no-capture/result.json`). Minimal static and 125 ms repaint controls
both selected the exact marker with sampling paused (`native-sep12-control-0`
and `native-sep12-control-1`, each `result.json`). These single trials differ in
output volume/cadence from Elpis; they do not support blaming all animation or
declaring the issue exclusively VTE's fault. Earlier controls were intermittent.
No production changes followed this experiment. Confirmation of the original
red typing artifact still needs the user's terminal identity and a current
reproduction; native clipboard failure is not proof of the same defect.

Remaining release limits: native VTE live selection still fails; the reported
long live compaction stall was not
reproduced by the controlled fixture; user visual acceptance remains open.
These checks do not establish that every terminal glitch is gone.

### Launch checklist

Type `elpis` in a fresh terminal invocation. Try `/com` then Tab; the draft should
be `/compact `. Clear it, press Tab then `p` to control Smart Prune; Tab closes,
Esc returns to editing, and Alt+C toggles visibility. During a response, queue
three messages with Enter and press Up once in the empty composer to edit all
three. Inspect the orange-yellow activity highlight, ledger/stream brightness
transitions, cursor and mouse selection in the terminal you normally use.

## Earlier evidence

The new completion and first-press pruning tests each failed on the rejected
implementation. Red logs: `/tmp/elpis-tab-red.log`, `/tmp/elpis-ledger-red.log`.
Red test build passed in 159,110 ms, peak 67 C, two jobs. One initial test compile
failed because test code accessed private state; tests now assert rendered width
and dispatched events instead. The upstream late-frame test passed before the fix.

Pre-visual-review TUI suite: **3,155 passed, zero failed, five existing ignored**, 14.76 seconds.
The preceding suite had 3,124 passes and 31 failures: three old ledger-interaction
expectations and 28 snapshots containing the changed ledger hint. Those expectations
were updated explicitly; snapshot changes were confined to hints and their wrapping
(three layouts gain one row). No unrelated snapshot was accepted. The initial
sandboxed suite was stopped after embedded-runtime failures; the completed runs
had the localhost access those fixtures require.

That build also passed the actual VS Code terminal checks: completion, pruning
on/off, close/reopen, resize, all-three queue recall, and three exact selections,
with one fixture conversation request. However, its screenshots visibly showed
holes in animated ledger words. It was **not installed**. The subsequent motion
correction keeps all glyphs present, applies foreground transitions to changed
ledger/stream text, and uses a moving warm-white highlight over activity and
permission gradients. Light backgrounds get a dark highlight instead. Tests
now require glyph preservation rather than treating missing letters as success.
The first visual evidence remains at `/tmp/elpis-ide-startup-7nT4Ah/folder`.

The five most recently modified real rollouts contained compaction completion
markers but no paired start records suitable for phase timing. Their contents were
not copied into this report. No claim of measured compaction speedup follows.

## Controlled compaction timing

Question: does the runtime add a long delay when model-server latency is held
constant? Same temporary project and user message, Low effort, isolated clean
profiles, local Responses fixture with a fixed 200 ms delay. Seed one turn, then
three sequential manual compactions, each checked for exactly one V2 trigger.
No paid inference and no user's conversation contents. Sequential compactions
have changing history, so trials are paired stages, not identical independent samples.

| Runtime | Dispatch/preparation, ms | Fixture wait, ms | Completion after reply, ms | Total, ms |
| --- | --- | --- | --- | --- |
| Installed Elpis IDE runtime 0.1.19 | 74.7 / 68.2 / 70.2 | 200.4 / 201.3 / 199.7 | 10.6 / 9.1 / 8.3 | 285.7 / 278.6 / 278.2 |
| Installed Codex 0.153.4 | 30.8 / 30.9 / 26.4 | 201.0 / 200.9 / 200.0 | 14.0 / 9.9 / 10.4 | 245.9 / 241.8 / 236.8 |

Elpis added roughly 37–41 ms overall in this small-history fixture. That is a real
local difference, but it does not explain a many-second or minute-long slowdown.
Both sent Low effort. Request sizes differed because their instructions and tool
schemas differ (first requests: 71,620 versus 63,026 bytes). This is not a matched
large-history or live-provider benchmark, nor a build of the freshly updated Codex main.
The fixture measures app-server completion, not terminal rendering.

Evidence: `.tmp/final-candidate/compaction-latency.cjs`,
`.tmp/final-candidate/compaction-latency-sep12.log`,
`/tmp/elpis-compact-timing-gdfoRE/result.json`,
`/tmp/elpis-compact-timing-a1uDz6/result.json`.
Initial fixture attempt failed because compressed requests were not decoded;
the corrected fixture handles zstd. Sandbox localhost denial required escalation.

The same comparison with 128,000 bytes of deterministic message padding also
passed all six V2 calls. Elpis totals were 300.7 / 301.5 / 308.9 ms versus Codex
262.6 / 263.0 / 270.3 ms. Dispatch/preparation was 77–81 ms versus 35–39 ms;
completion after the response was 20–28 ms versus 25–31 ms. The roughly 38 ms
difference persisted rather than growing into a long stall. This tests message
volume, not a tool-heavy multi-day transcript or real provider inference.
Evidence: `.tmp/final-candidate/compaction-latency-large-sep12.log` and
`/tmp/elpis-compact-timing-Tfaurm/result.json`,
`/tmp/elpis-compact-timing-XeZWsW/result.json`.
