# SPEC: Settings

Status: draft (10 Nov), measured against the ChatGPT desktop app and the Claude desktop app. Every item is `todo` until its
check has passed on the installed app at Masih's window size (1100×750) and at 1280×1000.

Goal: Settings reads and works like the two reference apps: a calm list of pages, each a few titled groups of rows, every
control on the right and every control working.

Whole-app rules stay in [ui-behaviour.md](ui-behaviour.md); feature requirements in [SPEC.md](../SPEC.md) items 73–80.

## Reference, measured

| | ChatGPT app | Claude app | Elpis now |
| --- | --- | --- | --- |
| Frame | full page, nav column 290px | modal dialog, nav column 210px | full page, nav column 380px |
| Nav title | "Settings" 18px/600, 16px to Search | "Settings" in the dialog bar | 14px/500, touching Back and Search |
| Search | pill, 43px tall | 28px field | row-height field |
| Nav groups | grey sentence-case heading 14px/500, one row tall, 12px extra above | hairline divider, no heading | spaced capitals, no room above |
| Nav rows | icon + label 14px, 37px pitch | icon + label 14px, 33px pitch | icon + label, 34px pitch |
| Page | title, then groups: plain 14px/500 heading, one rounded card of rows | section title, rows with hairlines, no card | page title, a card per item |
| Row | title 13px/500, grey description 12px, control right, hairline between | title 14px, grey description, control right, hairline | title, description, buttons below the text in some cards |
| Status | none on rows; state shown by the control | none | status badge per card ("Connected", "Reading…") |

## Items

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| S1 | The nav title is 18px/600 with at least 8px above and below it at every window height. | Measure Back, title, Search at heights 600–1300: gaps ≥ 8px (test: settings-nav-whole-rows). | todo |
| S2 | Nav group headings are grey, sentence case, one row tall, with 12px extra above. | Measure each heading: case as written, gap to the row above ≥ 12px. | todo |
| S3 | Every row puts its control on the right, vertically centred; text never sits above a lone button. | On every page, each row's control box is right-aligned within the row. | todo |
| S4 | Rows of one group share one container with hairlines between them; no card per item. | Count containers per group: one. | todo |
| S5 | A page never waits silently: content or a loading line appears within 300 ms; a failure says what failed once. | Throttle the bridge: Import chats shows "Reading…" then counts or one error. | todo |
| S6 | Every enabled control works now; a control that cannot is hidden, not shown greyed with no reason. | Click each enabled control: it acts. Disabled ones show why. | todo |
| S7 | No CloudRoom VM anywhere in Settings or the app. | No "CloudRoom" text in the app. | todo |
| S8 | Search filters the nav and the visible rows by title and description. | Type "voice": only matching pages and rows remain. | todo |
| S9 | Page width and text measure follow the content-width token; long paths ellipsize in the middle. | A 120-character path fits its row without wrapping the control. | todo |

Non-goals: Claude's modal frame (Elpis keeps the full page, as ChatGPT); new settings.

Stop and ask: removing a working setting; changing the cut-corner card look or the accent tick (an approved identity).
