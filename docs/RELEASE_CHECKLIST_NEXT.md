# Release Checklist — Next Version

## Proposed version: v0.3.0

Over 300 commits since v0.2.0 add several new commands (`/memory-model`,
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

## Known missing — do not spend a test pass on these

Diagnosed, not built. Listed so a failing result is not mistaken for a
regression.

- **Escape with messages queued still interrupts the turn** rather than
  delivering them. Codex interrupts here too, so this is a deliberate
  divergence from Codex and only your spec governs it.
- **`/context` does not close on Escape.** `/usage` does, because its chart is
  an overlay; the context report is written into the transcript instead.
  Giving it the same behavior means rebuilding how the report renders, which
  is not a change to make in the hours before a test pass.
- **Exit is not immediate.** The teardown-before-terminal-release order is
  Codex's own, unchanged, so copying Codex yields no fix here; what is slower
  is how much more Elpis has to tear down. That needs a measurement nobody has
  taken yet.

## Already accepted, not to re-test

- **Two-finger swipe no longer acts like double Escape** — accepted by Masih
  2026-09-16, tested on the installed binary. Mouse scrolling now stays with
  the terminal instead of hijacking the screen into the full-screen
  transcript.

## Release steps, in order

1. `codex-rs/tui/Cargo.toml` carries `0.3.0` and `.github/RELEASE_NOTES.md` is
   written for it. Both are done on `feat/live-provider-model-lists`.
2. Move `main` to the release commit, or tag this branch directly. Everything
   from `v0.2.0` onward exists only here — `main` is 84 commits behind, and
   tagging it would publish the old product under a new number.
3. Tag `v0.3.0`. The tag build runs the full surface and the exhaustive
   continuity regression, then publishes the binary, the sandbox helper, the
   `.deb`, and their checksums. A failed tag publishes nothing and says
   nothing, so confirm with `gh release list`.
4. Update `readme.md` once the tag exists: the availability line, the versioned
   guide and installer URLs, the paper link, the "current release" line, and the
   shipping-checks run identifier, which is only knowable after the tag build
   passes.
