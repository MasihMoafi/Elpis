# Production candidate — September 12, 2026

The candidate is not production-ready. The later
[selection audit](selection-copy-20260912.md) supersedes the earlier active-response
selection failures below: corrected VTE and xterm checks pass. User acceptance
remains open. The reported long live-provider compaction delay has
not been reproduced. Public release and published-artifact verification remain
pending. This report supersedes the installed-artifact information in the earlier
UI audit; it does not grant user acceptance.

## Corrected defects

- Source follow-up, not yet installed: clearing a goal checked its owner only
  after deleting the workspace ES checkpoint. It now checks both records' owner
  metadata before deleting either record. Tests cover an unrelated goal-clear,
  a newer checkpoint owned by another thread, and a quoted owner line inside the
  result body. This does not change the workspace's last-writer-wins checkpoint
  design or establish protection against simultaneous cross-process file writes.
- With a response running and a queued input waiting, Enter in an empty composer
  now interrupts the response and sends the next queued input after cancellation
  completes. Repeated Enter does not issue duplicate interrupts. Enter with a
  draft still queues it, and Up still recalls all queued inputs for editing.
- Queue help now names the Enter and Up actions and wraps on narrow terminals.
  Secondary-text ellipses use terminal column widths, preserving complete emoji
  and combining sequences instead of clipping by character count. Existing
  detail-line limits remain; this does not promise unlimited expanded subtext.
- Explored/Exploring colors were checked against earlier revisions and have not
  reverted to the upstream palette. Their colors and existing animations remain
  unchanged in this follow-up.
- Animated border colors repainted invisible foreground changes across blank
  cells. The terminal diff now ignores those changes, while retaining visible
  backgrounds and reversed, underlined, or struck-through spaces. Two regression
  tests cover the distinction. Captured output during the selection interval fell
  from 34,340 to 3,997 bytes. These are individual animation intervals, not a
  general throughput benchmark. Selection still failed after this correction.
- A fresh Linux installation launched but sandboxed execution panicked because
  Bubblewrap was absent. The Linux installer, self-updater, Debian asset manifest,
  and IDE package now include the companion executable. Downloads verify its
  checksum before replacing installed files. Corrupt-sandbox checks preserve the
  existing CLI and resource. Hosted CI builds the vendored sandbox and verifies
  the actual CLI through a clean, offline Ubuntu 24.04 install.
- Installer platform checks now live in `tests/install/test_install.sh`, reused
  by CI. They check the Linux resource and reject a corrupt download. The clean
  install check is `tests/install/clean_linux.sh DIRECTORY_WITH_ELPIS_AND_BWRAP`.

## Verification

Evidence is under `.tmp/final-candidate` unless another path is given.

| Check | Result | Evidence |
| --- | --- | --- |
| TUI suite | 3,159 passed; zero failed; five existing ignored | `production-tui-tests.log` |
| Enter/text-layout follow-up TUI suite | 3,162 passed; zero failed; five existing ignored | `ui-followup-final-tests.log` |
| Checkpoint ownership source follow-up | 3,163 passed; zero failed; five existing ignored | `memory-checkpoint-full-tests.log`; `memory-checkpoint-final-test-build.log` |
| Enter in native dark/light terminals | Draft queues; empty Enter interrupts; second provider request contains queued text | `enter-queue-after/result.json`; `enter-queue-light-after/result.json` |
| Follow-up CLI in VS Code terminal | Completion, pruning, resize/Tab, queue recall, three drag-copy trials passed | `ui-followup-xterm.log`; `/tmp/elpis-ide-startup-EBrqdj/folder` |
| CLI/updater suite | 24 passed; zero failed, including corrupt resource retention | `production-cli-tests.log` |
| IDE Node suite | 46 passed | `production-ide-tests.log` |
| Packaged VSIX startup | Six conversations passed: two each in empty, file, and folder windows | `production-packaged-ide-startup.log`; `/tmp/elpis-ide-startup-WnDCUW` |
| Final CLI in VS Code terminal | Completion, ledger focus/pruning/close, resize, all-message queue recall, three drag-copy trials passed | `production-final-xterm.log`; `/tmp/elpis-ide-startup-5oYRV1/folder` |
| Visual inspection | Activity/ledger text remains readable; existing palette and motion retained | `motion-1.png` in the final xterm directory |
| Fresh offline launch | Sign-in screen with no profile/auth/network | `production-clean-install.log` |
| Fresh offline CLI installation | Bundled sandbox executes, permits workspace writes, denies writes outside it | `production-clean-package.log` |
| Installer platforms/failure | Linux, macOS arm64, unsupported-platform rejection, corrupt sandbox retention passed | `production-installer-tests.log` |
| Native VTE selection | Still fails; PRIMARY clipboard unavailable after drag | `production-selection-fixed/result.json` |

The container allows nested namespaces with SYS_ADMIN and disabled outer
seccomp/AppArmor profiles; Elpis applies its own filesystem sandbox. Without
those container allowances, Bubblewrap correctly reported that the outer
environment prohibited namespace creation. This check does not claim compatibility
with hosts that disable unprivileged namespaces.

The local Bubblewrap executable was compiled from the repository's vendored C
sources, with the same minimal configuration as `codex-bwrap`, linking libcap
statically. Headers/archive came from Ubuntu's `libcap-dev` 2.66-5ubuntu2.4 package;
no workstation package was installed. CI builds the Rust wrapper through Cargo;
that hosted artifact and the Debian package still require CI verification.

## Compaction

The current app-server passed three V2 compactions with 128 KB of deterministic
history and a fixed 200 ms local provider delay. Elpis totals were 298–312 ms;
installed Codex 0.153.4 totals were 264–278 ms. This is a controlled local comparison,
not evidence that the user's live-provider stall is resolved.

A provider that never replies can be interrupted, after which the same thread
accepts and completes a new turn. A provider returning HTTP 400 fails compaction
and also permits a subsequent successful turn. Both checks passed.
Evidence: `production-compaction.log`, `production-compaction-cancel.log`, and
`production-compaction-error.log`. Fixture payloads contain no user conversations.

## Artifacts

CLI 0.2.0 SHA256:
`ca221c9fdaf1b700abde51418dd413d585c5ded9b8e7c60f44c31ca32d91e05b`.
Bundled sandbox SHA256:
`fec1a33f7eed16567ff508a462363f8cf5f7991ac5f5e5b621d2460364e423dc`.
IDE candidate version: 0.1.20. Its VSIX contains the runtime, sandbox, and license.

The renderer test build took 164,745 ms (70 C peak); the updater test build took
6,792 ms (61 C). Final optimized build took 30,866 ms (68 C). Each reported
`build_result status=ok` under the required two-job build wrapper.

The earlier installed follow-up included UI commit `dafcc61f` and the separate
resume-command repair `f93c259d`. Its optimized build reported success in
600,941 ms, including a long wait for another session's Cargo cache lock; the
wrapper recorded a 78 C peak and five thermal pauses. Evidence:
`ui-followup-optimized.log`. Dark/light queued-input screenshots and the final
xterm motion screenshot were inspected. Installed `resume UUID --help` accepts
the formerly rejected syntax; this check does not reopen the user's history.

Installed at `~/.local/bin/elpis`; its hash and the companion resource hash match
the artifacts above. The previous CLI is preserved at
`~/.local/share/elpis/release-recovery/ui-followup-20260912/elpis-before`.
To restore it, run:

```sh
install -m 755 ~/.local/share/elpis/release-recovery/ui-followup-20260912/elpis-before ~/.local/bin/.elpis.rollback
mv ~/.local/bin/.elpis.rollback ~/.local/bin/elpis
```

IDE 0.1.20 was installed from the tested VSIX. The installed and packaged runtime
hashes match:
`f316426acd857a8be5b2b97bd1b6f4d3cfe5876a254acd6c4a008c263ae85d0c`.
Installation output is in `production-ide-install.log`. No visible application
was opened. Start a fresh CLI by typing `elpis`; reload the IDE window to activate
the extension update. No public release or tag was created in this work.

The latest CLI follow-up makes plain Up recall the entire queue, even with an
existing draft or Ledger focus. Existing draft text is preserved after the
queued messages; recall does not submit or interrupt. Up is the default binding,
configured alternatives share the same whole-queue behavior, and the old
last-message-only restore function was removed. Popup navigation stays intact.

Installed baseline `up-all-installed-before/result.json` reproduces the failure:
three messages remain queued while the Ledger keeps focus. Candidate
`up-all-candidate/result.json` passes the same real VTE interaction: three normal
Enter presses queue messages, one Up recalls them with the draft, and subsequent
Enter submission reaches the local fixture with exactly the combined text.
Both screenshots were inspected. Full TUI tests: 3,178 passed, 0 failed, 5 ignored
(`up-all-final-full-tests.log`). Twelve reviewed snapshots update only the queue
hint/default shortcut and associated layout. Optimized build passed in 122,316 ms
with a 69°C peak (`up-all-optimized.log`). Evidence is under `.tmp/final-candidate/`.

The installed CLI matches the current artifact hash above. Its immediate
predecessor (SHA256 `24a96237abaf1f4431c33e119e6bb4e8f568c34d0ee1f0a1139324f0b3fc6c13`)
is preserved at `~/.local/share/elpis/release-recovery/up-all-20260912/elpis-before`.
This installation includes the committed checkpoint-ownership and selection
foundation changes; transcript mouse selection is still incomplete and normal
mouse capture remains off. This is a CLI queue fix, not the final CLI/IDE release.
The installed binary also passed the same test in a light terminal
(`up-all-installed-light/result.json`); its recalled-draft screenshot was inspected.

## Checkpoint budgeting correction

The installed writer observed at `391ec269` produced a 9,604-character checkpoint
whose evidence pointer was outside the 8,000-character admission limit. The new
writer puts the transcript reference before details, retains the latest result,
and selects recent file/command entries within the budget, marking omissions.
It makes no provider calls and does not enable durable-memory promotion.

The long-turn Unicode regression failed against the previous writer (size over
8,000), then passed after the fix. The full TUI suite passed 3,192 tests with five
existing ignored tests in 14.64 seconds. A probe extracted from the actual entry
selection helper also passed recent-command retention, Unicode budgeting,
omission marking and near-full-buffer preservation. Raw local evidence:
`.tmp/final-candidate/checkpoint-budget-baseline-test.log`,
`checkpoint-budget-full-tests.log`, and `checkpoint-entry-probe.log`.
The fixed test build passed in 240,139 ms, peak 70°C, two jobs.

This is deterministic budget allocation, not semantic consolidation. Cross-thread
last-writer behavior, intelligent preservation of constraints/unresolved facts,
and measured task-quality benefit remain open.

Installed CLI source `2f0bdc8d`; build and installed SHA256 both
`9a544d0c62fa0ae1f41fd8e2b5d560706f58eff412ebc4d76c3f6e382a62d051`.
Optimized build passed in 93,851 ms, peak 70°C; installed `--version` reports
`elpis 0.2.0`. Rollback binary:
`~/.local/share/elpis/release-recovery/mouse-selection-20260912/elpis-before-checkpoint-budget`.
One worktree remains. IDE unchanged; no public release. This installation does not
close the outstanding production gates.

## Refreshed IDE verification and recovery audit

At CLI source `59964954`, all 46 prescribed editor tests passed. Direct headless
VS Code startup passed empty-window, single-file and folder cases, two responses
each, using the current local-release app-server. The snap CLI shim exited before
producing test results; rerunning with `/snap/code/current/usr/share/code/code`
reached and passed the assertions. This was a launch-fixture failure, not a passed
product check.

A new local VSIX was packaged from the current runtime. All 30 packaged source and
asset files matched the tested extension. Its extracted runtime passed the same
six conversations (`final-packaged-ide-startup.log`, fixtures
`/tmp/elpis-ide-startup-jlI3m8`). The VSIX was installed successfully; installed and
packaged runtime SHA256 both equal
`f316426acd857a8be5b2b97bd1b6f4d3cfe5876a254acd6c4a008c263ae85d0c`.
This is identical to the prior stripped runtime, so no new IDE behavior is claimed.
Rollback is `~/.local/share/elpis/release-recovery/mouse-selection-20260912/ide-before-checkpoint-runtime.tar.gz`.
Raw logs are under `.tmp/final-candidate/final-editor-tests.log`,
`final-ide-startup-direct.log`, `final-ide-package.log`, and `final-ide-install.log`.

The worktree audit now identifies recovered ACE behavior present in main and the
missing restart/resume regression. Larger agent-control work remains preserved
and unfinished. See [the recovery audit](../WORKTREE_CLEANUP_20260910.md).

`CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 scripts/verify-elpis --surface full`
completed with exit 0 (`full-release-gate.log`). This covers the verifier's declared
formatting, workspace, TUI, context/pruning, telemetry, work-graph, memory and
provider checks; it is not every possible test or manual production acceptance.
The restored archive test passed: no manual memory before admission, then exactly
one planted marker in the first model request after app-server restart/resume.
Existing admission/withdrawal boundaries passed alongside it. The added test was
formatted separately and compiled/executed by the app-server target after the
initial workspace check. No runtime code changed during this verification pass.

## Installed CLI final interaction and offline install

The installed CLI (`9a544d0c…`) passed a fresh native VTE queue check:
Enter queued three messages; one Up with the ledger focused recalled all three
plus the draft without sending or interrupting; Enter then submitted their exact
combined text. `final-up-queue/result.json` records both expected and submitted
text. The recalled-draft screenshot was inspected and its four lines were readable.
This is scoped evidence, not blanket visual acceptance.

The same installed binary passed `bash tests/install/clean_linux.sh
.tmp/final-candidate/linux-package` in the existing offline Ubuntu 24.04 image:
installation, version, bundled Bubblewrap, allowed workspace write and denied
outside write. `bash tests/install/test_install.sh` passed supported/unsupported
platform cases and corrupt-sandbox preservation. Logs: `final-clean-linux.log`,
`final-installer-tests.log`. The first direct script invocation failed because the
script lacks its executable bit; invoking it through Bash ran the actual checks.
These checks validate the local artifact, not a hosted release or Debian package.

The user's saved `~/.elpis/compaction.json` still has `remaining_percent: 30`.
A read-only scan of this thread's rollout found 18 compaction records and their 18
completion notifications, but no start/timing events. Therefore it cannot measure
compaction duration or establish the cause of the reported delay. The existing
controlled timing comparison remains the only measured latency evidence; the
live-provider delay remains unresolved. Metadata-only scan evidence is
`current-session-compaction-events.json`; no conversation contents were copied.

## Running session versus installed binary

The process holding this conversation's rollout (PID 44849 at inspection) still
uses its old, unlinked executable, SHA256
`24a96237abaf1f4431c33e119e6bb4e8f568c34d0ee1f0a1139324f0b3fc6c13`.
The installed CLI is `9a544d0c…`. Atomic installation does not replace code in an
already-running process. This explains why this conversation can still write the
old, command-heavy checkpoint despite the installed writer correction. No process
was killed. To apply the installed changes to this thread, restart and use:

```bash
elpis resume 01a08a44-2bba-7213-bce0-4a7e5f0423aa
```
