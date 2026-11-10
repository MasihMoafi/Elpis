# The router (the Elpis tab)

The router is the one assistant Masih talks to in the Elpis tab. It answers questions about his chats and controls them
itself, and hands real work to workers, each an ordinary chat with its own ticket and folder. Requirements:
[production.md](../../../../docs/specs/production.md) section B and [router-chats.md](../../specs/router-chats.md).

It is a port of DeepSeek's dsh-superagent (MIT, [LICENSE-dsh-superagent](LICENSE-dsh-superagent); source kept in
`~/Desktop/p/ext/dsh-superagent-prototype`, whose `docs/` explain the design in order). Files adapted from it say so in
their first line. What Elpis adds is listed under "Elpis's own parts".

## How a message flows

1. He writes in the Elpis chat. `sources/elpis-chat*.mts` reads it as a trigger, one thread per request.
2. `core/` admits it and gives the main Session (the orchestrator) a candidate card.
3. The orchestrator decides with `orchestrator_route`: answer it directly (`ignore` with an answer), accept it as a
   ticket, attach it to a ticket, or stop one. A question about his chats, or an order to one, is answered directly
   with the chat tools.
4. An accepted ticket gets a worker Session in its own folder (`executor/`). The worker reports; the orchestrator
   replies in the Elpis chat through the outbox (`outbox.mts`), so a reply survives a restart.

## Folders

| Folder | Job |
| --- | --- |
| `core/` | The domain: triggers, tickets, decisions, replies and the Engine that owns them. No Elpis or network code. |
| `executor/` | Worker and orchestrator Sessions: one per ticket, their folders, tools server, retries and settlement. `adapters.mts` talks to the Elpis engine. |
| `sources/` | Where requests come from: the Elpis chat (on) and GitHub (off unless he turns it on). |
| `app/` | The application around the core: the SQLite store, prompts and their versions, settings, the tools of both roles (`app/tools/`), resources the tools read, and the management panel's HTTP routes. |
| `infra/` | Health, paths, commands, text limits. |
| `prompts/` | The built-in instructions of both roles, one sentence per line. `app/prompts.mts` composes them. |
| `skills/` | The two Source skills the Sessions can load. |
| `fixtures/` | Test doubles shared by the tests beside each module. |

Top level: `app.mts` wires everything on one database; `mother-agent.mts` is the desktop's lifecycle around it (start,
stop, the Elpis chat, settings); `policy.mts`, `admission.mts` and `settings.mts` are the access rules.

## Elpis's own parts

| File | Job |
| --- | --- |
| `chats.mts` | His chats through the desktop client: list, read, send, start, stop, rename, archive, restore. |
| `app/tools/chats.mts` | The five chat tools of the main Session, and their two limits: never the router's own chats, and nothing while a Source that carries outside text is on. |
| `prompts/chats.md` | When to use them: answer and act directly, keep tickets for work. |
| `sources/elpis-chat*.mts` | The Elpis chat as a Source, in place of dsh-superagent's Feishu. |
| `model.mts` | The model list from his configured providers. |

## State on his machine

`~/.elpis-next/router/`: `orchestrator.sqlite` (tickets, settings, outbox), `mother.json` (on or off, the chat's id,
the two models), `work/<ticket>/` (each worker's folder).

## Checking a change

`node --test 'bridge/router/**/*.test.mts'` (about 15 s), then the rule in the repository's `AGENTS.md`: send one
prompt in the Elpis tab of the installed app and wait for its answer.
