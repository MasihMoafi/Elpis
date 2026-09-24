# Elpis v0.3.0

Elpis is a terminal environment for coding agents. The agent runs the model loop;
Elpis owns context, memory, continuity, retrieval, permissions, and provider choice.

## Install

Linux x86_64. The installer checks the downloaded binary against its SHA-256
sidecar; review the script before running it.

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/v0.3.0/scripts/install-elpis.sh | bash && ~/.local/bin/elpis
```

Already running Elpis? Use `elpis --update`.

## What changed since v0.2.0

- **Pick a provider without editing a config file.** `/model` now has a provider step, so reaching Anthropic, Gemini, OpenRouter, Bedrock, Ollama or LM Studio no longer means hand-editing `config.toml`. Paste an API key in the terminal or the dashboard; the key is masked as you type. The same seven providers shipped in v0.2.0 — what is new is getting to them from inside Elpis.
- **Model lists come from the provider.** Each picker asks the provider what it serves, with the context window and price the provider reports, instead of reading a table written into Elpis.
- **Thinking effort beyond OpenAI.** Any provider that accepts a reasoning level offers one, so a DeepSeek or OpenRouter model can be set to think longer.
- **Memory and pruning are separate jobs.** `/memory-model` and `/pruner-model` choose them independently, and background work no longer borrows the model you are talking to.
- **Continuity saving got out of the way.** A turn ends when the model stops speaking rather than when maintenance finishes, so the next message is a message and not an interruption. Saves that overlap each other settle quietly instead of warning.
- **The Context Ledger turns subagents off.** Press `s` to stop the model delegating, alongside Smart Prune. Escape closes the ledger, and the row under the cursor is the only row marked.
- **Escape steps back one page, not out of the screen.** In the model catalog, the provider list, the API key prompt and both `/skills` pages, Escape returns to the page you came from; each used to close the whole screen. A provider whose catalog is fetched live, such as OpenRouter, also lists its models directly instead of offering a single row to open.
- **`/usage` draws the token activity chart again**, with daily, weekly, and cumulative views.
- **`/yolo` sticks.** Full Access survives into the next session.
- **New commands:** `/ide`, `/yolo`, `/memory-model`, `/pruner-model`.
- **Long conversations stay responsive.** Typing and queueing keep up in a long chat, and the context count holds its last provider-reported figure instead of jumping to an estimate the moment you press Enter.
- **The composer holds still while a turn runs.** It no longer repaints itself, which is what native drag-selection needs. The identity and status names still animate.
- **A backslash before Enter starts a new line** instead of sending.
- **Updating updates Elpis.** The update notice and the startup prompt both run `elpis --update`, which replaces the installed binary with the latest Elpis release. The prompt previously carried package-manager commands inherited from upstream, which would have installed a different product.

Subagent work in this release is repair, not new capability: another window's threads are no longer counted as this window's subagents, a subagent's message interrupts the parent turn again, the footer names the agent you are on instead of a stale count, and spawn/resume rolls back when durable state cannot be saved. The work-graph engine itself is unchanged.

## Known limits

- Linux x86_64 only. The installer refuses macOS with an explanation rather than fetching a binary that does not exist; Windows remains out of scope.
- Escape with messages queued still interrupts the turn rather than delivering them.
- `/context` does not close on Escape.
- Exit is not yet immediate.
- Continuity saving on a third-party provider is proven against a protocol fixture, not yet against a live provider on a slow route.
- Smart Prune remains experimental and off by default. This release makes no new quality, latency, or cost claim.

Verify each download with its matching `.sha256` asset. Full docs are in the [README](https://github.com/MasihMoafi/Elpis/blob/v0.3.0/readme.md).
