Elpis is a terminal environment for coding agents. The agent runs the model loop;
Elpis owns context, memory, continuity, retrieval, permissions, and provider choice.

**Install** (Linux x86_64):

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/main/scripts/install-elpis.sh | bash && ~/.local/bin/elpis
```

Already running Elpis? Use `elpis --update`.

**What's new since 0.2.0**

- **Providers speak for themselves** — every model picker asks the provider which models it serves, with the context window and price the provider reports, instead of reading a table written into Elpis. Pick the provider first, then its models. Paste an API key in the terminal or the dashboard; the key is masked as you type.
- **Thinking effort beyond OpenAI** — any provider that accepts a reasoning level offers one, so a DeepSeek or OpenRouter model can be set to think longer.
- **Memory and pruning are separate jobs** — `/memory-model` and `/pruner-model` choose them independently, and background work no longer borrows the model you are talking to.
- **Continuity saving got out of the way** — a turn now ends when the model stops speaking rather than when maintenance finishes, so the next message is a message and not an interruption. Saves that overlap each other settle quietly instead of warning.
- **The Context Ledger turns subagents off** — press `s` to stop the model delegating, alongside Smart Prune. Escape closes the ledger, and the row under the cursor is the only row marked.
- **`/usage` draws the token activity chart again**, with daily, weekly, and cumulative views.
- **`/yolo` sticks** — Full Access survives into the next session.
- **Long conversations stay responsive** — typing and queueing keep up in a long chat, and the context count holds its last provider-reported figure instead of jumping to an estimate the moment you press Enter.
- **Terminal selection survives an active response** — drag-select and copy while Elpis is still answering.
- **A backslash before Enter starts a new line** instead of sending.

**Known limits**

- Linux x86_64 only. The installer refuses macOS with an explanation rather than fetching a binary that does not exist; Windows remains out of scope.
- Escape with messages queued still interrupts the turn rather than delivering them.
- `/context` does not close on Escape.
- Exit is not yet immediate.
- Continuity saving on a third-party provider has been corrected but not yet observed end to end on a slow route.

Verify each download with its matching `.sha256` asset. Full docs are in the [README](https://github.com/MasihMoafi/Elpis#readme).
