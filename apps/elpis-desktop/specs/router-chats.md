# SPEC: The router and its workers are ordinary chats

Goal: Elpis's router (the "Elpis" chat) and each worker it starts show and behave like any other chat, as in DeepSeek
Harness, where the main Session and each `worker-<ticket>` Executor Session are ordinary Sessions a person can open and
write in (ext/dsh-superagent-prototype/docs/003-execution.md, "A person can also start a turn by writing directly in the
Executor Session"). Masih, 10 Nov: "it should show as any other chat as deepseek harness does. not a subagent!"

Invariants: no chat or ticket is lost; the router keeps routing; the Elpis sidebar item still opens the router chat.
Constraints: no new chat kinds; the sidebar's existing rows, pins and projects.

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| R1 | The router chat "Elpis" is listed in the sidebar like any chat and opens in the main column. | Sidebar shows "Elpis"; clicking it opens its transcript; a message sent there gets the router's reply. | todo |
| R2 | Each worker is its own chat in the sidebar, named by its ticket, never nested as a subagent of the router. | A new ticket's chat appears in Recents with its ticket title; the Agents panel does not list it under Elpis. | todo |
| R3 | What the router sends a worker reads as text: the ticket's title, the assignment and the person's request; no IDs. | Open a worker chat: no `ticket_id`, `trigger_id` or JSON braces in its first message. | todo |
| R4 | Router notices to a worker (resume, hand-back rules) show as a small note, not as a message from you. | Open a resumed worker: the notice is a quiet note, not a right-aligned bubble. | todo |
| R5 | You can write in a worker chat directly and it answers there. | Send "status?" in a worker chat: its reply appears in that chat. | todo |

Non-goals: changing how the router decides or assigns work.
Stop and ask: a change that would delete or re-parent saved chats on disk.
