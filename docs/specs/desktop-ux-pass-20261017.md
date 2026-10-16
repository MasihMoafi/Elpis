# Desktop everyday UX pass — 17 October 2026

Goal: make the requested everyday Elpis desktop flows clear, dependable and comparable to ChatGPT Codex mode.
Contract: use the user's complete flow list and required checks; compare read-only reference UI/source, then exercise the worktree desktop with temporary homes, private Xvfb and local mock inference. Never operate the installed Elpis or real user profiles. Preserve concurrent edits; no staging, commits, uploads or paid calls.
Acceptance: each flow has an observed result or a stated limitation in `.tmp/ux-pass-20261017.md`; each repaired behavior has a failing-before/passing-after Playwright check, including failure or negative cases where applicable. Capture and inspect before/after screenshots in `/tmp/elpis-ux/`. TypeScript, UI, desktop and bridge suites must pass. User acceptance remains open.
Plan: record baseline → reproduce and prioritize findings → add regression checks → minimal fixes in shared owners → rebuild and repeat affected flows → run final checks and record limits. Rollback means undoing only this pass's exact edits, preserving earlier changes.
