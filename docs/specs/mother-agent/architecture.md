# Architecture

Adapted from dsh-superagent `docs/007-architecture.md`. Paths below are under `apps/elpis-desktop`.

```text
Mother
├── bridge/router/mother-agent.mts       desktop lifecycle and selected source chat
├── bridge/router/app.mts                composition and shutdown
├── bridge/router/core/                  unchanged domain and Engine ports
├── bridge/router/policy.mts             authorization and assessment outcome
├── bridge/router/app/
│   ├── store*, migration*, versions     SQLite, upgrades and read queries
│   ├── assessment, cards, links         bounded candidate context
│   ├── prompts, context, skill-files    complete prompt set and versions
│   ├── tools/, resources               role tools and scoped reads
│   ├── settings, settings-history      guarded revisioned changes
│   ├── notices, passes, retry-health    ordered delivery and health
│   └── http, api, views/                local management contract
├── bridge/router/executor/              native sessions, slots and owned work
├── bridge/router/sources/               GitHub polling and Elpis chat
├── bridge/router/infra/                 commands, environment, lock and health
├── bridge/router/prompts/, skills/      packaged model-facing assets
└── components/mother/                   Elpis panel
```

The Engine is the sole domain writer. Store reads do not mutate records. Effects and receipts commit in the same transaction as the action that queued them. External work begins after commit. SourceContext restricts each kind's state, metadata and health writes.

Harness session delivery maps to executor/sessions.mts and adapters.mts: persistent logical-to-native identities, history receipts, validated dynamic tools, native transcripts and request cancellation. `tools/elpis-claude/app-server-connection.mjs` claims handled tool requests and declines unhandled approval requests.

Feishu live events/history/topic loops map to the selected Elpis chat's durable history cursor and serialized polling. Feishu reads and images map to elpis-chat-read.mts; outgoing messages map to elpis-chat-channel.mts. Feishu account setup and lark-specific CLI parsing are excluded. Legacy Feishu records remain migratable as stored data.

Reference service scripts, Cordis entry points, plugin-manager wiring and DSH presets map to Elpis bridge lifecycle, local routes and native session options. No second daemon or hosted panel is introduced. The module/test ledger identifies direct ports and boundary adaptations.
