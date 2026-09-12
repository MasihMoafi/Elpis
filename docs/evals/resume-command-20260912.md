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

Pre-fix installed executable: command fails, exit 2. Regression compilation is
in progress with the documented two-job low-priority local-release profile.
Automated results and installation status must be recorded before claiming the
fix is active. Masih's actual same-thread resume is the acceptance check.
