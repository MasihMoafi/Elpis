# SPEC: Elpis ready for production

Goal: Elpis can be shipped and trusted as a daily driver: every check is green, the router and Workflows do what they
promise in the installed app, the shared design and behaviour system is enforced by checks instead of by memory, and
the repository reads in order. Masih, 10 Nov: "Finalize this project for production, make that shared-system stick,
make sure the workflows + router work as intended." The finish line, in his words: "when I won't need to work on it
anymore and could use it with the flow": he talks to the router, and it runs and reports his sessions.

Invariants: no chat, ticket, board or setting of his is lost; `main`, tags, releases and deploys change only with his
yes; no traffic through his VPN without his yes (live tests start the app with every proxy off).
Constraints: Rust builds on GitHub Actions; one heavy job at a time.

Status words: `todo`, `doing`, `done: <evidence>`, `his call` (waits for Masih). "Installed app" below means
`~/.local/bin/elpis-app`, driven through its window on 10 and 11 Nov with every proxy off.

## A. Gates

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| P1 | Every CI workflow passes on the release commit. | `gh run list --commit <sha>`: Lint, Security Check, Elpis desktop and Rust clippy all `success`. | doing: Lint, Security Check and Elpis desktop passed on `e4fec76b4` (first green Lint since at least 10 Nov). Clippy failed on one lint that has failed on `main` since 9 Nov; fixed in `f1560d0b7`, rerun pending. OpenSSL 0.10.80 compiled there |
| P2 | Each CI check has one owner. | `rg -l 'cargo audit' .github/workflows` names one file. | done: `security-check.yml` only (push, pull request, weekly) |
| P3 | The installed app is the release commit, installed by `install-desktop.mts`. | `readlink ~/.local/bin/elpis-app` ends in the release commit. | done: `local-fixes-38ba44df5`; later commits change no app file |

## B. Router: the one assistant he talks to

Masih, 10 Nov: "the main thing for the router to be the main and preferably only model I talk to, I like it to control
my sessions, organize them, be my main assistant that I talk to instead of me having to control 10 different tabs at
once." R1–R5 are in [router-chats.md](../../apps/elpis-desktop/specs/router-chats.md). Tests used GPT-6.1-Sol as the
router and Luna as its workers (his words, 10 Nov); his own worker setting (Sol, xhigh) is back.

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| R6 | Every message sent in the Elpis tab is answered or acknowledged there; none is left without a reply. | In the installed app send three messages, one while a ticket is open: each gets its reply in that chat. | done after three fixes: of 25 messages sent, three met a gap (a result said in the hidden session, a stop done in silence, an order to a chat handed to a worker). Each is fixed and its repeat was answered. His 5:24 and 5:25 PM messages of 10 Nov stay unanswered: the bug fixed in `2fea02671` sent them to a worker |
| R7 | A delegated task opens exactly one worker chat named by its ticket; its result returns to the Elpis tab; the ticket ends. | Live: one small report-only task. Recents lists the ticket once. | done: "count the words in LICENSE" answered "1,581 words" in 19 s, once, ticket ended. Before `be22da88f` the router said the result in its hidden session and it never arrived. One older duplicate "Test 10 simultaneous Luna agents…" stays in Recents: it is the first run's chat, with its ten agents |
| R8 | The router survives an app restart. | Restart the app, send a prompt: answered, no "unsupported approval". | done: seven restarts on 10 and 11 Nov, the first prompt after each answered or acknowledged |
| R9 | A failure is said in one plain line in the Elpis tab; nothing waits silently. | Test with a quota error and with a model error: the chat shows the reason. | doing: a worker that could not do its job said so in the Elpis tab (11 Nov, two tickets). A quota or model error is not yet tried |
| R10 | The router is documented where a reader looks first. | `SPEC.md` has a Router section; `bridge/router/README.md` maps its folders; the feature map links both. | done: SPEC items 87–90, the README, the feature map |
| R11 | It knows his sessions: which are working, which wait for him, which finished, and what one last said. | Ask "what is running and what needs me?": the answer names the right chats within 30 s, with no worker and no ticket. | done: 8 to 19 s, no ticket, also while a worker ran ("One worker is running on gpt-6-luna, counting lines…") |
| R12 | It controls a session for him: sends it a message, stops it, starts a new one in a project with a model. | "Tell <chat> to …", "stop <chat>", "start a Luna chat that …": each happens in that chat and the router says so in one line. | done: started a Luna chat, read it ("hello from luna"), wrote in it (it answered "pong"), stopped a running ticket; 7 to 55 s. Stopping an ordinary chat's turn is covered by tests, not yet tried live |
| R13 | It organizes sessions: rename, archive and restore; nothing is deleted. | "Rename <chat> to …" and "archive <chat>": the sidebar shows it; "restore it" brings it back. | done: renamed, archived (gone from the sidebar), restored (back); three and five chats archived in one request |
| R14 | It tells him when a session finishes or needs him, so he need not watch tabs. | Start a chat through the router: one line appears in the Elpis tab when that chat answers. | done: "Finished: “Watch test 2”. watch works." 34 s after asking. A long turn in any chat, a failure and "needs you" are covered by tests, not yet seen live |
| R15 | An order to a chat, or a change of the router's own settings, is never handed to a worker. | Ask it to archive five named chats: done directly, no new ticket. | done: the request that opened a ticket on 11 Nov is now done directly in 40 s (`38ba44df5`); accepting such a request is refused once with what to do instead |

## C. Workflows: a map he can use

Masih, 10 Nov: "The workflow page must be user-friendly and actually solve a problem … it could just be for
observability, like a map of my different sessions; how they connect … Like obsidian graphs, this would show the
workflows or chats that have multiple agents. The UI of it is good though." Items 56–69 of
[SPEC.md](../../apps/elpis-desktop/SPEC.md) keep the board; the Map is beside it and opens first (item 86).

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| W1 | Workflows opens on a Map of his sessions: the router, its workers, every chat that has agents and every workflow run, joined by who started whom. | Open Workflows in the installed app: the Elpis router, its ticket chats and "Arash — manual review" with its agent are on the map, joined correctly. | doing: the router, its five worker chats, the ten Luna agents and 15 workflow runs are there and joined. "Arash — manual review" is not: find why |
| W2 | Each node shows its state at a glance: working, needs you, done or failed, in the board's own look. | A chat that is working shows as working on the map within 5 s of starting; a failed one shows failed. | doing: done, failed and idle show on his real runs (Voting 7, 8, 10, 11 failed); a state change is proven in the fixture test, not yet watched live |
| W3 | A node opens its chat. | Click a node: that chat opens; Back returns to the map where it was. | doing: proven in the fixture test (`tests/sessions-map.test.cts`); not yet clicked in the installed app |
| W4 | The map stays readable. | In an 1100×750 window names render at 12 px or more; chats without agents are left out unless asked for. | done: 14 px names on 260 px cards, titles on two lines, the newest group first |
| W5 | A failed run says why and offers one next step. | Open each failed run in History: reason and next step are shown. | todo: 4 of the last 12 "Voting" runs failed; causes not yet read |
| W6 | A first run still works end to end from the board. | Live: a two-agent report-only run in Sandbox on Luna ends `succeeded`. | todo. The Board itself opens laid out again: mounted hidden behind the Map it packed its agents into a corner (`bac610915`) |
| W7 | The request reads as typed. | The saved request does not begin "sandboxIn the Elpis repo". | todo |

## D. The shared system sticks

Rules: `~/Desktop/p/skills/shared-system/SKILL.md`.

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| S1 | The UI check runs on CI for every push and fails on a new finding. | A push that adds a raw hex colour to a component fails CI. | done: Lint job "desktop shared UI rules" passed on `e4fec76b4`; a probe file with `#abcdef` made `node scripts/ui-lint.mts` exit 1 |
| S2 | Known UI exceptions only shrink, to none or to ones with a stated reason. | `ui-check.known.json` has no entry without a reason. | doing: static findings 98 → 81. Raw colours are tokens with the same values, except the board's own file. Left: hand-written controls (32 files), `<details>` (22), uneven buttons and icon strokes (6) |
| S3 | Long lines cannot come back. | CI fails on a new line over 180 characters; a file may only go down. | done: fifth check of `strict-baseline.mts`, 2,697 lines recorded, new files must be clean |
| S4 | Same kind of page, same frame. | Settings, Customize, Workflows, Observability and Lab titles share one left edge and baseline at 1100, 1400 and 1920 px. | todo: measure |
| S5 | Undo works where the baseline says. | Shared shortcut copy is current; type and undo; rename, move and delete a chat, undo and redo each. | doing: copy is current (`sync.mjs`, 10 Nov); the app actions are not yet tried |
| S6 | The shared source reaches CI through a documented path. | A stale copy fails `node scripts/ui-lint-sync.mts --check`; `DESIGN.md` says how to update it. | done: generated copy with its hash, checked after every local build; the skills folder itself is private, so CI cannot fetch it |

## E. A repository that reads in order

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| N1 | `ES.md` tells the truth. | Its branch, installed version and CI state match `git`, the launcher and `gh`. | done: rewritten 11 Nov |
| N2 | Every top-level item is in the folder map or gone. | `lat.md/workspace.md` lists each. | done: local-only items listed under their own heading |
| N3 | Merged branches are gone; the rest are listed with their purpose. | `git branch --merged` shows only the work branch and `main`. | doing: this task's three branches removed; older ones wait for his word |
| N4 | Pointers resolve. | No doc names `install-desktop.mjs` or the old `Elpis-wt-install` path. | done |
| N5 | Scratch is cleared. | `.agents/briefs/`, `test-results/` and `.tmp/` hold nothing older than the current task. | doing: cleared, except `.tmp/final-candidate` (1.1 GB, Oct): its sandbox folders belong to another user id and need root |

## F. Release (each step needs his yes)

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| X1 | The work branch is merged into `main`. | `git rev-list main..work` is empty; CI green on `main`. | his call |
| X2 | A tagged release with packages. | The GitHub release lists the packages; a fresh install starts and answers a prompt. | his call |

Non-goals: new features (the Orca list, Agent readiness, Matilda as manager); any use of the VPN.
Stop and ask: a change that deletes or re-parents saved chats; a push to `main`, a tag, a release or a deploy; a model
that answers only through the VPN.
