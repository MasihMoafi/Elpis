# Provider-Neutral Architecture & Model Adapters

Elpis maintains a **Provider-Neutral Architecture**: Elpis owns context admission, durable memory, session continuity, permissions, tool execution, and the TUI interface. The selected provider owns inference.

---

## 1. Systemic Architecture

```text
                               +-----------------------------+
                               |     ELPIS TUI / CONTROL     |
                               | (Context, Memory, Continuity)|
                               +--------------+--------------+
                                              |
                                              v
                               +--------------+--------------+
                               |  PROVIDER ADAPTER LAYER     |
                               |  (Canonical ResponseEvent)  |
                               +------+-------+-------+------+
                                      |       |       |
                 +--------------------+       |       +--------------------+
                 |                            |                            |
                 v                            v                            v
+----------------+------------+ +-------------+--------------+ +-----------+----------------+
| OpenAI Responses API        | | Anthropic Messages API     | | Gemini GenerateContent API   |
| Base: api.openai.com/v1     | | Base: api.anthropic.com/v1 | | Base: generativelanguage...  |
| Header: Authorization Bearer| | Header: x-api-key          | | Header: x-goog-api-key       |
+-----------------------------+ +----------------------------+ +----------------------------+
```

---

## 2. Supported Provider Routes & Protocols

| Provider ID | API Base URL | Credential Env Variable | Native Wire Protocol | Default Model |
| :--- | :--- | :--- | :--- | :--- |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` / OAuth | OpenAI Responses API | `gpt-5.4` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | OpenAI Responses Compatibility | `openai/gpt-5.4` |
| `anthropic` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | Anthropic Messages API | `claude-sonnet-4-6` |
| `google-gemini` | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY` | Gemini GenerateContent API | `gemini-3.5-flash` |
| `amazon-bedrock` | `https://bedrock-mantle.us-east-1.api.aws/openai/v1` | AWS credentials | OpenAI Responses API | `openai.gpt-5.*` model IDs |
| `ollama` | `http://localhost:11434/v1` | none | OpenAI Responses API | served locally |
| `lmstudio` | `http://localhost:1234/v1` | none | OpenAI Responses API | served locally |

`ollama` and `lmstudio` point at a local inference server, so no key is required and no request leaves the machine. Their port and base URL can be overridden with the experimental `CODEX_OSS_PORT` and `CODEX_OSS_BASE_URL` environment variables (`codex-rs/model-provider-info/src/lib.rs`).

---

## 3. Provider Wire Protocol Translation

Elpis translates canonical turn objects into vendor-native HTTP payloads and translates vendor stream chunks back into unified `ResponseEvent` streams (`codex-rs/core/src/chat_completions.rs`):

| Canonical Elpis Event | OpenAI Responses | Anthropic Messages | Gemini GenerateContent |
| :--- | :--- | :--- | :--- |
| **System Rules / Prompt** | `instructions` / `system` | `system` array | `systemInstruction` object |
| **User Message** | `user` role item | `user` role content block | `user` role `parts` |
| **Assistant Message** | `assistant` role item | `assistant` role content block | `model` role `parts` |
| **Tool Declaration** | `tools` JSON schema | `tools` JSON schema | `tools.functionDeclarations` |
| **Tool Call Output** | `function_call` item | `tool_use` block | `functionCall` part |
| **Tool Result Input** | `function_call_output` | `tool_result` block | `functionResponse` part |
| **Header Auth** | `Authorization: Bearer <key>` | `x-api-key: <key>` | `x-goog-api-key: <key>` |

---

## 4. Compatibility Launcher Aliases

`--provider` accepts ten values in total: the direct routes `openai`, `openrouter`, `anthropic`, `google-gemini`, `amazon-bedrock`, `ollama`, and `lmstudio`, plus three compatibility aliases that route through OpenRouter:

| Launcher Command | Actual Provider | Model Target | Description |
| :--- | :--- | :--- | :--- |
| `--provider anthropic` | `anthropic` | `claude-sonnet-4-6` | **Direct Native** Anthropic API routing |
| `--provider google-gemini` | `google-gemini` | `gemini-3.5-flash` | **Direct Native** Google Gemini API routing |
| `--provider claude` | `openrouter` | `~anthropic/claude-sonnet-latest` | OpenRouter compatibility route |
| `--provider gemini` | `openrouter` | `~google/gemini-pro-latest` | OpenRouter compatibility route |
| `--provider gemini-flash` | `openrouter` | `~google/gemini-flash-latest` | OpenRouter compatibility route |

---

## 5. Security & Authentication Isolation

1. **Credential Isolation:** Credentials are read strictly from their designated environment variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`). Native keys are never forwarded to OpenRouter or cross-contaminated.
2. **Provider Switch Mobility:** Switching providers (`/model`) changes the active inference engine, but **does not discard Elpis workspace context, GOAL.md, ES.md checkpoints, or memory state**.
