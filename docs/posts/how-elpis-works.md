---
name: How Elpis works
type: technical post for engineers who already use a coding agent
---

# A coding agent forgets nothing. You just never got to choose what it kept.

Every coding agent you have used — Claude Code, Codex, Cursor — is a loop around a
list of messages. The list is the agent's entire memory. It grows every turn, and
when it gets too big something has to go. In every mainstream tool, a second model
decides what goes, while the task is running, and you find out what it kept only
afterwards — if you look.

Elpis is a fork of OpenAI's Codex CLI that makes that list a thing you can see and
edit. It keeps Codex's execution engine and adds one idea: **admission is a user
control.**

This post builds the loop from scratch in about twenty lines of Python, shows where
it breaks, and then shows what Elpis does at exactly that point. The Python is here
so you can run it. Elpis itself is Rust.

## Run the small version first

```bash
export OPENROUTER_API_KEY=...        # or any OpenAI-compatible provider
python tiny_agent.py "how many lines does tiny_agent.py have?"
```

```
   $ wc -l tiny_agent.py
-- step 1: 317 tokens of context sent
`tiny_agent.py` has 62 lines.
```

Sixty-two lines, one file, no framework. It chose to run `wc -l`, read the output,
and answered. That is the whole mechanism every coding agent is built on.

## 1. The loop

```python
while True:                    # OUTER: one lap = one thing you type
    messages.append(user_input())

    while True:                # INNER: one lap = one call to the model
        reply = call_model(messages)
        messages.append(reply)         # the model's turn joins the list too
        if not reply.tool_calls:       # asked for no tool -> it is done
            print(reply.text)
            break
        for call in reply.tool_calls:
            messages.append(run(call)) # our code runs it, not the model
```

Three facts do all the work here:

- **The model never touches your filesystem.** It emits a structured request —
  a tool name and JSON arguments. Your program decides whether to run it.
- **"Agentic" is the inner loop.** Act, observe, repeat, until the model replies
  without asking for a tool. There is no planner and no state machine underneath.
- **Everything the model knows is in `messages`.** It is stateless between calls.
  Every request re-sends the entire list.

That last fact is the one this post is about.

## 2. The list is the context, and it only grows

Watch the token count in the demo above: 317 tokens on step one. Add a `Read` of a
2,000-line file and the next request carries all of it — and carries it again on
every later step in that session, long after the agent has finished with it.

A one-hour session on a real repository ends up sending, on every single request:

- the system prompt and your project instructions;
- every file the agent read, in full;
- every command it ran and all of that command's output;
- every dead end it explored.

Nothing in the loop removes anything. The list is append-only by construction.

## 3. Where it breaks

When the list approaches the model's limit, mainstream agents compact: a second
model summarizes the conversation so far and the summary replaces it. This works,
and it has three properties you did not choose:

1. **It is invisible.** You are told it happened, not what was dropped.
2. **It is late.** It fires under pressure, near the limit, on everything at once.
3. **It resets the cache.** Every cached prefix is invalidated at the moment of
   compaction, so the request after it is the most expensive one of the session.

The failure this produces is familiar: the agent confidently edits code based on a
version of a file it read forty minutes and one compaction ago.

## 4. What Elpis changes

Elpis attacks the same list at two different points.

### The Context Ledger — admission, before the session starts

A panel beside the composer listing every source that can enter the list, grouped by
what kind of thing it is, each with a token estimate and a checkbox. This is the
real panel from the build on my machine, in this repository:

```
CONTEXT LEDGER  context not measured · ≈5.6k source estimates
Tab controls · Alt+C hide · Ctrl+click open file

SMART PRUNE                              [●━━━] OFF
Tool results pass through unchanged
p toggle · /smart-prune on|off

SUBAGENTS                                [●━━━] OFF
All work stays in this thread

CONTEXT WINDOW  usage unavailable
Context measurement unavailable until the first request snapshot

⬟ SESSION CONTINUITY  ≈1.0k tokens admitted
[x] GOAL.md              ≈73 est. tokens INCLUDED
[x] ES.md               ≈971 est. tokens INCLUDED

◆ DURABLE MEMORY  ≈0 tokens admitted
[ ] MEMORY.md           ≈879 est. tokens EXCLUDED

✦ INSTRUCTIONS  ≈4.6k tokens admitted
[x] Project AGENTS.md ≈1,538 est. tokens INCLUDED
[x] dev/AGENTS.md     ≈2,000 est. tokens INCLUDED
[x] …NG_GUIDELINES.md ≈1,051 est. tokens INCLUDED
```

Space toggles a row; `MEMORY.md` above is excluded, so those 879 tokens are not in
the request. Nothing on that list reaches the model unless it is checked. Note what
the panel admits it does not know: until the provider returns its first usage report,
context measurement is unavailable, and these are source *estimates* — the Ledger
accounts for the sources it admits, not for every byte of the provider request.

The equivalent in the Python:

```python
def build_context(sources, admitted):
    """sources: {name: text}. admitted: the set of names you ticked."""
    return [{"role": "system", "content": sources[n]} for n in admitted]
```

That is the entire idea. It is not clever. It is just not hidden.

### Smart Prune — reduction, before first admission

Compaction acts on history that is already in the list. Smart Prune acts one step
earlier: when a tool returns, its output is offered to a second, cheap model, which
decides what part of it is worth admitting. What lands in the list is the reduced
form plus a record of what was dropped.

```python
def admit_tool_result(call, output, goal):
    if len(output) < THRESHOLD:
        return output                       # small results pass through
    kept = optimizer(goal, output)          # a second, cheaper model
    audit.record(call.id, original=output, kept=kept)
    return kept
```

Two consequences worth stating plainly. The pruner is a model call, so it costs
money on every admission — it is a bet that you pay once now to stop paying for
those tokens on every later request in the session. And a reduction can throw away
something you needed; the audit record and the transcript are where you check.

Smart Prune is experimental and off by default.

## 5. What is measured, and what is not

**Measured (September 2026, 8 synthetic fixtures, same binary, sealed batches.
All costs are published-rate estimates, not invoices.):**

| Horizon | Optimizer effort | Cost vs. pruning off |
| --- | --- | --- |
| 3 requests | Max | **+163%** |
| 3 requests | Low | **+54%** |
| 3 requests | Medium | **+25%** |
| 11 requests | Low | −3% |
| 35 requests | Low | −9.8% (7 of 8 cases) |
| 35 requests | None | −20.9% (8 of 8 cases, sign test p = 0.0078) |

Read the first three rows before the last three. Pruning charges a fixed fee per
admission and repays it on every later request, so break-even is a *horizon*, not a
property. Measured break-even at None: 7 to 15 later requests. On a short task
pruning is strictly worse, and the September 8 run that reported it as 122% *more*
expensive was measuring a three-request horizon at maximum effort.

Retention did not depend on effort: Max, Low, Medium and None each passed every
closed-book probe they ran, 6/6 planted facts and citations per case. Tokens fall
31–34% in 8 of 8 cases beyond the first few requests, peak request input falls
35–40%, and wall clock rises about 16% at 35 requests.

Two caveats that matter more than the headline. **The sign depends on what your main
model costs** — with a pricier main model driving the session, the same Low-effort
pruner came out 43% cheaper at three requests in 5 of 5 cases. And **reduction did
damage fidelity twice**: two summaries rewrote exact `file:line` citation labels
while keeping every fact and line number, so the values were right and the citations
failed the oracle.

**Not measured.** These are synthetic fixtures, not real sessions. No claim of cost
saving on real work is established, and no claim of improved task quality is
established at all. Protocol, raw metrics and the kept failure log are in
[`docs/evals/rq3/`](../evals/rq3/COST_EFFICIENCY_RESULTS.md).

## 6. Current state

| | |
| --- | --- |
| **Implemented and verified** | Context Ledger admission; Codex-derived execution engine; provider-neutral model selection; telemetry off by default |
| **Implemented, under acceptance** | Smart Prune (experimental, off by default); explicit guarded memory save; the v0.3.0 development build |
| **Released** | [v0.2.0](https://github.com/MasihMoafi/Elpis/releases/tag/v0.2.0), Linux x86_64 |
| **Planned** | API-cost dashboard; documented agentic direction |
| **Intentionally unsupported** | Bundled retrieval or ML runtimes — retrieval is an MCP server you register |

Elpis is Linux-first and early access. It is not production-ready.

## 7. The one thing to take away

If you write your own agent, the loop will take you an afternoon. The hard part,
the part you will still be working on months later, is deciding what goes in the
list — and giving yourself a way to look at it.

---

*Elpis: [github.com/MasihMoafi/Elpis](https://github.com/MasihMoafi/Elpis).
The loop in section 1 follows Mihail Eric's
[The Emperor Has No Clothes](https://www.mihaileric.com/The-Emperor-Has-No-Clothes/).*
