# Permission verification — 9 October 2026

Current candidate: `Elpis-wt-parity`, exact Codex 0.162.0 source integration completed; verification in progress. **Not yet compiled or installed.** Earlier build/test claims belonged to the 0.160 candidate and do not establish this candidate's correctness.

The coordinator reran the bridge fixtures against the older, uninstalled engine at `Elpis-next/codex-rs/target/release/codex`: 34 Claude checks and 27 Gemini checks passed. Both runs failed saved Full Access after a process restart: `never` was retained but `:danger-full-access` resumed as `:workspace`. This remains a required final-engine check.

Covered: restricted/default access, Full Access, live promotion/revocation, rejected settings, delayed approvals/plan changes, unconfirmed `turn/start` fields, concurrent chats with opposite permissions, interruption/revocation of one chat, unknown ACP session rejection, duplicate-turn rejection, and cold resume after revocation. Providers are deterministic local fixtures, not live Claude/Gemini accounts.

Evidence: `/tmp/elpis-bridge-permissions-RON2nK` (Claude), `/tmp/elpis-bridge-permissions-AWkmq3` (Gemini). Logs: `.tmp/bridge-claude-verification.log`, `.tmp/bridge-gemini-verification.log`.

A second coordinator run on the same old engine passed all 12 ordinary/native Code Mode cases, then reproduced an extra approval after Full Access for a code cell retained from an earlier turn. The cell completed, so this is a permission failure, not an unfinished-cell timeout. Evidence: `/tmp/elpis-live-permissions-odYOYJ`; log: `.tmp/code-mode-old-regression.log`. The final engine must also pass this case and cross-turn revocation.

Run against the final binary:
```sh
node scripts/permissions-runtime.test.cjs /absolute/path/to/elpis
node scripts/permissions-runtime.test.cjs /absolute/path/to/elpis --code-mode
node scripts/permissions-bridge.test.cjs /absolute/path/to/elpis
node scripts/permissions-bridge.test.cjs /absolute/path/to/elpis --gemini
node scripts/terminal-input.test.cjs /absolute/path/to/elpis
```

The build guard passed 17 isolated fake-compiler checks, including early pause, hard ceiling, lost sensor and process cleanup. This does not replace temperature monitoring during a real build. Local Rust compilation is deferred to hosted CI because free disk is below the project's 40 GB floor.
