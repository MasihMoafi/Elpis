# Workflow + · 19 October 2026

Contract: Masih's workflows-plus.md handoff governs this correction.

- The round + below an agent adds exactly one agent with exactly one link:
  the clicked agent → the new agent. Existing links remain unchanged.
- Place it in the next column's nearest free slot, without overlapping agents
  or notes. Keep existing positions, including with auto-arrange enabled.
  Select it, open its panel and focus its prompt, even with the panel folded.
- Its accessible name and hint describe adding an agent after this one.
  Remove the parallel quick-create path: no other control exposes it.
- The right-side + retains the same successor behavior. At the agent limit,
  neither control changes the graph, and the existing warning explains why.

Plan: fail real-click tests on root and middle agents first; use the shared
successor action; update the former parallel regression; check affected UI files,
types, renderer, bridge and desktop. Inspect light/dark captures under
~/.cache/elpis-tests/workflows-feedback/plus/. No installation or runtime changes.
Masih's acceptance remains open.
