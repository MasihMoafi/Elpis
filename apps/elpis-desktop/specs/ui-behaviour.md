# SPEC: How the Elpis interface behaves

Status: draft, not yet approved by Masih. Every item is `todo` until its check has been run on the installed app.

Goal: one place that says how Elpis looks and acts as a whole, so a screen can be judged right or wrong without asking.

This file adds only what the others do not say. Generic rules live in [UI-RULES](../../../../skills/web-dev/UI-RULES.md) and
[APP_BASELINE](../../../../skills/dev/APP_BASELINE.md); per-feature requirements in [SPEC.md](../SPEC.md); chat typography in
[chatgpt-chat-style.md](chatgpt-chat-style.md).

Invariants:

- One kind of thing has one look and one behaviour everywhere. A new look needs a reason in this file.
- Sizes, spacing, radii and colours come from the token block in `app/styles/foundation.css`. No component sets its own.
- A control appears only when it can do something now.
- Nothing moves under the pointer. Status changes, hover and streaming never shift a row or a button.
- Every chat belongs to one place: the Elpis tab shows only Elpis's chat, and an agent's chat shows only in its own place.

Constraints: shadcn/ui controls, Lucide icons, the existing theme.

## Shell

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| 1 | The window never scrolls; only the sidebar list, transcript and side panel do. | At 800×600, 1280×800 and 2560×1440, `document.scrollingElement` has no overflow. | todo |
| 2 | Sidebar, tab bar and side panel keep their width when content changes. | Open a long chat, a working chat and an empty chat: the three widths do not change. | todo |
| 3 | The page title, tab bar and content share one left edge on every page. | Measure the left edge on each sidebar page: all equal. | todo |

## Sidebar

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| 4 | Sections are Projects, Pinned, Recents, plus Workflows and background runs when switched on. There are no Groups. | No "Groups" text or "Move to group" item anywhere. | todo |
| 5 | Every row in every section has the same height, icon column and text edge at every nesting level's own indent. | Measure rows across sections: same height; icon and text columns differ only by the indent step. | todo |
| 6 | A section with nothing in it is not shown. | Empty the section: heading is gone. | todo |
| 7 | Row actions appear on hover over the row and take no space when hidden. | Row text width is the same hovered or not. | todo |

## Chat

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| 8 | The transcript and composer share one column, centred, at the width Settings sets. | Left and right edges of messages and composer are equal at each setting. | todo |
| 9 | A new reply keeps the reader at the bottom only if they were already there. | Scroll up during streaming: the view does not move. | todo |
| 10 | The composer keeps its size and place through send, stream, stop, disconnect and reconnect. | Measure it in each state: same box. | todo |
| 11 | Every message gets an answer in a direct chat, including the Elpis tab. | Send "nice weather today": a reply appears. | todo |

## Controls

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| 12 | Controls come in the token sizes only, and paired controls have equal height. | `ui-check` finds no other control height. | todo |
| 13 | A choice from a known set is a menu, in the same place in every screen that offers it. | Model, provider and effort use the same control everywhere. | todo |
| 14 | One action has one name and one icon everywhere. | List labels for delete, move, open and copy: one each. | todo |
| 15 | A menu holds only actions that work now; it is never a list with one option. | Open each menu: no disabled-only or single-choice list. | todo |

## Dialogs, notices and errors

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| 16 | A dialog has one primary action on the right; Escape closes it without saving. | Open each dialog and press Escape: nothing changed. | todo |
| 17 | A failed action stays visibly undone and says what to do once, near where it happened. | Force a failed save: state unchanged, one message. | todo |
| 18 | Notices fade on their own and never need dismissing. | Trigger one and wait: it leaves. | todo |

## Loading and empty states

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| 19 | Content loading keeps the final layout, with no jump when it arrives. | Throttle the bridge: positions before and after match. | todo |
| 20 | An empty page says the one thing to do next. | Open each page with no data. | todo |

## Agents and workflows

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| 21 | The router's chat appears only in the Elpis tab; a worker's chat appears only under its ticket or in the Agents panel. | After a real ticket, neither is in Recents. | todo |
| 22 | A running agent shows one status in one place per surface. | Run a workflow: sidebar, tab and board agree. | todo |
| 23 | A workflow can be started, stopped and resumed from one place without opening another page. | Do all three from the board. | todo |

Non-goals: new features, a new visual identity, Love Spot's board, which follows Excalidraw.

Stop and ask: a fix would remove a feature; two items conflict; a check needs a look Masih has approved to change.

## Decisions (Masih, 9 Nov)

1. A chat that starts working does not move in Recents while the pointer is on the list.
2. The side panel opens only when asked.
3. The main gap in Workflows is control: one router chat should run the sessions so Masih does not have to.
