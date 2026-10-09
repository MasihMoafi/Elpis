# Permission verification — 9 October 2026

The Codex 0.162 recovery runtime builds and runs. **Not installed:** the inline Ledger layout fix still needs a rebuilt candidate, and helper permission changes are under final verification.

| Actual runtime check | Result | Evidence |
| --- | --- | --- |
| Installed Elpis, Full Access from the terminal | Reproduced an unwanted rejection: “approval policy is Never” | `/tmp/elpis-terminal-input-dfXoDi` |
| Candidate, native permission changes | 10 passed | `/tmp/elpis-live-permissions-XDKcXO` |
| Candidate, Code Mode including cells retained across turns | 14 passed | `/tmp/elpis-live-permissions-D6PMQl` |
| Candidate, Claude bridge including cold Full Access resume | 35 passed | `/tmp/elpis-bridge-permissions-prd3cb` |
| Candidate, Gemini bridge including cold Full Access resume | 28 passed | `/tmp/elpis-bridge-permissions-cCyZsg` |
| Core permission and continuity unit tests | Passed in CI 37925769646 | Build job 113804212137 |

Candidate runtime: CI source `8451f9ca2fb016012a962b987fd04f9cb29a75b6`, matching local `4d3d1fcd3`; SHA-256 `f449a04786bfeb9b1fdc992729b64ae6d2e2d85256a30a61edabc525b3e0f340`. Bridge runs above include the first helper fix `4dd898f3b`; pending follow-up changes need their own checks. Providers are deterministic local fixtures, not live Claude/Gemini accounts.

Coverage includes promotion, revocation, rejected updates, delayed approvals, unconfirmed settings, simultaneous chats, unknown ACP sessions, duplicate turns, and persisted choices after restart. The new runtime fixes the older engine’s cold Full Access resume and cross-turn Code Mode failures. Helper checks exposed additional bridge-specific races; their final outcome remains pending.

Run on the final installed binary: `scripts/permissions-runtime.test.cjs` (native and `--code-mode`), `scripts/permissions-bridge.test.cjs` (Claude and `--gemini`), `scripts/permissions-bridge-delegation.test.cjs`, and `scripts/terminal-input.test.cjs` (native and `--bridge`). The original 32-row terminal test must pass; the diagnostic runtime currently hides the completed reply behind the Ledger at that size.

Hosted CI performs Rust builds because local free space is below the 40 GB floor. The thermal guard passed 17 isolated checks; that is not evidence of a real local build. Automated results remain separate from Masih’s acceptance.
