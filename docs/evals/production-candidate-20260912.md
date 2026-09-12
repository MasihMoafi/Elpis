# Production candidate — September 12, 2026

The candidate is not production-ready. Native GTK/VTE drag selection still fails
during an active response. The reported long live-provider compaction delay has
not been reproduced. Public release and published-artifact verification remain
pending. This report supersedes the installed-artifact information in the earlier
UI audit; it does not grant user acceptance.

## Corrected defects

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
`efad517e4141defabd747998b95d85fc73b8a792e943ca4eba6f01ca7a223d16`.
Bundled sandbox SHA256:
`fec1a33f7eed16567ff508a462363f8cf5f7991ac5f5e5b621d2460364e423dc`.
IDE candidate version: 0.1.20. Its VSIX contains the runtime, sandbox, and license.

The renderer test build took 164,745 ms (70 C peak); the updater test build took
6,792 ms (61 C). Final optimized build took 30,866 ms (68 C). Each reported
`build_result status=ok` under the required two-job build wrapper.

Installed at `~/.local/bin/elpis`; its hash and the companion resource hash match
the artifacts above. The previous CLI is preserved at
`~/.local/share/elpis/release-recovery/production-20260912/elpis-before`.
To restore it, run:

```sh
install -m 755 ~/.local/share/elpis/release-recovery/production-20260912/elpis-before ~/.local/bin/.elpis.rollback
mv ~/.local/bin/.elpis.rollback ~/.local/bin/elpis
```

IDE 0.1.20 was installed from the tested VSIX. The installed and packaged runtime
hashes match:
`f316426acd857a8be5b2b97bd1b6f4d3cfe5876a254acd6c4a008c263ae85d0c`.
Installation output is in `production-ide-install.log`. No visible application
was opened. Start a fresh CLI by typing `elpis`; reload the IDE window to activate
the extension update. No public release or tag was created in this work.
