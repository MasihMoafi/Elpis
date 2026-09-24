# Elpis Vision

Elpis is the continuity layer around an AI coding runtime.

The user should be able to change a provider, model, or local runtime without losing the working agreement that makes an agent useful: the current goal, admitted context, permissions, decisions, and evidence. Elpis owns that durable boundary; the provider owns inference.

## Product promise

**Change the runtime. Keep the thread.**

Elpis should make four things visible and inspectable:

1. **Goal** — what the current session is trying to accomplish.
2. **Context** — which project instructions and memories were deliberately admitted.
3. **Control** — which tools and permissions the runtime may use.
4. **Evidence** — what changed, what was verified, and what remains unknown.

## Design direction

Elpis should feel like a serious instrument rather than another chat wrapper. Its visual language is deep charcoal with ember and rose for activity, while verdigris is reserved for confirmed or admitted state. Dense operational detail should remain legible, calm, and subordinate to the current goal.

The public website may borrow RAG Studio's standard of polish, but not its composition or palette. It should explain Elpis to someone who has never used an agent harness, show the continuity model directly, and keep experimental work clearly separated from available behavior.

## Truth boundaries

- Memory admission remains a Context Ledger choice. On September 22, 2026, Masih approved replacing the separate-model saver with an explicit guarded save by the responding agent. That candidate is under verification, not yet accepted. September 13 Luna save/recall evidence belongs to the old implementation; general coding-quality benefit remains unproven. See `docs/context.md` for the current contract and limits.
- Automatic context pruning and deterministic work graphs are experimental and off by default. Do not present them as everyday guarantees.
- Historical evaluations may be reported with their original scope and caveats. They do not establish general task-quality improvement.
- Elpis is a Linux-first early-access project. Do not describe the current candidate as production-ready until daily-driver acceptance is complete.
- Local, inspectable state is a product property; provider requests still follow the provider or runtime the user selects.

## Near-term outcome

September 24, 2026: explain and sharpen the build that exists.

Rebuilding Elpis on a newer Codex foundation was attempted and abandoned. Masih
tested the ported build on September 23: it reproduced Codex's engine without
Elpis's identity, `/dashboard`, `/agent`, or its added commands, and the Elpis he
had been using was restored. Do not restart that port.

Current work: the technical write-up and presentation of the installed build
(`docs/posts/how-elpis-works.md`), a readme refresh, and the two defects Masih can
feel — exit is not immediate, and Escape does not dismiss the `/context` report.
The responding-agent memory candidate is installed with automated evidence; user
acceptance remains open. Compaction instructions are under repair. The live website
has a known source/deployment mismatch: do not overwrite it from this checkout.
API-cost dashboard improvements and the documented agentic direction come later.
Current execution and acceptance gates live in `TASKS.md`; requested outcomes in
`docs/USER_REQUESTS.md`.
