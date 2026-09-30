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

September 30, 2026: release the accepted v0.4.0 candidate on Codex rust-v0.159.0.
Masih lifted the previous port restriction on September 29 and selected a vendor-first
method: keep the upstream release, copy Elpis files, and adapt call sites. On September
30 he tested the installed candidate, accepted the observed experience and authorized
release. Focused evidence and clean-install checks gate publication; the full inherited
suite and all historical outcome cases are not claimed accepted.

State stays in ~/.elpis-next because v0.3.0's database is incompatible. The release
includes the runtime, Code Mode host and sandbox. /force-prune, Auto routing and
appearance settings remain unported. Memory benefit beyond the observed save/recall
checks remains unproven. The live website retains its deployment boundary and is not
part of this release. TASKS.md records local execution and acceptance; release notes
record the public limits.
