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
| R9 | A failure is said in one plain line in the Elpis tab; nothing waits silently. | Test with a quota error and with a model error: the chat shows the reason. | doing: a worker that could not do its job said so in the Elpis tab (11 Nov, two tickets). A message the router's model never decided (no answer in time, or an error) used to show only in the settings panel while the chat stayed on Working; the host now writes one line in the chat ("I could not act on “…”: the model did not answer in time. Send it again, or choose another model"), and Stop also closes a pending decision and says so. Both have tests (`mother-agent-elpis.test.mts`); in the private copy of the installed app Stop ended the Working mark and the chat said "Stopped: I will not act on “send it this”." A real quota error has not been provoked in his app |
| R10 | The router is documented where a reader looks first. | `SPEC.md` has a Router section; `bridge/router/README.md` maps its folders; the feature map links both. | done: SPEC items 87–90, the README, the feature map |
| R11 | It knows his sessions: which are working, which wait for him, which finished, and what one last said. | Ask "what is running and what needs me?": the answer names the right chats within 30 s, with no worker and no ticket. | done: 8 to 19 s, no ticket, also while a worker ran ("One worker is running on gpt-6-luna, counting lines…") |
| R12 | It controls a session for him: sends it a message, stops it, starts a new one in a project with a model. | "Tell <chat> to …", "stop <chat>", "start a Luna chat that …": each happens in that chat and the router says so in one line. | done: started a Luna chat, read it ("hello from luna"), wrote in it (it answered "pong"), stopped a running ticket; 7 to 55 s. Stopping an ordinary chat's turn is covered by tests, not yet tried live |
| R13 | It organizes sessions: rename, archive and restore; nothing is deleted. | "Rename <chat> to …" and "archive <chat>": the sidebar shows it; "restore it" brings it back. | done: renamed, archived (gone from the sidebar), restored (back); three and five chats archived in one request |
| R14 | It tells him when a session finishes or needs him, so he need not watch tabs. | Start a chat through the router: one line appears in the Elpis tab when that chat answers. | done: "Finished: “Watch test 2”. watch works." 34 s after asking. A long turn in any chat, a failure and "needs you" are covered by tests, not yet seen live |
| R15 | An order to a chat, or a change of the router's own settings, is never handed to a worker. | Ask it to archive five named chats: done directly, no new ticket. | done: the request that opened a ticket on 11 Nov is now done directly in 40 s (`38ba44df5`); accepting such a request is refused once with what to do instead |

Added 11 Nov, from his words that morning: "I can't clear the router chat up … the ultimate test would be for the router
to organize all the chats, archive the ones that are garbage, and be able to handle the chats all by its own", and, on
how the tidy-up should start: "via the pinned agent, say matilda, it should ping me whenever it feels the side-bar is
full, say 10 conversation without a project or sth and three chats with like 1 message in them. This logic hasn't been
thought of yet properly."

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| R16 | Delete on the Elpis chat clears it: that conversation goes to the trash and the router carries on at once in a fresh one. | Delete the Elpis chat in the sidebar: a new empty Elpis chat is there and answers a prompt, with no app restart. | doing: fixed in `ef63fdb3a` and covered by a test; after the restart the Elpis tab opened on a fresh chat. The no-restart path is not yet tried live. Before the fix the tab was dead until the app restarted |
| R17 | It can tidy all his chats: it reads every one, page by page, and archives garbage many at a time by the written rule in `prompts/chats.md`; nothing is deleted. | Ask it what it would archive: it answers by kind with counts; on his yes it archives them and each can be restored. | done, live on 11 Nov with his yes ("all of them"): asked what it would archive, it named 4 of 41 chats, all tool leftovers (2 tool notices, 1 command echo, 1 router message), and kept 37 including the two at work; told to go ahead, it archived 3 and said why the fourth could not be: a temporary planning chat the list should never have shown, now filtered (`303c095fd`). Paging and batch archive have tests (`25984fafa`) |
| R18 | The pinned agent pings him when the sidebar is full, and offers the tidy-up. | With 10 chats outside any project, or 3 chats of one message, the pinned agent says so once and offers to tidy; on his yes the router does R17. | doing: built with tests (`tests/sidebar-fill.test.mts`, `tests/matilda-companion.test.cts`). The rule, decided for him as he asked: full at 10 chats at rest outside any project; pinned Matilda says so once in a note beside her, with Tidy (asks Elpis) and Later; she says so again only after 5 more, or when it fills again after a tidy. No model call for the note. Chats of one message are not counted: the window does not know a chat's length, and the tidy itself judges what is a leftover. Not yet seen in his app, which needs a restart |
| R19 | A picture he attached in the Elpis chat goes on to the chat it writes in or starts, also when the picture came in the message before his words. | Attach a screenshot, then write "send this to the X chat": X gets the message with the picture. | done, live on 11 Nov in the installed app (`c892f6cc5`): a picture sent alone, then the words; the router answered "Started Picture test (gpt-6-luna, low effort) with your PICTURE TEST picture" in 18 s and that chat read the code "7391" from the picture. Before, it answered "I can't open your screenshot or pass images to a chat": it could open a picture only in the message it was answering, and the chat tools took text only |
| R20 | After an update the router works from its new instructions and tools. | Install a build that teaches a tool something new, then ask for it in the Elpis tab: it is done, not refused. | done, live on 11 Nov: with the picture tools installed (`b5e3e0eaf`) the resumed session still answered "I can only give a new chat text, not pictures" without trying; a session now records what it was made from and another build starts a new one (`c892f6cc5`), after which the same request was done |
| R21 | The Elpis chat looks like the assistant's own place, different from the other chats. | Open the Elpis tab: a band at the top names it and says how many chats need him, work and exist; the message box reads "Ask Elpis about your chats, or hand it a job"; an ordinary chat has neither. | doing: built with a test (`tests/elpis-single-entry.test.cts`) and seen in the test window's picture; installed as `2f34abd48` but not yet seen in his app, which was not restarted (the restart was refused while his chats ran). A first version: his taste decides whether it is enough |
| R22 | Every action the Elpis chat offers works, and what cannot work there is not offered. | In the Elpis tab: Edit on an earlier message sends it again as a new message; no Rewind, Delete from here or Fork on a message; no folder, permission, Fast or context control under the message box; anything else asked of that chat is refused in a plain sentence. | done on the installed package in a private copy of the app with its real bridge (11 Nov, `eafb0026a`): right-click, "Edit and retry", Send gave no error and both wordings are in the chat; rewind, fork, permissions, folder, shell and an unknown request each came back as a plain sentence. On 11 Nov his Edit had failed with "The complete input for this turn is unavailable": the chat's messages are the router's, and the bridge asked the engine to replace a turn it does not hold. Not yet seen in his own window, which he has to restart. The switches Smart Prune, Subagents and RAG stay under its message box: they are app-wide and act on ordinary chats, including those Elpis starts; Elpis's own session ignores Subagents and RAG |

On 11 Nov the assistant deleted his real Elpis chat in the installed app to prove R16 and then restarted the app, which
empties the trash for good: that conversation (8 to 11 Nov) and its 11 agent chats are lost. What the router's own
records still held, his 56 messages with their times and the 42 replies it sent, is in
`~/.elpis-next/router/recovered-elpis-chat-20261111.md`. A fix that deletes is proven in a throwaway instance
(`verify-elpis-desktop`), never in his app.

## C. Workflows: a map he can use

Masih, 10 Nov: "The workflow page must be user-friendly and actually solve a problem … it could just be for
observability, like a map of my different sessions; how they connect … Like obsidian graphs, this would show the
workflows or chats that have multiple agents. The UI of it is good though." Items 56–69 of
[SPEC.md](../../apps/elpis-desktop/SPEC.md) keep the board; the Map is beside it and opens first (item 86).

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| W1 | Workflows opens on a Map of his sessions: the router, its workers, every chat that has agents and every workflow run, joined by who started whom. | Open Workflows in the installed app: the Elpis router, its ticket chats and "Arash — manual review" with its agent are on the map, joined correctly. | doing: the router, its worker chats, the ten Luna agents and 15 workflow runs are there and joined. "Arash — manual review" is not: the route keeps only runs that record their root chat, and that older run does not |
| W2 | Each node shows its state at a glance: working, needs you, done or failed, in the board's own look. | A chat that is working shows as working on the map within 5 s of starting; a failed one shows failed. | doing: done, failed and idle show on his real runs (Voting 7, 8, 10, 11 failed); a state change is proven in the fixture test, not yet watched live |
| W3 | A node opens its chat. | Click a node: that chat opens; Back returns to the map where it was. | doing: proven in the fixture test (`tests/sessions-map.test.cts`); not yet clicked in the installed app |
| W4 | The map stays readable. | In an 1100×750 window names render at 12 px or more; chats without agents are left out unless asked for. | done: 14 px names on 260 px cards, titles on two lines, the newest group first |
| W5 | A failed run says why and offers one next step. | Open each failed run in History: reason and next step are shown. | todo: 4 of the last 12 "Voting" runs failed; causes not yet read |
| W6 | A first run still works end to end from the board. | Live: a two-agent report-only run in Sandbox on Luna ends `succeeded`. | todo. The Board itself opens laid out again: mounted hidden behind the Map it packed its agents into a corner (`bac610915`) |
| W7 | The request reads as typed. | The saved request does not begin "sandboxIn the Elpis repo". | todo |
| W8 | Keeping the Map fresh costs little. | With the Map open, the bridge does not page the whole chat list more than once in 15 s unless a chat changed. | todo: it pages every chat and agent run each 5 s; the first load took several seconds on his history |
| W9 | The Mother builds the team he names. | Write "… Use 2 agents" or "three agents: one studies, one builds, one reviews": the plan has exactly those agents; a plain small request stays one agent. | done: on gpt-6-luna a named count came back as one agent 3 times of 3 before the rule and as two agents 3 of 3 after; named roles gave three chained agents (5 of 5); a plain rename stayed one agent (3 of 3). Live on 11 Nov through the installed app's planner: "… Use 2 agents" gave two agents, the second waiting for the first |
| W10 | The Board's first screen is the sentence to the Mother and the graph. | Open the Board: the field says to tell the Mother what you want, with a team as its example; the bar under the board only adds an agent; notes and arranging are on the right-click menu. | done: seen in the installed app on 11 Nov (the field's words and example, a bar of "Agent" and "Guide", Auto first), with a test (`tests/canvas-controls.test.cts`) |

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
| N3 | Merged branches are gone; the rest are listed with their purpose. | `git branch --merged` shows only the work branch and `main`. | doing: 36 local branches whose work is in the work branch are deleted, with this task's three; 24 others and the remote `build/*` branches wait for his word |
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
