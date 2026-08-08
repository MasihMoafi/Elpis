# Memory

Elpis keeps one durable memory file per project and nothing else. There is no extraction
pipeline, no candidate queue, no promotion thresholds and no consolidation agent — all of
that was built, measured, and deleted on 5 August 2026 after producing zero promotions in
five days of live use (104 extractions, 60 candidates, no change to `MEMORY.md`). What
remains is the part that worked.

## What exists

| Path | Holds |
| --- | --- |
| `~/.elpis/memories/MEMORY.md` | Durable facts you want carried between sessions. |

`MEMORY.md` reaches the model through the **Context Ledger**, where it is listed and
switchable exactly like `AGENTS.md`, `GOAL.md` and `ES.md`. Toggle it off in the ledger and
its contents leave the prompt on the next request. That switch is the whole interface.

## Who writes it

You do, or you ask the agent to. It is an ordinary Markdown file edited with ordinary
tools. Nothing writes to it in the background.

## The layers it sits in

```
durable         Global rules & memory     AGENTS.md, GOAL.md, MEMORY.md
session         This conversation         messages, tool output, pruning records
turn            The request in flight     the prompt actually sent
```

Durable content is re-sent on every request, which is why it is small and switchable
rather than large and automatic.

## Eval

`codex-rs/app-server/tests/suite/v2/memory_recall.rs` asserts both directions: a fact in
`MEMORY.md` reaches the model, **and** switching `MEMORY.md` off in the Context Ledger
removes it. Any change to how memory is stored or recalled must keep that passing.
