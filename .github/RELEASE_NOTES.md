Elpis is a terminal environment for coding agents. The agent runs the model loop;
Elpis owns context, memory, continuity, retrieval, permissions, and provider choice.

**Install** (Linux x86_64 or macOS Apple Silicon):

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/main/scripts/install-elpis.sh | bash && ~/.local/bin/elpis
```

Already running Elpis? Use `elpis --update`.

**What's new since 0.1.1**

- **Durable Ace pruning** — selective steady and pressure passes, configurable reclaim targets, `/prune` and `/force-prune`, animated savings, a `/context` breakdown, and saved totals that survive session resume. Luna runs the pruning pass at High reasoning effort.
- **Provider routing** — explicit Anthropic, Gemini, and OpenRouter routing with corrected authentication boundaries and live model/status reporting.
- **Accountable agent work graphs** — persisted task graphs, bounded roles and scopes, dependent verification, and an `/agent` view of task state and evidence.
- **Permission and interface fixes** — permissions can cycle while work is running; hidden commands no longer intercept typed input; obsolete usage-limit reset UI was removed.
- **Documentation and evaluation refresh** — the README now includes context-retention and tool-call evidence, with reproducible continuity and work-graph evals.

**Known limits**

- Durable memory extraction works, but promotion still requires recall evidence that has not been reached on Masih's install.
- Work-graph and continuity evals are automated; Masih's final functional acceptance remains outstanding.
- Windows, `/auto`, voice input, and LSP integration remain out of scope.

Verify each download with its matching `.sha256` asset. Full docs are in the [README](https://github.com/MasihMoafi/Elpis#readme).
