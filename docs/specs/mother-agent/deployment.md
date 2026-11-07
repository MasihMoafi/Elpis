# Deployment

Build the renderer and provider bridge assets from the same candidate. The desktop packages its connection helper through `bridge/build-resources.mts`; Claude also needs the current `tools/elpis-claude` runtime bundle for turn prompts, scoped MCP tools and shell settings. Installing or restarting the user's app remains a separate release action.

Adapted from dsh-superagent `docs/006-deployment.md`. Mother is part of the desktop bridge; it needs no separate public server, Harness profile, Feishu bot or token file.

Enable Mother in Settings → Configuration. Routing and worker models initially inherit the configured background model, then the main model. The panel's Eval and Execution settings can select their roles. Native sessions retain the model selected at creation.

Mother's lifecycle switch and source-chat binding live in `<ELPIS_HOME>/router/mother.json`. Revisioned domain settings, prompt history, native worker bindings, Triggers, Tickets, effects and receipts share `router/orchestrator.sqlite`. Legacy `router/settings.json` seeds the first database revision. A profile lock is acquired before database opening or migration.

GitHub uses the existing `gh` executable and its signed-in account. Set the repository and allowed people in Mother Settings; choose repository-wide Issues, pull requests, comments and default-branch CI reception there. The watcher uses polling, ETags, since cursors, per-item failures and bounded retry history. Every host, shim and credential-helper GitHub invocation removes proxy variables and ambient token overrides. No new credential is stored by Mother.

A GitHub setup problem is visible on the panel and pauses GitHub intake. The local Mother chat remains available. Check again reruns setup after an external authentication fix. Worker preparation and blocked commands are panel-only settings. Environment setup uses per-child configuration, without changing the desktop bridge's global environment.

Turning Mother off stops its own turns, workers and background loops, preserving unfinished work and history. Restart recovery reuses native session bindings and durable receipts. Unknown native creation outcomes require inspecting and binding the existing session.

The package closure is declared in [desktop/package.mts](../../../apps/elpis-desktop/desktop/package.mts), including prompt/skill assets and the MIT notice. No production install is part of this port.
