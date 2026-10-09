# Permission verification — 9 October 2026

The Codex 0.162 recovery runtime builds and runs. **Not installed:** the inline Ledger layout fix still needs a rebuilt candidate, and the corrected UI checks still need the final full run.

| Actual runtime check | Result | Evidence |
| --- | --- | --- |
| Installed Elpis, Full Access from the terminal | Reproduced an unwanted rejection: “approval policy is Never” | `/tmp/elpis-terminal-input-dfXoDi` |
| Candidate, native permission changes | 11 passed | `/tmp/elpis-live-permissions-W8iHA0` |
| Candidate, Code Mode including cells retained across turns | 15 passed | `/tmp/elpis-live-permissions-zR1all` |
| Candidate, Claude bridge including cold Full Access resume | 35 passed | `/tmp/elpis-bridge-permissions-mRYjqe` |
| Candidate, Gemini bridge including cold Full Access resume | 28 passed | `/tmp/elpis-bridge-permissions-wiPM25` |
| Helper start, revocation and TUI resume | 32 passed, independently rerun | `/tmp/elpis-bridge-delegation-lXMB11` |
| `/yolo` in the actual terminal | Applies Full Access, permits the write and saves the default | `/tmp/elpis-terminal-input-HqgfR2` |
| Core permission and continuity unit tests | 301 passed in CI 37925769646 | Build job 113804212137 |

Candidate runtime: CI source `8451f9ca2fb016012a962b987fd04f9cb29a75b6`, matching local `4d3d1fcd3`; SHA-256 `f449a04786bfeb9b1fdc992729b64ae6d2e2d85256a30a61edabc525b3e0f340`. Bridge runs above include the final helper fix `dc89275a8`; the coordinator independently reran the helper suite. Providers are deterministic local fixtures, not live Claude/Gemini accounts.

Coverage includes promotion, revocation, rejected updates, delayed approvals, unconfirmed settings, simultaneous chats, unknown ACP sessions, duplicate turns, and persisted choices after restart. The new runtime fixes the older engine’s cold Full Access resume and cross-turn Code Mode failures. Helper checks cover delayed starts across revoke/regrant, reopened helpers, rejected restrictions and a failed persistence write. A save failure warns that reduced helper permissions survive only until restart; custom workspace roots are not intersected by the bridge.

Run on the final installed binary: `scripts/permissions-runtime.test.cjs` (native and `--code-mode`), `scripts/permissions-bridge.test.cjs` (Claude and `--gemini`), `scripts/permissions-bridge-delegation.test.cjs`, and `scripts/terminal-input.test.cjs` (native and `--bridge`). The original 32-row terminal test must pass; the diagnostic runtime currently hides the completed reply behind the Ledger at that size.

Hosted CI performs Rust builds because local free space is below the 40 GB floor. The thermal guard passed 17 isolated checks; that is not evidence of a real local build. Automated results remain separate from Masih’s acceptance.
