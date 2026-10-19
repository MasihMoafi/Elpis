# T5 — provider/model pairs

Masih: “anthropic credits don't have sol!” A saved default provider can change while the shared app-server keeps its startup catalog. The desktop must not label that catalog as the new provider's models.

Acceptance:
- A configured API provider, including the current default, offers only its own reported catalog. Anthropic credits never inherits the engine's GPT choices.
- The selected provider accompanies the selected model when a new chat starts. OpenAI's engine catalog and subscription prefix routes keep their existing behavior.
- A new chat can still send using its configured API default without reselecting the model. Explicit model choices keep stable provider identities across default changes; removing a chosen connection blocks sending and keeps the draft.
- Catalog errors and empty catalogs remain empty; no other provider's models fill the gap. Catalog revision changes invalidate prior results.
- The API's explicit provider lookup honors managed policy and queries that provider even when it is now the configured default.
- Regressions fail on the old code. Check actual model-picker mouse/keyboard behavior in light/dark with loopback fixtures and no inference.

Boundary: the desktop's shared provider choices, catalog lookup and their existing composer/Talk/Canvas consumers; inspect TUI paths for the same fault. Do not guess a route from model spelling, relabel a native model as a subscription, rewrite saved threads, change credentials, or install.

Plan: prove the default/catalog mismatch; reuse the existing provider catalog path; run focused regressions and a private visual picker check. The coordinator integrates and installs.
