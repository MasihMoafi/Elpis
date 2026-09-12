# Exact-resume command compatibility — September 12

## User-visible defect

The installed `elpis resume <UUID>` exits with code 2 and `unexpected argument`
for the UUID. This happens during argument parsing, before loading a session.
The supplied session's rollout file exists. No transcript recovery or rewriting
is needed to fix the reproduced failure.

`codex-utils-cli::resume_command` emits the positional command, but the shipped
`codex-tui` binary's `TopCli` exposed only `--resume SESSION_ID`. The separate
donor CLI already has a resume subcommand; changing that CLI would not repair
the actual installed Elpis binary.

## Bounded change

- Add `resume UUID` to the shipped parser using the existing UUID validator.
- Route it to the existing `Cli.resume_session_id` field and native startup.
- Preserve `--resume`, archive/delete/unarchive, and ordinary prompts.
- Reject invalid/missing positional IDs and conflicting resume forms.
- Test the actual continuation formatter's output against the shipped parser.

This does not add a session picker, change provider/authentication settings,
replay a prompt, alter compaction, or edit any session history.

## Verification and activation

Pre-fix installed executable: command fails, exit 2. Fix committed as `f93c259d`
and included in the UI owner's combined installation. Independently checked the
installed binary against `target/local-release/elpis`: both SHA256
`24a96237abaf1f4431c33e119e6bb4e8f568c34d0ee1f0a1139324f0b3fc6c13`.

Installed executable checks:

- `elpis resume 01a0952c-0ff6-7232-9590-4e5c29656c9a --help`: exit 0,
  `Usage: elpis resume [OPTIONS] <SESSION>`.
- Missing UUID and `not-a-uuid`: exit 2, explicit argument errors.
- Both `--resume UUID` and `resume UUID`: exit 1, explicit conflict error.

These checks do not load or mutate the live conversation. The sandbox reports a
nonfatal PATH-alias read-only warning, unrelated to the repaired parser.
The two-job, low-priority local-release test build completed. Initial sandbox run:
19 passed, 7 failed solely because updater mock servers could not bind ports.
Approved rerun of the same compiled test binary outside the sandbox: **26 passed,
0 failed**, including actual printed-command routing, legacy flag compatibility,
invalid/missing IDs, and conflicting resume forms.

Commands:

```sh
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo test --offline --profile local-release -p codex-tui --bin elpis tests:: -- --nocapture
# From the repository root, with approval for local mock-server ports:
env RUST_TEST_THREADS=2 nice -n 10 codex-rs/target/local-release/deps/elpis-11ce7fc1f7f063e2 tests:: --nocapture
```

Masih's actual same-thread resume remains the acceptance check; accepting
arguments alone does not prove successful history restoration.
