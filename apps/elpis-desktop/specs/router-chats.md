# SPEC: The router and its workers are ordinary chats

Goal: Elpis's router (the "Elpis" chat) and each worker it starts show and behave like any other chat, as in DeepSeek
Harness, where the main Session and each `worker-<ticket>` Executor Session are ordinary Sessions a person can open and
write in (ext/dsh-superagent-prototype/docs/003-execution.md, "A person can also start a turn by writing directly in the
Executor Session"). Masih, 10 Nov: "it should show as any other chat as deepseek harness does. not a subagent!"

Invariants: no chat or ticket is lost; the router keeps routing; the Elpis sidebar item still opens the router chat.
Constraints: no new chat kinds; the sidebar's existing rows, pins and projects.

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| R1 | The router chat "Elpis" is listed in the sidebar like any chat and opens in the main column. | Sidebar shows "Elpis"; clicking it opens its transcript; a message sent there gets the router's reply. | done: Elpis listed and opened from the sidebar; "Router check 2" got "Got this." (10 Nov, installed 2fea02671) |
| R2 | Each worker is its own chat in the sidebar, named by its ticket, never nested as a subagent of the router. | A new ticket's chat appears in Recents with its ticket title; the Agents panel does not list it under Elpis. | done: both worker chats listed in Recents by ticket title (10 Nov) |
| R3 | What the router sends a worker reads as text: the person's request once, in his words, and the router's note; no IDs. The ticket's title names the chat and shows in the message only when there is no request (13 Nov: title and request read as his request "printing two times"). | Open a worker chat: no `ticket_id`, `trigger_id` or JSON braces in its first message, and the title is not repeated above the request. | done: worker chat shows title, assignment and request; no ticket_id (10 Nov). Changed 13 Nov: request and "Note from Elpis", no title (`lib/router-worker-input.test.mts`) |
| R4 | Router notices to a worker (resume, hand-back rules) show as a small note, not as a message from you. | Open a resumed worker: the notice is a quiet note, not a right-aligned bubble. | done: "Elpis resumed this ticket…" shows as a note (10 Nov) |
| R5 | You can write in a worker chat directly and it answers there. | Send "status?" in a worker chat: its reply appears in that chat. | done: "status? one line please." answered in the worker chat (10 Nov) |
| R6 | The main router opens with its latest ten requests and releases older displayed and cached entries while following new replies, with a ceiling of 100 entries for unsolicited worker results. Older messages load only through the top “Load more messages” button; incoming replies preserve history being read. | Open a long router chat, receive new requests and worker results, load older messages, and switch away and back. Saved history remains intact and ordinary chats keep their scrolling behavior. | implemented; desktop verification pending |

Non-goals: changing how the router decides or assigns work.
Stop and ask: a change that would delete or re-parent saved chats on disk.

Cause found 10 Nov: the Elpis chat source keyed every message to one thread, so the first ticket took every later
message. Now one thread per request, as dsh-superagent keys Feishu threads by their root message.
