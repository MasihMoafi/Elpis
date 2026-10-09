# Permission verification — 9 October 2026

The final Rust source and tests compile in CI 37938751599. **Not installed:** full build 37939342716 is checking the Ledger, queued-input and `/yolo` fixes.

| Actual runtime check | Result | Evidence |
| --- | --- | --- |
| Installed Elpis, Full Access from the terminal | Reproduced an unwanted rejection: “approval policy is Never” | `/tmp/elpis-terminal-input-dfXoDi` |
| Candidate, native permission changes | 11 passed | `/tmp/elpis-live-permissions-W8iHA0` |
| Candidate, Code Mode including cells retained across turns | 15 passed | `/tmp/elpis-live-permissions-zR1all` |
| Candidate, Claude bridge including cold Full Access resume | 35 passed | `/tmp/elpis-bridge-permissions-mRYjqe` |
| Candidate, Gemini bridge including cold Full Access resume | 28 passed | `/tmp/elpis-bridge-permissions-xshsVS` |
| Helper start, revocation and TUI resume | 32 passed, independently rerun | `/tmp/elpis-bridge-delegation-lXMB11` |
| `/yolo` in the actual terminal | Applies Full Access, permits the write and saves the default | `/tmp/elpis-terminal-input-HqgfR2` |
| Core permission and continuity unit tests | 301 passed again in CI 37936240250 | Build job 113838904301 |
| Live Claude Sonnet High | Reply and protected-folder write, zero approvals | `/tmp/elpis-live-claude-v9h_9jmg` |
| Live Gemini 3.8 Flash High | Correct project write; shell/read/edit/write, zero approvals | `/tmp/elpis-live-gemini-context-4mc9jy7e`, `/tmp/elpis-live-gemini-tools-aoajobup` |

Candidate runtime: CI source `8451f9ca2fb016012a962b987fd04f9cb29a75b6`, matching local `4d3d1fcd3`; SHA-256 `f449a04786bfeb9b1fdc992729b64ae6d2e2d85256a30a61edabc525b3e0f340`. Bridge runs above include the final helper fix `dc89275a8`; the coordinator independently reran the helper suite. The first provider suites use deterministic fixtures; the final two rows use real accounts. Live Gemini revealed that its helper workspace could win over the chat directory. Explicit project context now accompanies every prompt; eight adapter regressions and both live file checks pass. Test Elpis homes are private, but provider sessions use normal account storage; a failed project-selection experiment also created a temporary Antigravity project record.

Coverage includes promotion, revocation, rejected updates, delayed approvals, unconfirmed settings, simultaneous chats, unknown ACP sessions, duplicate turns, and persisted choices after restart. The new runtime fixes the older engine’s cold Full Access resume and cross-turn Code Mode failures. Helper checks cover delayed starts across revoke/regrant, reopened helpers, rejected restrictions and a failed persistence write. A save failure warns that reduced helper permissions survive only until restart; custom workspace roots are not intersected by the bridge.

Run on the final installed binary: `scripts/permissions-runtime.test.cjs` (native and `--code-mode`), `scripts/permissions-bridge.test.cjs` (Claude and `--gemini`), `scripts/permissions-bridge-delegation.test.cjs`, and `scripts/terminal-input.test.cjs` (native and `--bridge`). The original 32-row terminal test must pass; the diagnostic runtime currently hides the completed reply behind the Ledger at that size.

Hosted CI performs Rust builds because local free space is below the 40 GB floor. The thermal guard passed 17 isolated checks; that is not evidence of a real local build. Automated results remain separate from Masih’s acceptance.
