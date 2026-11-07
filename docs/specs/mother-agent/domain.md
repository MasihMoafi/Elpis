# Domain

Adapted from dsh-superagent `docs/001-domain.md`. The domain types live in [core/model.mts](../../../apps/elpis-desktop/bridge/router/core/model.mts); [Engine](../../../apps/elpis-desktop/bridge/router/core/engine.mts) alone changes domain records.

| Concept | Rule |
| --- | --- |
| Source | Owns its receiving scope, identity, cursor, context reader and reply Channel. Elpis chat and GitHub are the installed kinds. |
| Trigger | Immutable event with stable identity; replay does not create another Ticket. Actors use the Source's native identities. |
| Thread | Orders Triggers, holds Subscriptions, batches pending input and permits one Eval at a time. Related Threads supply context. |
| Eval | Applies the deterministic gate, then routing or full assessment. Stores an accept, stop, ignore or unavailable Decision. |
| Mandate | Records scope, strength, Policy version, requester and receiving basis. Wider work needs another Ticket. |
| Ticket | Owns authorized work, Channels, Inputs, Assignments and followed pull requests. Open/ended state is independent of native session state. |
| Assignment | Binds a Ticket to a worker. Retry and recovery add Assignments while retaining the native worker identity and directory. |
| Subscription | Fans a Thread's context to every subscribed live Ticket. Context does not grant authority. Human follow-ups can resume ended work, except after a human stop. |

The main session attaches a message only on an explicit reference to an existing Ticket. Its worker owns follow-ups and hands back unrelated requests. A Thread followed only for context grants no ownership or resume rights.

[core/stage.mts](../../../apps/elpis-desktop/bridge/router/core/stage.mts) derives the displayed stage from delivery failures, questions, reports, assignments and human inputs. Views and model cards use this same state.
