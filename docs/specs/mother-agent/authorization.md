# Authorization

Adapted from dsh-superagent `docs/002-authorization.md`. [policy.mts](../../../apps/elpis-desktop/bridge/router/policy.mts) owns the gate, version, assessment outcome and Mandate revalidation. [admission.mts](../../../apps/elpis-desktop/bridge/router/admission.mts) owns admission cells and defaults.

An allowed person's direct request or mention is explicit. Each Source's admission table decides other human messages. Listed bots can supply inferred candidates; they cannot make explicit requests or stop work. GitHub and Elpis identities have separate allowed lists. The selected local chat identifies its user as `local-user`.

| Accept mode | Inferred work |
| --- | --- |
| off | No inferred candidate is admitted. |
| observe | Assessment records what would be accepted and starts no worker. |
| auto | An assessment can accept under enabled, matching rules. |

Explicit requests work in every mode. A proactive assessment judges every enabled rule exactly once and establishes intent, settled direction and bounded scope. An irrelevant card can be ignored directly; inferred acceptance requires the full assessment tools.

Subscriptions bypass admission for context. An owned human follow-up remains its worker's to decide; the main session can only act on a person's stop request until the workers release or hand back the message. [core/evals.mts](../../../apps/elpis-desktop/bridge/router/core/evals.mts) enforces these restrictions.

A Policy change invalidates running evaluations and tells affected live Tickets what changed. It does not cancel their work. Before an ended Ticket resumes, its receiving scope, sender/admission basis and inferred rules are revalidated. A human stop withdraws its Mandate permanently.

Settings tools cannot change account setup or shell execution fields. Prompt overrides cannot change the gate or tool checks. Native worker tools check that their Ticket remains live. The operator's standing approval rules still govern helpers, paid calls, destructive actions and publication.
