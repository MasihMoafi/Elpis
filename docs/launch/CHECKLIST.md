# Elpis launch checklist (checked 1 Nov 2026)

`M` = needs Masih (publishing, pushing, accounts, a choice). Evidence is a file, commit or `gh` result anyone can reopen.

| # | Step | State | Evidence | M |
| --- | --- | --- | --- | --- |
| 1 | Known failing test fixed | Not done | `tools/elpis-claude/test/bridge-idle.test.mjs:200` (OUTSTANDING-TECH #13); ES.md lists 6 more failing desktop tests | |
| 2 | Terminal CI green on the launch commit | Not done | Last run failed: `fix/tui-20261101` e83d4af2d, 31 Oct 18:01 | |
| 3 | Desktop CI green | Not done | `elpis-desktop.yml`: last 3 runs failed (27–29 Oct) | |
| 4 | Security Check green on `main` | Not done | Failed 15, 19 and 26 Oct | |
| 5 | Integration branch on `main` | Not done | `integrate/repairs-20261031` is 1,982 commits ahead of `origin/main` | M |
| 6 | Terminal release tagged and published | Not done | Latest is v0.4.1 (4 Oct); 256 engine commits since. Then change the README install line from v0.4.1 to the new tag | M |
| 7 | Desktop package for Linux (AppImage or .deb) | Not done | No packager in `apps/elpis-desktop/package.json`; CI uploads build artifacts only | |
| 8 | Desktop package on the Releases page | Not done | README already says it is there | M |
| 9 | macOS and Windows | Not planned | Neither app builds for them; README says so | M |
| 10 | Real multi-agent run on two providers | Done | Voting team on GPT-6 Luna and Claude Haiku 5.5, 74–100 s: `~/.cache/elpis-tests/canvas-live{,-luna}/` ("Run took 100 s", tally received 6 results) | |
| 11 | That run repeatable on CI | Not done | `tests/canvas-live.runtime.mjs` runs by hand only | |
| 12 | README claims match code | Done | Kahn waves `lib/canvas.ts:171`; ownership `bridge/workflow-worktrees.mjs` `complete()`; checks `lib/canvas.ts` `runTasks`; Mother agent review `bridge/workflow-acp.mjs:293-302` | |
| 13 | README images, both themes | Partial | Workflows dark: `docs/launch/img/workflows-voting-dark.png`. Placeholders `docs/launch/img/todo-*.svg`: Workflows light (the captured light shot shows an empty board), chat dark, Love Spot dark and light | |
| 14 | Website technical page | Partial | Hand-edited ownership section; page is generated from `readme.md` and was already stale (site test `technical page was generated…` fails). Regenerating replaces the long technical page with the new README | M |
| 15 | Website front page shows the desktop app | Not done | `website/index.html` shows only the terminal app | |
| 16 | Website deployed | Not done | | M |
| 17 | Films: Workflows run, Logo, Love Spot | Not done | Drafts in `~/Work/tries/2026-10-27-elpis-video/`; the single filming run is still open (ES.md) | M |
| 18 | Launch posts written (X, Show HN, Reddit, YouTube) | Not done | Plan: `docs/launch/GTM.md` | M |
| 19 | Accounts: GitHub description and topics, X, HN, Reddit, YouTube | Not done | | M |

## Risks a first user will meet

- The desktop app idles at about 6.4 GB (each loaded chat starts its own MCP servers).
- "Thread already has an active writer" may still appear (ES.md).
- Two side-by-side agents without an "alongside" link may claim one folder; outside a Git project folders are not enforced.

## Masih decides

- Ship the desktop app now as Linux-only, or wait for a package format he chooses (AppImage, .deb, both).
- Lab and Observation: in the README core features or out (REQUIREMENTS VERIFY).
- Whether films may speed up real runs ("doesn't have to reflect reality" vs "make this look like reality").
- Regenerate the technical page from the new README, or keep the long page and move its source into `docs/`.
