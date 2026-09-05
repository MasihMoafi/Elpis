# Elpis v0.2.0

Elpis v0.2.0 is a Linux-first coding-agent TUI centered on explicit context control
and auditable tool-output admission. The maintainer accepted this version's local
candidate before release. Smart Prune remains experimental and off by default.

## Install

Linux x86_64. The installer checks the downloaded binary against its SHA-256
sidecar; review the script before running it.

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/v0.2.0/scripts/install-elpis.sh | bash && ~/.local/bin/elpis
```

## What changed

- **Smart Prune (Experimental, off by default)** can optimize eligible textual tool results before the main model first sees them. Once admitted, Smart Prune does not revisit that history.
- **Clear recovery boundaries:** `/prune` enables Smart Prune for subsequent turns without rewriting sent history. `/force-prune <1-100>` remains an explicit emergency action that may reduce prompt-cache reuse; `/compact` remains native Codex compaction.
- **Context observability:** the Context Ledger, `/context`, and `/dashboard` distinguish current usage, estimated attribution, history rewrites, Smart Prune admissions, and optimizer overhead. Ledger and `/context` share category colors and a full-window scale; individual categories remain estimates. The local candidate's visual acceptance is recorded.
- **Explicit continuity and memory:** `GOAL.md`, `ES.md`, development rules, and the user-maintained `MEMORY.md` are visible admission choices. Elpis does not claim automatic memory extraction or promotion.
- **Safer customization:** ordinary skills and plugins do not participate until deliberately enabled. Configured MCP servers remain independent of the plugin gate.
- **Accountable work graphs (under development, off by default):** persisted DAGs validate dependencies, write scopes, evidence, and required verifier tasks before dispatch.
- **Provider and activity improvements:** model/reasoning selection, live turn timing, cost availability, dashboard updates, and failure accounting are more explicit.

## Evidence boundary

Focused tests establish Smart Prune's first-exposure placement, exact fail-open
behavior, and append-only tested request prefix. An older normal-work ON pilot
observed 95.85% cached input overall. A separate September 5 ON-only smoke admitted
one smaller output, retained a planted fact, and observed 91.57% cached input on
its follow-up response. Neither is an OFF/ON comparison; total cost, latency and
general task-quality effects remain unproven. See the
[experiment log](https://github.com/MasihMoafi/Elpis/blob/v0.2.0/docs/evals/EXPERIMENT_LOG.md).

## Known limits

- Smart Prune uses an extra optimizer request and can add latency. It is Experimental and disabled by default.
- Manual `MEMORY.md` admission works; automatic memory promotion does not exist.
- Work graphs and native Anthropic/Gemini routes remain under live user acceptance.
- This release targets Linux x86_64 only. macOS and Windows are not included.

Read the [technical preprint](https://github.com/MasihMoafi/Elpis/blob/main/paper/paper.md), [evaluation results](https://github.com/MasihMoafi/Elpis/blob/main/docs/evals/RESULTS.md), and [full README](https://github.com/MasihMoafi/Elpis#readme).
