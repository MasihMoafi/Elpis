# Does Elpis hold up, and what is it for (11 Nov 2026)

Asked by Masih, 11 Nov: "Do a local code review and functionality review to see if the code actually holds up and ask
the important questions of what makes Elpis exceptional? Or whether each of the other features needed?"

Evidence here is from two days of using the installed app as he does, his own data in `~/.elpis-next`, and the
checks on GitHub. Where there is no evidence, it says so.

## 1. Does the code hold up

**The mechanical checks are strong.** Strict types, lint and duplication sit at zero; long lines and the shared UI
rules are now ratcheted on GitHub; 900 router tests and 190 UI test files run on every push.

**The seams are weak.** In two days of real use the router showed ten faults that no test caught, every one at a
join between the router, the bridge and the window:

| Fault he would have met | Where it sat |
| --- | --- |
| A worker's result never reached the Elpis chat (two different paths) | router session to chat |
| A stop was done in silence | route tool to chat |
| An order to a chat was handed to a worker that could not do it | model decision |
| Deleting the Elpis chat killed the tab until restart | trash to router |
| A second "Elpis" row showed the router's raw messages | live updates to sidebar |
| The Board packed its agents into a corner behind the Map | hidden mount |
| A new storage key would have been refused in the real app | window to desktop store |
| No Working mark while the router worked | router to chat |
| The map re-read every chat each 5 s | window to bridge |
| Every worker ran on the largest model | router to worker |

All ten are fixed and each has a test now. The lesson is the missing test, not the ten fixes: **there is no
end-to-end test of the Elpis tab.** One scripted run (ask, acknowledge, worker reports both ways, result shows, stop,
delete, restart) against the stand-in model would have caught seven of them. That is the next thing to build.

**Three design risks remain in the router.**
1. A model decides what each message is. Five host-side guarantees now catch its wrong turns; a new kind of wrong
   turn is still possible.
2. The router starts a new session at every app start and re-reads its own instructions with tool calls first (seen
   in every session). It has no memory of the Elpis chat beyond what it reads back.
3. Its instructions are 50 KB written for a team's GitHub bot (pull requests, reviewers, merge notices). His use is
   one person and his chats, with the GitHub source off. Most of that text is cost and confusion on every turn.

Findings of the code review of the new files are in section 5.

## 2. What makes Elpis exceptional

`AGENTS.md` says: a continuity layer, so a person can change provider or model without losing the working agreement.
His data does not show that need: of 262 chats, 229 ran on GPT, 30 on Claude, 3 on Gemini; the context folder was
last touched in July; no handoff was ever saved.

What he asked for on 8, 10 and 11 Nov, three times, is something else: **one assistant he talks to, which starts,
sizes, watches, controls and reports his agents, so he does not manage ten tabs.** That is DeepSeek's super-agent
idea ("sessions should be an implementation detail of the system, not a mental burden on its users"), and no desktop
coding app he compares against does it.

The questions only he can answer:
1. Is Elpis the continuity layer, or the assistant that runs his sessions? The second is what he uses and asks for.
   If it is the second, `AGENTS.md`'s thesis should say so, and features are judged against it.
2. Should a worker's chat be visible at all? The super-agent hides workers; he said on 11 Nov that visible is "okay".
3. How far may the router act without asking: archive garbage on its own, or always ping first (his 11 Nov sketch)?

**His answer, 11 Nov:** "The smart-pruning too I think, dynamic workflows, love-spot, though none has been rigorously
tested and proven to be positive." So three more candidates, each unproven. What would prove each, in one test:

| Candidate | The test that would settle it |
| --- | --- |
| Smart Prune | The same ten long tasks with pruning on and off: tokens spent, and whether each result still passes its check. Positive if the checks hold and tokens fall. |
| Dynamic workflows | The same five jobs done by one chat and by a workflow the Mother designs: time, cost, and whether the result passes its check. Positive if a workflow wins on at least one without losing the check. |
| Love Spot | His own use over two weeks: days opened and what he made there. It is his plan to make it a separate app, so the measure is use, not a benchmark. |

None of the three tests has been run.

## 3. Each feature: evidence and verdict

| Feature | Evidence of use | Verdict |
| --- | --- | --- |
| Chats, sidebar, projects | 217 new chats in 14 days | Keep. It is the base. |
| Router (Elpis tab) and workers | Asked for three times; used daily since 8 Nov | Keep and invest: the end-to-end test, memory across restarts, shorter instructions. |
| Map of sessions | New on 11 Nov | Keep. It answers "what is running and who started whom". |
| Workflows Board (2D) | 15 runs ever: 12 "Voting" and 2 "Logo" demos, 1 real; last board edit 2 Nov | Simplify hard (section 4). |
| Isometric view | No use outside demos | Keep only as a second look at the same live run, or cut. No editing there. |
| Scheduled workflows | No evidence either way | Ask before more work. |
| Subagents in a chat | 8 chats started 222 agents | Keep. Real use. Their helper chats leak into Recents (the "Gemini OCR" rows). |
| Love Spot and Matilda | Used on 11 Nov | Keep; his own plan is a separate app. |
| Import chats | Left rows titled `<command-name>/model…` | Fix the titles or cut. |
| Rewind | Last used 3 Nov | Keep. |
| Memories | Last changed 4 Nov | No evidence it changes answers. Ask. |
| Handoffs | Never used | Cut. |
| Context ledger, Smart Prune | Folder untouched since July | The thesis features; the least used. He counts Smart Prune as a candidate (11 Nov); unproven until the test in section 2 is run. |
| Lab, Observability, Customize | No evidence either way | Observability overlaps the Map: merge or cut. |

## 4. Workflows: what I would do

He said: "it's still not easy to set a workflow, maybe we should default it to a mother agent? Just tell it three
subagents and what have you, but the graph itself should be a source of visibility."

I agree, and most of it exists already under "Auto · Elpis chooses" (he approved this section on 11 Nov: "1) yes"):
- **One way in:** a sentence to the Mother ("three agents: one reads, one writes, one checks"). Auto is now the first
  option; the other patterns belong behind "More".
- **The graph is for watching, then for changing.** During a run it shows who works, who waits and who failed. Editing
  wires and names stays; it is not the way to start.
- **Per-agent prompt and model forms:** no evidence anyone fills them in. Keep them one click away, off the first
  screen. The router now picks a worker's model by the job; the Mother should do the same for her team.
- **Gates and guardrails around tool calls:** not now. Elpis already has Hooks for that at the engine. A gate is worth
  building when a real run shows what it would have stopped; none has yet.
- **Auto-arrange, notes and the command bar** are on the page although SPEC item 57 says to leave them out. Remove
  them or change the item.

Done on 11 Nov after his yes: the field now reads "Tell the Mother agent what you want" with a team as its example;
the bar under the board only adds an agent, and notes, the command bar and arranging stay on the right-click menu
(item 57 says so now). One fault was found on the way: the Mother ignored a team size he gave ("Use 2 agents" came back
as one agent, 3 times of 3, on a small model); a rule in her planning instructions fixes it (2 agents, 3 of 3) without
growing a plain request. A worked example added with the rule made a plain rename grow to four agents, so it was left
out. The short pattern list keeps Parallel, Sequential and Research: a test and item 56 ask for them there.

## 5. Code review of the new files

A separate review read the seven new files (the chat tools, the watch, the gate, the map) and found ten faults that
no test had caught. All are fixed, each with a test:

| Fault | What he would have met |
| --- | --- |
| "What needs me" counted only the first 20 chats | A chat waiting far down the list was reported as "nothing waits". |
| Reading "the last 6 messages" counted tool steps as messages | "The chat said nothing" in the middle of a tool-heavy turn. |
| A note that failed to write was lost for good | Two chats finish at once, the write fails once: neither "Finished" line ever comes. |
| A chat the router wrote in stayed "expected" for ever | His own short turn there an hour later announced as news. |
| A long turn that paused for approval counted as short | No "Finished" line after a ten-minute turn. |
| Searching the archive ignored the search | "Restore the chats about billing" restores 50 unrelated chats. |
| Starting a chat failed after the chat existed | A retry opens a second chat doing the same thing. |
| The map could show a stale reading for 15 s | A finished worker still shown as working. |
| Old workflow runs whose chat was archived stayed on the map | Cards that open nothing. |
| The gate against ticketing an order read only one word order | "In the Rust chat, tell the agent to rebase" still went to a worker. |

The gate stays a second line: it reads prose, so it will miss orders worded another way and will cost one round trip
when a real job sounds like one. The lasting answer is for the router to state what kind of request it accepts as a
field of the accept itself, not for the host to guess from words.
