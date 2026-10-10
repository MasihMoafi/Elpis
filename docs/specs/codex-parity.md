# Codex parity — accepted 9 October 2026

Goal: make Elpis as usable as Masih’s installed Codex 0.162.0 while retaining its useful additions.

## Accepted boundaries
- Use the exact Codex foundation and shared behavior: typing, streaming, animations, shortcuts, and shared layouts. Conflicting Elpis UI customizations yield to Codex.
- The agents page keeps Codex’s ordering and folder hierarchy AND Elpis’s model names.
- October 9 visual refinement: use colored circles for context categories, align the Ledger usage bar with its text, and show “Elpising” in the recorded Deus Ex gold instead of “Working,” preserving native animation timing.
- October 10 refinement: make category colors lighter and distinct, with recognizable orange/yellow and lighter green while retaining the red. Keep category labels and counts readable. “Elpising” uses lighter Deus Ex gold with the exact Codex shimmer, including its brightness wave and font weight; change only the foreground color. Tool results already have the correct separate section. Keep Tab’s Codex behavior and Alt+C Ledger focus.
- October 10 shortcut correction: Shift+Tab changes permissions with visible feedback. The first uncached press opens the existing permissions picker; subsequent presses cycle through the server-allowed modes, including the existing Full Access confirmation. Cancelling it preserves restrictions. Permission changes must reach actual tools, including during active work. Modal dialogs retain keyboard ownership. Bare `/plan` toggles Plan separately; `/plan <task>` still enters Plan. This is an explicit exception to shared Codex shortcuts.
- Generated session names must be visible in the default footer at 80 columns even beside a long project path; show the name before the directory.
- October 10 Ledger shortcut addition: Ctrl+X opens/focuses or hides the Ledger in ordinary text chat, preserving the draft during idle and active turns. Keep Alt+C. Voice mute, modal/completion ownership and explicit custom shortcuts/chords take precedence. Tab and Enter retain their current behavior. Verify with a failing installed-runtime control and passing candidate terminal and Rust checks before installation.
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
- Exercise real terminal Shift+Tab input, its visible feedback, Full Access cancellation and acceptance, saved thread settings, and a command that requires the selected access. A footer-only change does not establish permission correctness.
- Run focused Rust checks, terminal interaction checks and visual checks on the exact candidate. Record failures and provider limitations plainly.
- Test final installed paths, retain a rollback copy, and give Masih a short user check. Automated evidence is not Masih’s acceptance.

## Shared-session implementation
One bridge serves an Elpis home; its ordinary terminal connections use one native app-server. Delegate connections retain private engines so a failed helper restriction can stop that helper. Provider turns retain one owner inside the bridge; other terminals subscribe and route requests to it. The bridge exits after all clients and active work are gone, without boot startup. A new installation must not silently reuse an incompatible running bridge.

Checks must cover late attachment, owner disconnect, provider continuation/interruption, request-id collisions, approval routing to the parent chat, shared-engine failure, real cold restarts, and launcher races. Preserve existing terminals during installation; activate only a tested immutable bundle, with the existing rollback script.

## Authorization and limits
Local implementation, tests, commits and installation are authorized. GitHub Actions is authorized for parallel verification; use only a scoped validation branch if a push is required, with no release/deployment steps. No main push, tags, publication, history/config deletion, or session restart.
Claude workers: Sonnet high/xhigh, Opus for harder tasks. No Fable. One owner per file and one local compiler. Repair and test the thermal guard before compilation; pause early and stop at the configured limit below 80°C. Check disk space before builds.
