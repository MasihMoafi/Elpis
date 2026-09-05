# Upstream context-accounting evidence

Reviewed 2026-09-04 from single-commit shallow snapshots made with blob filtering and sparse
checkouts. The clones live outside Elpis at
`/home/masih/Desktop/p/elpis-upstreams-20260904/`.

## Sources

- OpenClaw `79930b846762b28f941b55f6568b1d66fa1e5961`:
  `src/auto-reply/reply/commands-context-report.ts` and
  `src/config/sessions/context-token-provenance.ts`.
- Gemini CLI `87a9c71d57a4ec56c00f3ff628970fea8291d812`:
  `packages/cli/src/ui/components/ContextUsageDisplay.tsx`,
  `packages/cli/src/ui/utils/contextUsage.ts`, and
  `integration-tests/context-compress-interactive.test.ts`.
- Hermes Agent `63279301bcbdc185c1b07b98a9312eb0c862f26d`:
  `agent/context_breakdown.py`.
- Claude Code `b3f0e501b79fe5cfc8c10d18cf3b0b6715c5c2fb`: the official repository
  publishes plugins, examples, scripts, documentation, and distribution material, but not the
  application source that implements `/context`. No implementation claim can be derived from it.

Official remotes:

- <https://github.com/openclaw/openclaw>
- <https://github.com/google-gemini/gemini-cli>
- <https://github.com/NousResearch/hermes-agent>
- <https://github.com/anthropics/claude-code>

## Findings

OpenClaw labels three different quantities instead of pretending they reconcile: a tracked prompt
estimate, cached actual context usage, and observed untracked provider/runtime overhead. It also
refuses to draw its context map until an actual run report exists. Its map separates user,
assistant, tool-result, summary, runtime-context, and model-only prompt contributions.

Gemini CLI's context percentage is simply provider `promptTokenCount / tokenLimit(model)`. It does
not provide the categorical decomposition Elpis needs. Its skipped compression integration test
explicitly records that omitting system instructions and tool counts makes the compression
comparison wrong, so that path is not a model for Elpis.

Hermes computes category values using character/JSON heuristics, computes `context_used` from a
provider-usage anchor when possible, but renders category cells and `Free space` against the model
window. The estimated categories and anchored occupancy are different measurement systems. That
presentation can therefore create a visually authoritative but false remainder.

## Elpis contract derived from the evidence

1. Active occupancy and request composition are separate scales.
2. Occupancy is labeled as the core context estimate and discloses that it may combine provider
   usage with locally estimated trailing items. The TUI does not infer provenance from aggregate
   token fields.
3. Composition classifies the outgoing request items, but its token counts are explicitly local
   estimates.
4. Category values sum only to the request estimate. They are never padded or assigned a synthetic
   `gap` so that they match occupancy.
5. User messages, agent messages, reasoning, tool calls, tool results, system instructions,
   developer messages, tool definitions/schema, and unrecognized items remain individually
   visible with color-independent markers.
6. A missing request snapshot renders as unavailable; it never fabricates a category.
