# Desktop clarity and Love Spot — 20 October 2026

The desktop should make an agent's origin, activity and context visible. The user reported a failed fork (`ed738df0-2560-4d1f-b23e-567eeb369e14`, request `f45af18c-11c8-4107-909d-a9b691955087`), requested GPT-6.1 Sol / extra-high by default, Send amber throughout light mode, and removal of the extra startup ribbon.

Love Spot requests: identify its agent chats; use its standalone icon's red palette while visiting; notify on agent replies; larger canvas artwork; connecting an agent to an image/task supplies that context; sections restrict access; plain connections permit mutual communication and arrows express supervision. Workflows should list existing workflows. Recents should be readable and distinguish agent chats.

## Acceptance

- New conversations default to `gpt-6.1-sol` / `xhigh` / `openai` (user configuration, preserve existing chats).
- Startup retains the rotating Elpis symbol without the sweeping ribbon; reduced motion remains supported.
- Default light accents and logo use Send amber `#f2a93b`; small text uses darker amber for contrast. Preserve selectable palettes.
- Love Spot navigation and chat labels identify origin; a completed reply while elsewhere lights its navigation indicator, cleared by visiting. Its workspace uses the standalone red palette.
- Existing agents get larger artwork without replacing custom user art.
- Workflows expose persisted runs, status and their chats. Recents separate Love Spot and Workflows runs from ordinary conversations, preserving search, pins and custom sections.
- Forking preserves the selected message boundary. Never recover an unknown turn by silently copying later messages. Reproduce the cause before changing runtime behavior.
- Positive and negative checks exercise origin, unread transitions, context scope and edge direction; screenshots check both themes and fit.

## Pending user choices

Own-section contents plus explicit connections, or explicit connections only? Does a new task connection run immediately or wait for a message? Do not implement dependent access/spending changes before the user answers.

## Constraints and plan

Reuse board persistence, ACP, navigation and permissions. No new services/dependencies. Isolate from other desktop work; preserve running chats and custom artwork. No publication or recording of private chats.

1. Verify defaults and reproduce fork failure.
2. Remove ribbon; apply amber and Love Spot red; improve origin labels and unread state.
3. Show persisted workflows and organize Recents.
4. Implement approved connection/context/access semantics through scene and ACP, with limits and behavioral evidence.
5. Build, test, visually inspect, package locally and report user acceptance separately.

## Evidence and remaining work

Implemented locally: user default config `gpt-6.1-sol`/`xhigh`; splash ribbon removal; amber light logo/fills and contrast-safe accent text; Love Spot red workspace/tools, reply badge, origin labels and separate chat groups; enlarged preset canvas portraits; saved ACP and recent native workflows; exact-message recovery for stale fork IDs. Recovery is covered with missing-message rejection, but the user's original source-chat retry is still needed.

Checks: production renderer builds; fast gate passes (192 tests); protocol, workflow, activity, inventory and packaging checks pass (139 tests); six focused UI files pass (33 tests). Visual review caught remaining purple canvas container colors; these were corrected and the visible-color check was added. Screenshots: `~/.cache/elpis-tests/love-clarity/`. No running chats have been terminated.

Pending: automatic connected-item execution, section access policy, peer/supervisor communication semantics, and which pictured composer control is unwanted. The clarification questions remain unanswered. Website refresh and real action recordings follow the desktop work.
