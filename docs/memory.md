# Memory

Elpis keeps a local memory folder so recurring project knowledge stays available without
turning every past conversation into prompt baggage. The agent reaches it by reading
files, not through a hidden retrieval step: a searchable registry, a short-term evidence
file, per-session recaps, and any stored skills.

## Recall is a guided lookup

Recall starts from a summary already in context, extracts keywords, and searches the
registry before anything else. Short-term evidence is searched only when the registry
misses, and session recaps are opened only when something points at them. The lookup is
budgeted — a handful of search steps before the real work starts — so memory cannot
quietly become the bulk of a request.

Whatever the agent used, it must cite: the exact files and line ranges, and the sessions
they came from.

## Staleness is disclosed, not eliminated

Memory records what was true when it was written, and Elpis does not silently re-verify
it. The agent weighs how likely a fact is to have drifted against what checking would
cost. Cheap and drift-prone means verify it now. Expensive or disruptive to check means
it may answer from memory, but it must say the answer is memory-derived, say it may be
stale, and offer to refresh it. Unverified memory must not be presented as
confirmed-current.

That disclosure is the actual guarantee. Nothing makes stale memory impossible.

## Writing memory requires your say-so

The agent cannot update memory on its own initiative, and cannot edit the memory files
directly at all. When you ask for a change, it leaves one small note describing what
should be added, changed, or removed, and the consolidation pass applies it. Short-term
evidence is therefore never silently converted into a permanent rule.

Read [context and sessions](context-and-sessions.md) for how memory fits into the
live-session reduction model.
