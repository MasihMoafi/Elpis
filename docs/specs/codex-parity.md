# Codex parity — accepted 9 October 2026

Goal: make Elpis as usable as Masih’s installed Codex 0.162.0 while retaining its useful additions.

## Accepted boundaries
- Use the exact Codex foundation and shared behavior: typing, streaming, animations, shortcuts, and shared layouts. Conflicting Elpis UI customizations yield to Codex.
- The agents page keeps Codex’s ordering and folder hierarchy AND Elpis’s model names.
- Keep Masih’s hand-selected slash commands exactly. Do not restore removed commands or add commands.
- Retain provider switching, Claude/Gemini, Context Ledger and controls, memory/continuity, pruning, dashboard, and work graphs. The dashboard is the dashboard, not a pruning dashboard.
- Full Access must actually apply across native, Claude and Gemini tools, including changes during a turn. Restricted modes must remain enforced, rejected updates must not grant access, and resumed permissions must match saved choices.
- Preserve all chats, settings and running sessions. Preserve existing privacy boundaries and explicitly removed optional features.
- Keep Codex and Elpis user configuration separate, including when started from the user's home. Codex's user config and symlink aliases must not become project layers or cause project-config warnings. Real project configuration and its restrictions must continue to apply.

## Acceptance evidence
- Compare against the installed Codex version, not only Elpis’s older 0.160.0 vendor snapshot.
- Exercise new and long chats, typing, streaming, queued messages, narrow/wide agents pages, folder ordering, model labels and the exact slash-command set.
- Exercise two ordinary launcher windows with one Elpis home and different project folders. Their agents views must share live sessions and later connections, reflect rename/archive changes, and open an existing running session without starting a duplicate execution loop. A fixture with two clients on one bridge is insufficient.
- Check permission promotion, revocation, rejected updates and resume across providers using actual runtime paths and failing controls.
- Run focused Rust checks, terminal interaction checks and visual checks on the exact candidate. Record failures and provider limitations plainly.
- Test final installed paths, retain a rollback copy, and give Masih a short user check. Automated evidence is not Masih’s acceptance.

## Shared-session implementation
One bridge serves an Elpis home; its ordinary terminal connections use one native app-server. Delegate connections retain private engines so a failed helper restriction can stop that helper. Provider turns retain one owner inside the bridge; other terminals subscribe and route requests to it. The bridge exits after all clients and active work are gone, without boot startup. A new installation must not silently reuse an incompatible running bridge.

Checks must cover late attachment, owner disconnect, provider continuation/interruption, request-id collisions, approval routing to the parent chat, shared-engine failure, real cold restarts, and launcher races. Preserve existing terminals during installation; activate only a tested immutable bundle, with the existing rollback script.

## Authorization and limits
Local implementation, tests, commits and installation are authorized. GitHub Actions is authorized for parallel verification; use only a scoped validation branch if a push is required, with no release/deployment steps. No main push, tags, publication, history/config deletion, or session restart.
Claude workers: Sonnet high/xhigh, Opus for harder tasks. No Fable. One owner per file and one local compiler. Repair and test the thermal guard before compilation; pause early and stop at the configured limit below 80°C. Check disk space before builds.
