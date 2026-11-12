# Branches kept, and why

State on 12 Nov 2026, after 12 local and 48 remote branches whose every commit was already in `main` were deleted (production spec, row N3). "Not in main" counts commits whose patch is not in `origin/main`, out of the commits ahead of it. A branch here holds work that is not in `main`; delete one only after its work is merged or given up.

| Branch | Where | Last commit | Not in main | Purpose |
| --- | --- | --- | --- | --- |
| `main` | local, origin | 12 Nov | 0 | default branch |
| `work/elpis-main-20261107` | local | 12 Nov | current | the work branch; `main` is fast-forwarded to it |
| `build/elpis-20261110` | origin | 12 Nov | current | the work branch's copy that CI runs on |
| `work/site-frame-20261112` | local, a worktree | 12 Nov | 1 of 1 | another session's site work (`.worktrees/elpis-site-frame`) |
| `work/codex-sessions-no-vpn-6fe4e86e544c` | local | 12 Nov | 0 of 1 | another session's branch; its one commit is in the work branch as `81310501c` |
| `check/elpis-installed-context-baseline` | local, origin | 7 Nov | 1 of 1 | CI test of the installed engine's instruction tests |
| `feature/matilda-agent-20261106` | local | 6 Nov | 1 of 1 | draft spec: Matilda proposes work and starts it after his "go" |
| `feature/readiness-20261106` | local, origin | 7 Nov | 1 of 1 | readiness spec draft, paused until he decides the rubric |
| `fix/love-picture-20261107` | local | 7 Nov | 5 of 5 | Love Spot picture fix and its tests |
| `build/love-spot-picture-20261107` | origin | 7 Nov | 5 of 5 | CI copy of `fix/love-picture-20261107` |
| `fix/side-panel-a217-20261105` | local | 5 Nov | 5 of 5 | side-panel restore fix (A217) |
| `old/love-spot-release-20261107-unclean` | local | 7 Nov | 3 of 17 | an old Love Spot release attempt, marked unclean |
| `salvage/docx-preview-20261108` | local | 10 Nov | 1 of 1 | rescued, unfinished DOCX preview and terminal wrap work |
| `size-report` | local, origin | 8 Nov | 6 of 6 | size and benchmark report tooling |
| `retained/provider-order-20261108` | origin | 8 Nov | 1 of 1 | a kept provider-order test |
| `work/split-client-20261106` | local, origin | 6 Nov | 2 of 10 | splitting and typing the desktop bridge client |
| `work/ts-app-20261107` | local | 7 Nov | 1 of 1 | moving app scripts and bridge tests to TypeScript |
| `work/ts-batch1-20261106` | local, origin | 6 Nov | 2 of 14 | first TypeScript batch |
| `build/split-page-*` (eight snapshots) | origin | 6 Nov | 1 to 29 each | CI snapshots of one page-split refactor; the newest is `build/split-page-96624de8c` |
