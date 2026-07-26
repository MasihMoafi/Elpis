# Context And Session Contract

## User Promise

Elpis should preserve the work without forcing the next model call to reread its entire
history. Exact artifacts stay on disk; active context carries only what is needed to decide
and act.

## Implementation Status

Implemented and covered by focused remote checks:

- portable workspace `GOAL.md` and per-turn `ES.md`;
- fresh-thread admission of the portable goal and checkpoint;
- exact native-thread resume;
- pre-compaction synchronization that stops on write failure;
- `/usage` reporting for portable sources, sizes, lifetimes, and reasons;
- Elpis-owned bounded memory roots, retrieval, promotion, and archive storage.

Still requiring end-to-end acceptance:

- one real exact resume and one lean continuation;
- proof that `/usage` matches the next model-visible request;
- related versus unrelated memory admission;
- memory review, deletion, reset, and compaction behavior.

The earlier deterministic cleaner (Layer 1) is disabled. Its fixed 400-character
threshold could replace a tool result before the active agent had consumed it, violating
the lifecycle contract below. Codex's inherited model-aware tool-output safety cap remains
active. A replacement deterministic pass must classify only material that is eligible to
expire after its current question has been answered.

For eligible uncovered tool output, Layer 2 ("Masih's Ace in the Hole") executes
background model pruning passes whenever uncovered transient content exists
(`uncovered_chars >= 1,000` or `used_percent >= 1%`). Terra runs first, then the
active model. Ace sees the active user question and each tool invocation paired with
its output. A strict parser rejects the entire pass if any output line is malformed,
unknown, duplicated, or empty. If both models fail validation, working history and
covered IDs remain unchanged.

A validated kept result becomes a concise finding plus an exact rollout pointer. An
omitted dead end removes both its invocation and output from working history. Assistant
answers are not deletable Ace inputs. `/usage` tracks Ace's live savings and shows
deterministic savings as zero while Layer 1 is disabled.

Each applied Ace pass first writes an immutable audit under
`~/.elpis/logs/pruning/passes/<pass-id>/`:

- `ace.json` contains Ace's exact instructions, input, and raw response;
- `manifest.json` lists every reviewed call ID and its kept/deleted decision;
- `items/*.json` contains the exact model-visible before and after items for one call.

`~/.elpis/logs/prune_report.md` points to the latest pass. These focused artifacts omit
the unrelated system prompt, skills, and transcript. If the immutable audit cannot be
written, Elpis preserves the working history and does not record the pass as applied.

## Context Lifecycle

Every admitted item has a lifetime:

- **durable:** rules, active goal, and explicit constraints;
- **task:** decisions, changed paths, blockers, and verification;
- **turn:** searches, reads, command output, and failed probes.

Turn material expires only after its question is answered. Before eviction, Elpis must retain
operation, target, conclusion, status, changed paths, and an exact evidence pointer. Removing
an item from the visible TUI is insufficient; it must be absent from the next request.

## Session Persistence

Elpis separates:

1. the native runtime thread;
2. exact workspace artifacts;
3. a compact portable checkpoint;
4. reusable cross-session memory.

- **Exact resume:** continue the native thread while its accumulated context remains useful.
- **Lean continuation:** begin a fresh thread from the portable goal/checkpoint and a small
  recent suffix.

Portable state lives under `~/.elpis/context/workspaces/<workspace>/`:

- `GOAL.md` mirrors the active goal;
- `ES.md` records the latest result, changed paths, command outcomes, next action, and
  provider-thread pointer.

Provider transcripts remain the exact evidence source. The portable files must never become
a second transcript.

## Context Cleaner Acceptance

A compliant cleaner must:

1. preserve the newest result until it has been used;
2. identify stale exploration by lifetime/turn rather than length alone;
3. retain a compact conclusion and source pointer;
4. keep raw output on disk;
5. prove evicted material is absent from the next request;
6. stop when safe checkpointing cannot be completed.

The unsafe deterministic pass is disabled; Ace remains active. A replacement deterministic
pass must satisfy this lifecycle contract without relying on arbitrary length thresholds alone.

## Memory And Archive Contract

Active durable memory is bounded under `~/.elpis/memories`. Promotion requires repeated
useful recall across distinct contexts. Weak and detailed evidence remains searchable rather
than always entering the prompt.

Deleted or age-faded lines must be appended to `archive.md` before baseline reset. Archive
write failure is consequential and must block reset. Archive retrieval remains selective;
the entire archive is never injected by default.

## Acceptance Order

1. Exact resume retains the native thread.
2. Lean continuation receives only the portable goal/checkpoint and recent suffix.
3. `/usage` names every admitted portable source and reason.
4. The cleaner removes stale raw output while preserving a useful record and evidence pointer.
5. Related memory appears with provenance; unrelated memory stays absent.
6. Review, deletion, archive, and reset work without losing exact evidence.

## New — Masih's Ace in the Hole: Agent-Owned Post-Turn Context Pruning

Elpis must not carry an agent's exploratory work forward merely because it happened in the
same thread. After a turn has delivered its user-visible answer, Elpis prepares that agent's
next-turn context from what the turn proved, changed, decided, and still requires. The raw
transcript remains durable evidence; it is not the default working context for the next call.

This is meaning-aware classification, not vectorization, RAG, or character-count truncation.
It uses the agent's known turn outcome plus deterministic rules to classify material by purpose:

- retain the active question, final answer or decision, changed paths, verification result,
  active blocker, next action, and exact evidence pointers;
- retain a successful search, read, or command only as its conclusion and source pointer;
- retain failed commands and dead ends only when they establish a current constraint or blocker;
- expire command attempts, shell output, directory listings, repetitive reads, abandoned paths,
  and other exploratory traces once their useful conclusion has been retained;
- never preserve hidden reasoning as transcript context; preserve the resulting decision and
  evidence instead.

Encrypted reasoning is nevertheless live state during an active Responses tool loop.
Elpis preserves it through every model/tool and stop-hook follow-up. After a successful
final response, current-turn reasoning expires from working history while the durable
rollout remains exact. Responses modes that explicitly request `all_turns` keep it.

The lifecycle is:

1. The agent completes the turn and the user-visible answer is delivered without waiting for an
   extra cleanup interaction.
2. Elpis records a compact turn outcome with deterministic fields: objective, conclusion,
   decisions, changed paths, verification, blockers, next action, and evidence pointers.
3. Deterministic rules validate the record, retain required evidence, and mark the remaining
   transient items expired for the next request.
4. Before the next model call, Elpis assembles context from durable rules, goal, admitted
   sources, the compact task/turn record, and only still-live recent material. It must not resend
   expired exploration.

The agent that performed the work is the preferred outcome author because it knows which steps
answered the question. Deterministic rules remain the authority for required fields, evidence
retention, expiry, and safety. A smaller distillation model may assist only for dense or ambiguous
turns; it must never become a required delay before showing the user an answer, and Elpis must
fall back to the deterministic record when it is unavailable.

### Deterministic First Pass

Before any model-assisted classification, Elpis should remove obvious context waste in a
hard-coded, reversible way from material that is eligible to expire:

- collapse runs of blank lines and remove trailing whitespace in prose-like terminal output;
- replace raw command input/output with a compact action receipt after its conclusion and
  evidence pointer are retained;
- preserve whitespace exactly for source code, patches, structured data, and user-provided text
  where it can change meaning;
- keep raw terminal input/output on disk, not in the default next-turn prompt;
- never delete current-turn evidence before it has produced a valid outcome record.

The intended default is not “delete everything.” It is “exclude most completed exploration from
the next prompt, while retaining enough structured outcome and retrieval handles to recover any
needed detail.” Full conversations and raw tool events may remain durable and searchable. When a
later task needs old detail, Elpis should use an exact evidence pointer when known, or retrieve it
on demand; it must not reattach the whole transcript by default.

### Context Accounting Contract

Elpis must expose one auditable context measure. Every displayed percentage must state whether it
means **used** or **remaining**, identify the context-window limit and runtime source, and refer to
the same next-request scope. A persistent Elpis context label and an inherited sporadic indicator
must not present conflicting numbers. The inherited, intermittent top-left context display should
be removed or suppressed until Elpis can replace it with this verified measure.

Acceptance requires a controlled turn where the rendered value, `/usage`, and the runtime's next
request accounting agree on used tokens, remaining tokens, and the context-window limit.

### Captured Design Inputs

- Keep conversations in full as durable evidence, but not as default working context; use RAG or
  exact retrieval only when old detail is needed.
- Prune terminal input/output and exploratory traces most of the time, not blindly in every case.
- The agent must retain a reliable way to recover anything it later needs.
- A million-token context may defer the problem but increases cost and clutter; Elpis exists to
  make a smaller context window sufficient without losing evidence.
- The feature must preserve user intent and exact evidence even when design details are still
  unresolved.

### Acceptance

For a turn containing many searches, file reads, failed commands, and one decisive result:

1. the next request contains the conclusion, changed paths or answer, next action, and exact
   evidence pointer;
2. it excludes raw exploratory output and irrelevant failed attempts;
3. the durable transcript still permits exact inspection of every omitted action; and
4. if pruning cannot produce a valid record, Elpis preserves the existing context rather than
   silently discarding evidence.
