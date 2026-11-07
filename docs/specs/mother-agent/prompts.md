# Prompts

Adapted from dsh-superagent `docs/004-prompts.md`. [Prompts](../../../apps/elpis-desktop/bridge/router/app/prompts.mts) owns validation, assembly, immutable versions, preview, conflict detection and changed-default comparison. Assets live in [router/prompts](../../../apps/elpis-desktop/bridge/router/prompts).

The full reference set is present: shared, orchestrator, worker, subscriptions, replies, dispatch, work, admission, all handoffs, CLI guidance and the three team sections. Feishu transport instructions map to Elpis chat resources. Built-in Source skills are `mother-elpis-chat` and `mother-github`.

Assembly order is shared text, role, communication/scope/delivery, subscriptions/replies, dispatch or work, main-session admission, handoff, environment, then the main session's Policy. Inferred worker assignments add their matched-rule limits.

Team sections, team skills and built-in overrides are editable. Generated templates retain required placeholders. Each save records its base revision and origin; conflicting saves preserve the draft. Overrides retain their original default text for upgrade comparisons. Restoring defaults creates a new revision.

Native Elpis and Codex sessions register `dynamicTools` and serve `item/tool/call`. Claude receives the same tools through a private local MCP adapter. Both paths validate arguments, role scope, Ticket lifetime and cancellation. The adapter uses a per-session capability from the router database and has no provider credentials. The current Antigravity print-mode adapter ignores session MCP servers, so Mother refuses Gemini roles before opening a session; the regular Gemini chat adapter is unchanged. Mother needs an MCP-capable Antigravity adapter before that runtime can run these roles.

Each new turn supplies the current role prompt through collaboration mode developer instructions, preserving the session's current model, effort and mode. ACP reloads its existing provider conversation when this prompt changes. Native runtimes do not expose Harness's hook before every model step; a prompt edit during an active multi-step native turn takes effect at its next turn. The panel and tool history expose the saved revision. Shell isolation is installed when the session is created; managed command shims are refreshed by deployment checks.

Switching a native Mother session to Claude reconnects its role tools through MCP before the next turn. Logical session identity, history receipts and prompt versions stay with the existing session.

[resources.mts](../../../apps/elpis-desktop/bridge/router/app/resources.mts) enforces worker read scope. Long messages have explicit read pointers and pagination; the initial card is not the full request. Source text and tool output remain data, not permission.
