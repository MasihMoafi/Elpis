# Elpis v0.2.0

Elpis v0.2.0 is a Linux-first release centered on explicit context control and cache-stable tool-output admission.

## Install

Linux x86_64:

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/v0.2.0/scripts/install-elpis.sh | bash && ~/.local/bin/elpis
```

## What changed

- **Smart Prune (Experimental, off by default)** can optimize eligible textual tool results before the main model first sees them. Once admitted, Smart Prune does not revisit that history.
- **Clear recovery boundaries:** the ambiguous retrospective `/prune` command is gone. `/force-prune <1-100>` remains an explicit emergency action that may reduce prompt-cache reuse; `/compact` remains native Codex compaction.
- **Truthful context surfaces:** the Context Ledger, `/context`, and `/dashboard` distinguish current usage, estimated attribution, historical savings, Smart Prune admissions, and optimizer overhead.
- **Explicit continuity and memory:** `GOAL.md`, `ES.md`, development rules, and the user-maintained `MEMORY.md` are visible admission choices. Elpis does not claim automatic memory extraction or promotion.
- **Safer customization:** ordinary skills and plugins do not participate until deliberately enabled. Configured MCP servers remain independent of the plugin gate.
- **Accountable work graphs (under development, off by default):** persisted DAGs validate dependencies, write scopes, evidence, and required verifier tasks before dispatch.
- **Provider and activity improvements:** model/reasoning selection, live turn timing, cost availability, dashboard updates, and failure accounting are more explicit.

## Evidence boundary

Focused tests establish Smart Prune's first-exposure placement, exact fail-open behavior, and append-only tested request prefix. One normal-work ON session observed 95.85% cached input overall and high cache reuse at two admission boundaries. There is no matched OFF/ON study yet, so comparative cost, latency, and task quality remain open.

## Known limits

- Smart Prune uses an extra optimizer request and can add latency. It is Experimental and disabled by default.
- Manual `MEMORY.md` admission works; automatic memory promotion does not exist.
- Work graphs and native Anthropic/Gemini routes remain under live user acceptance.
- This release publishes Linux x86_64 artifacts only.

Read the [technical preprint](https://github.com/MasihMoafi/Elpis/blob/main/paper/paper.md), [evaluation results](https://github.com/MasihMoafi/Elpis/blob/main/docs/evals/RESULTS.md), and [full README](https://github.com/MasihMoafi/Elpis#readme).
