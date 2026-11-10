# SPEC: Elpis ready for production

Goal: Elpis can be shipped and trusted as a daily driver: every check is green, the router and Workflows do what they
promise in the installed app, the shared design and behaviour system is enforced by checks instead of by memory, and
the repository reads in order. Masih, 10 Nov: "Finalize this project for production, make that shared-system stick,
make sure the workflows + router work as intended."

Invariants: no chat, ticket, board or setting of his is lost; `main`, tags, releases and deploys change only with his
yes; no traffic through his VPN without his yes (live tests start the app with every proxy off).
Constraints: Rust builds on GitHub Actions; one heavy job at a time; his ChatGPT quota (18% left on 10 Nov).

Status words: `todo`, `doing`, `done: <evidence>`, `his call` (waits for Masih).

## A. Gates

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| P1 | Every CI workflow passes on the release commit. | `gh run list --commit <sha>`: Lint, Elpis desktop and clippy all `success`. | todo: Lint fails on `cargo audit` (openssl 0.10.75, 8 advisories; libsqlite3-sys 0.37.0, 1) |
| P2 | Each CI check has one owner. | `rg -l 'cargo audit' .github/workflows` names one file. | todo: in `lint.yml` and `security-check.yml` |
| P3 | The installed app is the release commit, installed by `install-desktop.mts`. | `readlink ~/.local/bin/elpis-app` ends in the release commit. | done: `local-fixes-536363401` = HEAD (10 Nov) |

## B. Router: the one assistant he talks to

Masih, 10 Nov: "the main thing for the router to be the main and preferably only model I talk to, I like it to control
my sessions, organize them, be my main assistant that I talk to instead of me having to control 10 different tabs at
once." R1–R5 are in [router-chats.md](../../apps/elpis-desktop/specs/router-chats.md). Tests use GPT-6.1-Sol as the
router and Luna as its workers (his words, 10 Nov).

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| R6 | Every message sent in the Elpis tab is answered or acknowledged there; none is left without a reply. | In the installed app send three messages, one while a ticket is open: each gets its reply in that chat. | doing: a direct question was acknowledged and answered (10 Nov 22:55, proxy off). His 5:24 and 5:25 PM messages stay unanswered (the bug fixed in `2fea02671` sent them to a worker) |
| R7 | A delegated task opens exactly one worker chat named by its ticket; its result returns to the Elpis tab; the ticket ends. | Live: one small report-only task. Recents lists the ticket once. | todo: "Test 10 simultaneous Luna agents…" is listed twice in Recents |
| R8 | The router survives an app restart. | Restart the app, send a prompt: answered, no "unsupported approval". | done: first prompt after a cold start answered (10 Nov 22:55) |
| R9 | A failure is said in one plain line in the Elpis tab; nothing waits silently. | Test with a quota error and with a model error: the chat shows the reason. | todo |
| R10 | The router is documented where a reader looks first. | `SPEC.md` has a Router section; `bridge/router/README.md` maps its folders; the feature map links both. | todo |
| R11 | It knows his sessions: which are working, which wait for him, which finished, and what one last said. | Ask "what is running and what needs me?": the answer names the right chats within 30 s, with no worker and no ticket. | todo: on 10 Nov the same kind of question took 2 min, a ticket and a worker that read the state database by hand |
| R12 | It controls a session for him: sends it a message, stops it, starts a new one in a project with a model. | "Tell <chat> to …", "stop <chat>", "start a Luna chat in <project> that …": each happens in that chat and the router says so in one line. | todo |
| R13 | It organizes sessions: rename, archive and restore; nothing is deleted. | "Rename <chat> to …" and "archive <chat>": the sidebar shows it; "restore it" brings it back. | todo |
| R14 | It tells him when a session finishes or needs him, so he need not watch tabs. | Start a chat, switch to the Elpis tab: one line appears there when that chat ends or asks for approval. | todo: design after R11–R13 |

## C. Workflows: a map he can use

Masih, 10 Nov: "The workflow page must be user-friendly and actually solve a problem … it could just be for
observability, like a map of my different sessions; how they connect … Like obsidian graphs, this would show the
workflows or chats that have multiple agents. The UI of it is good though." Items 56–69 of
[SPEC.md](../../apps/elpis-desktop/SPEC.md) keep the board; the Map is added beside it and opens first.

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| W1 | Workflows opens on a Map of his sessions: the router, its workers, every chat that has agents and every workflow run, joined by who started whom. | Open Workflows in the installed app: the Elpis router, its ticket chats and "Arash — manual review" with its agent are on the map, joined correctly. | todo |
| W2 | Each node shows its state at a glance: working, needs you, done or failed, in the board's own look. | A chat that is working shows as working on the map within 5 s of starting; a failed one shows failed. | todo |
| W3 | A node opens its chat. | Click a node: that chat opens; Back returns to the map where it was. | todo |
| W4 | The map stays readable. | In an 1100×750 window names render at 12 px or more; chats without agents are left out unless asked for. | todo: the board shows names under 6 px (14 px at 0.41 zoom) |
| W5 | A failed run says why and offers one next step. | Open each failed run in History: reason and next step are shown. | todo: 4 of the last 12 "Voting" runs failed; causes not yet read |
| W6 | A first run still works end to end from the board. | Live: a two-agent report-only run in Sandbox on Luna ends `succeeded`. | todo |
| W7 | The request reads as typed. | The saved request does not begin "sandboxIn the Elpis repo". | todo |

## D. The shared system sticks

Rules: `~/Desktop/p/skills/shared-system/SKILL.md`.

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| S1 | The UI check runs on CI for every push and fails on a new finding. | A push that adds a raw hex colour to a component fails CI. | todo: runs only on his machine, after a local build |
| S2 | Known UI exceptions only shrink, to none or to ones with a stated reason. | `ui-check.known.json` has no entry without a reason. | todo: 71 kinds (raw colours 13 files, hand-written controls 31, `<details>` 23, uneven buttons and icon strokes 6) |
| S3 | A formatter decides line breaks, not hand-cramming to stay under a line count. | CI fails on an unformatted file; no source line over 160 characters outside data. | todo: 131 files hold five or more lines over 220 characters |
| S4 | Same kind of page, same frame. | Settings, Customize, Workflows, Observability and Lab titles share one left edge and baseline at 1100, 1400 and 1920 px. | todo: measure |
| S5 | Undo works where the baseline says. | Shared shortcut copy is current; type and undo; rename, move and delete a chat, undo and redo each. | doing: copy is current (`sync.mjs`, 10 Nov) |
| S6 | The shared source reaches CI through a documented path. | The workflow pins the skills repo at a commit; `DESIGN.md` says how to move the pin. | todo |

## E. A repository that reads in order

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| N1 | `ES.md` tells the truth. | Its branch, installed version and CI state match `git`, the launcher and `gh`. | todo: dated 8 Nov, names a branch that is no longer checked out |
| N2 | Every top-level item is in the folder map or gone. | `lat.md/workspace.md` lists each; `alint check` passes. | todo: 12 unlisted items |
| N3 | Merged branches are gone; the rest are listed with their purpose. | `git branch --merged` shows only the work branch and `main`. | todo: 61 local branches |
| N4 | Pointers resolve. | `check_pointers.py` passes; no doc names `install-desktop.mjs`. | todo |
| N5 | Scratch is cleared. | `.agents/briefs/`, `test-results/` and `.tmp/` hold nothing older than the current task. | todo: 1.1 GB in `.tmp/` |

## F. Release (each step needs his yes)

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| X1 | The work branch is merged into `main`. | `git rev-list main..work` is empty; CI green on `main`. | his call |
| X2 | A tagged release with packages. | The GitHub release lists the packages; a fresh install starts and answers a prompt. | his call |

Non-goals: new features (the Orca list, Agent readiness, Matilda as manager); engine changes beyond the security
updates; any use of the VPN.
Stop and ask: a change that deletes or re-parents saved chats; a push to `main`, a tag, a release or a deploy; a live
run likely to take more than 3% of his ChatGPT quota; a model that answers only through the VPN.
