# SPEC: Chat scrolling

Status: draft (10 Nov), measured in the ChatGPT desktop app. The Claude app's chats did not open in the hidden copy (cloud
sessions), so it is not yet a reference here. Every item is `todo` until its check passes on the installed app.

Goal: reading a chat never fights the reader: the newest message stays in view while the reader is at the bottom, and
nothing moves while they read anywhere else.

Whole-app rules: [ui-behaviour.md](ui-behaviour.md) items 8–10.

## Reference, measured (ChatGPT app)

| | ChatGPT | Elpis now |
| --- | --- | --- |
| Pinning to the newest message | the browser's own: the transcript is laid out bottom-up (`flex-direction: column-reverse`), so growth below keeps the view in place without script | script: `scrollTo(scrollHeight)` on every resize while "stuck" (`lib/use-transcript-presentation.ts`), plus 80px "at bottom" slack |
| Scroll anchoring | `overflow-anchor: none` (the reverse layout does the job) | browser default plus manual offset fixes when earlier messages load |
| Scrollbar | thin, `scrollbar-gutter: stable both-edges` | 8px, `scrollbar-gutter: stable` |
| Jump to latest | a 38px round "Scroll to bottom" button centred above the composer; opacity 0 and no pointer events at the bottom, fades in once scrolled up | an "away from bottom" button |
| Composer | floats over the transcript; text fades out beneath it | sits below the transcript |
| Opening a chat | at the newest message | at the newest message, or the saved position |

## Items

| # | Item | Acceptance check | Status |
| --- | --- | --- | --- |
| C1 | At the bottom, a streaming reply keeps its last line in view with no visible jump or jitter. | Record 5 s of streaming at 60 fps: the last line's bottom edge moves only with the text, never back. | todo |
| C2 | Scrolled up even one line, nothing moves: streaming, tool rows opening, images loading. | Scroll up 40px during streaming; the first visible message's top stays within 1px for 10 s. | todo |
| C3 | Loading earlier messages keeps the message under the reader in place. | Scroll to the top, load more: the previously first message keeps its screen position (±1px). | todo |
| C4 | "Scroll to bottom" is one round button centred above the composer; hidden at the bottom, shown once scrolled up more than one screen-third; click returns to the bottom smoothly and re-pins. | Measure its box and visibility at bottom, at −300px; click: at bottom and C1 holds. | todo |
| C5 | Opening a chat shows the newest message; returning to a chat restores where the reader was. | Open, scroll up, switch away and back: same first visible message. | todo |
| C6 | Wheel and keyboard scroll at the platform's speed; PageUp/PageDown move one screen less one line; Home/End reach the ends. | Key presses move by clientHeight − line height. | todo |
| C7 | The scrollbar is thin and reserves its gutter, so text never shifts when it appears. | Message left edge equal with a short and a long chat. | todo |
| C8 | Sending a message pins to the bottom, wherever the reader was. | Scroll up, send: the new message is in view and C1 holds. | todo |

Plan: move pinning to the browser (bottom-up layout as ChatGPT, or `overflow-anchor` on a bottom sentinel), delete the
resize-driven `scrollTo`, then rerun C1–C8. Load-earlier, prompt rail, find-in-chat and saved positions depend on the
scroll direction and must each be checked.

Stop and ask: a change would drop saved reading positions; the prompt rail cannot follow a reversed layout.
