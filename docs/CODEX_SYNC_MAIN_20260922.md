# Re-importing Codex main (2026-09-22)

Supersedes `CODEX_SYNC_0_153_4.md`. That import targeted `rust-v0.153.4`, which was
published **2026-09-04** and was already three minor versions stale when it was taken on
2026-09-21 — latest stable was `rust-v0.155.1`, with `0.157.0-alpha` tags shipping daily.

- **Pinned base for this verification cycle:** official Codex `main` @
  `286d4ecf44b4e9daba0a9fdd229a4047b770a71a`.
- **Pure source drop:** `vendor/codex-main-286d4ecf`, commit `6d9f64aa`.
- **Integration branch/worktree:** `sync/codex-main-286d4ecf`,
  `/var/tmp/elpis-sync-latest`. Not installed; compilation and Elpis feature
  reintegration remain pending.
- **Fork point:** `f37fc774` (2026-07-15), unchanged.
- **Elpis tip:** `5d0f091a` plus the fixes since.

This pin is 29 commits beyond the previous `064e701b0` import, verified September 22
using official Git refs and GitHub's compare endpoint. The previous worktree
`/var/tmp/elpis-sync` remains intact; its useful 26-file unfinished patch was recovered
into the new tree as `f2d08119`. Official archive SHA256:
`a410396b4417a54d9057cff6df9dce288be83e90ef7dda778cfe3b63f20a7915`.
Do not chase changing upstream HEAD during this verification cycle or mistake a
source import for verified parity. Current execution/evidence lives in `TASKS.md`.
Only the Rust source was imported initially. `a2d144b3` restores `codex-rs/LICENSE`
and `NOTICE` byte-identically from the official archive, plus current provenance.
Current Elpis root product docs still need integration before shipping; the fresh
source-drop checkout's older root docs are not authoritative.

## The governing rule

> Where Codex already implements a behaviour, copy Codex exactly unless a requirement in
> this repository says otherwise.

Stated by Masih repeatedly; recorded in `GUIDE.md` ("UI changes must preserve Codex-quality
content, rendering, and interactions unless a separate behavior change is explicitly
approved") and in outcome **U20**. Elpis-only reimplementations of shared behaviour are
defects, not features. One was found and removed on 2026-09-22: the footer's
`Main · N subagents · /agent` counted every thread the session had ever tracked, so finished
subagents kept being advertised after `/agent` correctly reported none.

## What must stay deleted

Each of these was removed deliberately. Taking upstream as the base silently restores every
one of them, and the compiler cannot object — upstream code compiles perfectly with them back.

| Subsystem | Removed | Why |
| --- | --- | --- |
| `memories/read`, `memories/write`, `ext/memories`, memory citations, per-thread memory mode, the memories SQLite store and migrations, `[memories]` config, `Feature::MemoryTool`, `/memories` | 2026-08-05 | The promotion pipeline promoted nothing across every sweep from 08-01 to 08-02. Masih: "completely drop that shit." Replaced by `MEMORY.md` via the Context Ledger plus the opt-in Luna saver. Outcome **U7** forbids claiming an automatic pipeline exists. |
| `analytics` crate and its delivery path | 2026-07-25 | Was on by default upstream and POSTed to `{chatgpt_base_url}/codex/analytics-events/events`. Outcome **U4**: message content is not captured as telemetry. |
| `feedback` crate, `feedback/upload` RPC, app-server processors, TUI views, `[feedback]` config | 2026-07-25 | Carried a hardcoded Sentry DSN into OpenAI's project and a `FeedbackAudience::OpenAiEmployee` branch keyed on `@openai.com` addresses. |
| `cloud-tasks*`, the `codex cloud` subcommand, `realtime-webrtc`, `v8-poc` | 2026-07-25 | Unused product surface. `realtime-webrtc` is macOS-only WebRTC for OpenAI's Realtime API and is unrelated to the voice-commander work. |
| `tui/src/pets/`, `app/pets.rs`, `chatwidget/pets*.rs` | — | Not an Elpis surface. |

Relocations that came with the analytics deletion, which must survive:

- compaction enums → `core/src/compaction_kinds.rs` (they serialize into `X-Codex-Turn-Metadata`);
- guardian enums → `core/src/guardian/telemetry.rs` (OTEL metric tags).

Correction to an earlier note: `config.analytics_enabled` does **not** survive in Elpis. It
was still present on 2026-07-27 but is absent at `5d0f091a`; upstream's
`default_analytics_enabled: true` arguments in `startup_orchestration.rs` and
`cli/src/migrate_rollouts.rs` are re-imported debt, not something to preserve.

Scripted removal of analytics call sites failed three times and once silently deleted the
skill-loading loop in `core-skills/injection.rs`, because the analytics call sat after it.
The call-site pass is manual.

## What must stay, and is one line

These are cheap to lose and expensive to notice.

- **`OtelConfig::default().metrics_exporter = OtelExporterKind::None`** (`config/src/types.rs`).
  Upstream main still defaults this to `Statsig`, which `resolve_exporter` turns into a live
  OTLP POST to `https://ab.chatgpt.com/otlp/v1/metrics` with a baked-in client key — in
  **release builds only**, forced to `None` under `debug_assertions`, so local debug testing
  never reveals it. Disabling this default closes that particular automatic export
  path; it does not by itself prove the full no-upload boundary or account/app
  monitoring behavior. Verify all paths separately. Normal provider usage still counts.
- **`config_tests.rs::metrics_exporter_defaults_to_none_when_missing`** — the regression guard
  for the line above. It was **lost** in the 0.153.4 merge and must be restored.
- **`SlashCommand::is_visible`** allow-list (`tui/src/slash_command.rs`). Upstream is `_ => true`.
  `/agent`, `/multi-agents` and `/ide` are deliberately unhidden.
- **`ThreadSource::MemoryConsolidation`** stays as an inert variant so historical rollouts still
  deserialize. Do not clean it up while stripping memories.
- **No prompt Elpis sends names Codex** — base prompt, fallback prompt, model catalog,
  per-model templates. The agent is Elpis on whatever model supplies the weights.
- **Plugins are strictly user-added** (**U13**): nothing loads because it is bundled, listed by
  a marketplace, or enabled upstream.
- **Skills**: ordinary and bundled skills start off; `~/Desktop/p/skills/dev` is the
  development-rule source; the hand-picked set is `first-principles` and `experiment-workflow`.

## Crates ruled KEEP

`marketplace`, `responses-api-proxy`, `external-agent-migration`, `connectors`, `code-mode`
(Masih investigates V8 himself), `aws-auth` (Bedrock SigV4 under `model-provider`),
`windows-sandbox-rs` (publishes as `codex-windows-sandbox`; `tui` and `arg0` depend on it).
Grep by **package name**, not directory name — that mistake was made twice.

RAG is off-limits by instruction.

## Elpis's own features to re-attach

September 22 takeover amendment: Masih approved replacing the Luna/auxiliary saver
mentioned above with guarded local `save_memory` calls by the responding root agent.
The replacement passed focused checks and is installed locally, not yet user-accepted.
Reattach that approved behavior,
not automatic post-response or pre-compaction model consolidation. `/memory-model`
is a compatibility entry for the shared background setting used by pruning/naming;
memory itself uses the responding agent. Do not change those other model routes.

147 files added over the fork point: `tui/src` 48, `core/src` 25, `app-server-protocol` 25,
`agent-grep` 19, `core/tests` 6, `state` 4, `skills` 4, `app-server/src` 4, `prompts` 3,
`model-provider` 3, plus `backend-client`, `model-provider-info`, `core/templates`,
`app-server/tests`, `app-server-test-client`.

Named surfaces: Context Ledger, Smart Prune, `/dashboard`, the per-role model pickers
(`/model`, `/memory-model`, `/pruner-model` with live provider catalogs), `agent-grep`,
`elpis_context`, the eleven added providers, manual memory, and branding.

## Known blocker

`code-mode-runtime` enables `v8/v8_enable_sandbox`, and rusty_v8 **publishes no
`ptrcomp_sandbox` prebuilt** for `v150.4.0` — all 32 release assets are plain, `ptrcomp`, or
`simdutf`. Building that crate requires a from-source V8 build or a trusted matching
sandboxed archive. Do not weaken sandboxing to bypass the missing artifact.

September 22 scoped audit: the main CLI/core/app-server use the code-mode client
and protocol, not the V8 runtime. Package-scoped verification can proceed without
building the separate `codex-code-mode-host` helper. This is partial evidence only:
full code-mode packaging requires that helper. Missing-host ordinary CodeMode falls
back to direct tools; CodeModeOnly fails closed. No fresh-main build is yet proven.

## Verification

- September 22 recovery: `eb4ab181` restores the disabled metrics-exporter default
  and corresponding missing-config regression test in the migration branch. The
  root `scripts/check-codex-deletions.cjs /var/tmp/elpis-sync` source gate failed
  before and passes after this change. Rust execution and runtime network/privacy
  checks remain pending; existing uncommitted migration work was preserved.
- Per crate, cheapest first; never a whole-workspace build as the first check.
- `scripts/build-elpis-local` only, two jobs, `ELPIS_MAX_TEMP_C` under 80.
- The deletions above are verified by absence, not by compilation — a green build proves
  nothing about them. Check each one explicitly before calling the merge done.
