# Release Checklist — Next Version

## Proposed version: v0.3.0

244 commits since v0.2.0 add several new commands (`/memory-model`,
`/pruner-model`, `/yolo`), a visible subagent list, and a reworked dashboard —
not just bug fixes — so this is a feature release, not a patch: **v0.3.0**, not
v0.2.1.

## Checklist — test these one at a time

- [ ] **Pick the model that saves memory, and the one that prunes** — run
  `/memory-model` then `/pruner-model`; each should show a live list with real
  prices, and they are now two different jobs rather than one blurred setting.
- [ ] **Anthropic and Gemini list real models** — point a picker at either
  provider with its key exported; the models and their context windows come
  from the provider now, so no "Gemini 3.5 Flash · 1000k" row that was written
  into Elpis rather than fetched.
- [ ] **The agent knows it is Elpis** — ask "who are you" on any model; no
  answer should mention Codex.
- [ ] **Memory stops repeating the project name** — after a few turns, open
  `~/.elpis/memories/MEMORY.md`; entries should be global knowledge, with no
  `Elpis …` prefix and no project status.
- [ ] **Smart Prune from the keyboard** — press Tab to focus the Context
  Ledger, arrow up to the SMART PRUNE row, and press Space; then press Escape
  and confirm the ledger closes rather than just losing focus.
- [ ] **Keys are not readable on screen** — during onboarding key entry, the
  key shows as dots with only the last four characters visible.
- [ ] **Smarter session names in resume** — open `/resume` after a few chats,
  see if sessions have short auto-generated names instead of raw IDs, and
  whether any are flagged as safe to delete.
- [ ] **Escape queues instead of killing your message** — while it's mid
  response, type something and hit Escape; it should queue your text for the
  next turn instead of throwing it away.
- [ ] **Escape closes overlays cleanly** — open `/context` or `/usage` while a
  response is streaming, press Escape, and confirm it closes the report
  without stopping or pausing the reply underneath.
- [ ] **Faster exit** — quit Elpis and see whether it closes right away
  instead of pausing.
- [ ] **Clean mouse selection** — drag-select text in the terminal while
  Elpis is still responding, copy it, and check the pasted text has no stray
  borders, prompts, or decoration mixed in.
- [ ] **Queueing with Enter and Up** — send a message while it's busy, queue a
  couple more with Enter, then press Up once and see if all of them (plus
  whatever you were typing) come back into the box together.
- [ ] **`/yolo` sticks** — run `/yolo`, start a new chat, and check that Full
  Access is already on without you turning it on again.
- [ ] **Subagents are visible** — delegate a task to a subagent and check
  whether you can see it listed with its current status while it runs.
- [ ] **Memory notes stay accurate** — have a normal chat, correct yourself
  partway through, then check your saved memory notes afterward for the
  correction landing once, cleanly, without garbled or duplicate lines.
- [ ] **Light terminal theme is readable** — switch your terminal to a light
  color scheme and check the footer, the ledger panel, and any warning text
  are still easy to read.
- [ ] **Dashboard shows real numbers** — open the dashboard after using Elpis
  for a bit and see whether per-turn cost/time and memory on/off status show
  actual figures instead of placeholders.
- [ ] **Compaction respects your setting during long tool use** — set
  `/compact 30` and run a task with a lot of tool calls; it should compact
  around 30% remaining, not run itself down much further first.
- [ ] **Elpis's name stops pulsing when idle** — after a response finishes,
  check that the animated "Elpising…" name goes still instead of continuing
  to animate while nothing is happening.

## Already accepted, not to re-test

- **Two-finger swipe no longer acts like double Escape** — accepted by Masih
  2026-09-16, tested on the installed binary. Mouse scrolling now stays with
  the terminal instead of hijacking the screen into the full-screen
  transcript.
