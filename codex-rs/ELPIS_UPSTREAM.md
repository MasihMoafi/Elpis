# Codex Foundation Provenance

This directory was imported from the committed `codex-rs` tree in
[`openai/codex`](https://github.com/openai/codex) at revision
`2e1607ee2fa8099a233df7437adee5f16a741905`.

- Imported on: 2026-07-15
- Source tree: `codex-rs/`
- License: Apache-2.0; see `LICENSE` and `NOTICE` in this directory.
- Import rule: use committed Git objects only. Do not copy the donor working tree.

Since the import, Elpis has deleted nine upstream crates: `analytics`, `cloud-tasks`,
`cloud-tasks-client`, `cloud-tasks-mock-client`, `feedback`, `memories`,
`ext/memories`, `realtime-webrtc`, and `v8-poc`. It has also modified many upstream
files in place, chiefly in `tui`, `core`, `app-server`, and `app-server-protocol`.

On 2026-09-29 Elpis adopted a different foundation method for the move to the
latest Codex release: vendor the release unmodified, carry Elpis as copied
Elpis-owned modules plus small marked seams, and switch unwanted upstream
surfaces off by configuration instead of deleting them. `docs/GUIDE.md` records
the method; `TASKS.md` records its progress.
