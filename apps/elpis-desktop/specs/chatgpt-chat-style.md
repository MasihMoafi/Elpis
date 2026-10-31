# ChatGPT desktop (Codex view) chat thread: style spec

Sources: `/tmp/cgpt/webview/assets/*.css` (`app-shared-3424…`, `app-initial-e55c…`, `user-message-f152…`, `floating-navigation-rail-layout-17bd…`), JS from `app.asar` (`thread-scroll-layout`, `user-message`, `collapsed-turn-disclosure`, `thread-user-message-navigation-rail-app`, `app-initial` theme code), screenshots S1/S2/S3 (`19-55-37/41/44.png`).
**Scale:** 1 CSS px = 1.5 physical px (rail pitch 10 CSS = 15 px; a 6 px dash = 9 px). In a 2000-wide view, 1 view px = 0.81 CSS px. The app runs as `data-codex-window-type=electron`: rail preview text is 13 px with 21 px lines, and the column is 736 px. All values are CSS px, light theme. "meas." means measured in a screenshot.

## Theme tokens (generated at runtime, `app-initial` `_2i`/`y2i`; electron defaults `Vq`)
| Token | Light | Dark | Note |
|---|---|---|---|
| ink / `--color-text` | `#1a1c1f` | `#ffffff` | meas. darkest glyph `#171717` |
| surface `--color-surface` | `#ffffff` | `#181818` | meas. `#fff` |
| surface-under (window, sidebar) | mix(surface, ink, 4%) ≈ `#f6f6f6` | — | meas. `#f6f6f6` |
| text secondary | ink @ 69.5% | ink @ 71% | contrast 0.45 / 0.60 |
| text tertiary = `--color-codex-description` | ink @ 49.5% ≈ `#8e8f90` | ink @ 49.8% | meas. `#8f8f8f` |
| `--color-border` | ink @ 7.8% ≈ `#ededed` | ink @ 8.4% | meas. hairline `#eeeeee` |
| `--color-border-strong` / light | ink @ 11.7% / 4.9% | 15.6% / — | |
| `--shadow-xl` | `0 8px 16px -4px #0000001f` | same | `app-shared` |

## Thread column and edges
| Item | Value | Source |
|---|---|---|
| Body width | `max-w: --thread-body-max-width` = 48rem (768) + 2×inline-pad (0 on electron); `px-toolbar` 16 → **text column 736** | `app-shared` `:is(...electron) body`, `LSr` in `app-initial` JS; meas. 736 |
| Column x | centred in the pane; meas. left edge 429 from pane left | S1 |
| Top inset | scroller `pt-(--thread-content-top-inset)` = **32** (`_MainContentViewport`); 52+32 when the header overlays content | `app-initial` |
| **Top edge** | `_MainContentTopFade` (abs, top 0, z-20) + `_background_18gud_1`: **16 px** `linear-gradient(to bottom, surface, transparent)`; hidden in browser windows. Page-surface variant: 40 px, stops surface → 82% @4 → 48% @12 → 12% @24 → 0 | `app-initial`, `app-shared`; S1 shows a wash over about 16 px |
| Bottom of transcript | `pb-8` (32) + sticky spacer `h = --thread-scroll-padding-bottom − 16` | `thread-scroll-layout` JS |
| **Bottom edge** | spacer holds a fade: `absolute -top-8 h-8 bg-gradient-to-t from-surface` (**32 px**, surface → transparent upward) ending at the composer top; below it the footer has a solid `bg-surface` | `thread-scroll-layout` + `PSr`; meas. a black bubble washes to 24% at 8 px above the composer, so the fade covers exactly the 32 px above it |
| Make top = bottom | Use a 32 px surface→transparent gradient under the header, the same as above the composer | recommendation |
| Generic mask | `.vertical-scroll-fade-mask`: oklch gradient; `--top/--bottom-fade` driven by `animation-timeline: scroll(self y)`, so each fade shows only when there is content beyond that edge (`--edge-fade-distance`, default 1rem) | `app-shared` |

## User bubble (`user-message` JS + `user-message-f152….css`)
| Item | Value |
|---|---|
| Classes | `bg-user-message text-user-message max-w-(--user-chat-width) px-(--thread-content-margin) py-2.5 rounded-2xl`; right-aligned (`justify-self-end`) |
| Max width | `--user-chat-width: 70%` of the column (515) |
| Padding | 10 top/bottom, 16 sides (`--thread-content-margin: spacing*4`) |
| Radius | `--radius-2xl: spacing*5.5` = **22** (`--message-bubble-radius: 22px` on `.messaging-root`) |
| Colours | default: bg `color-mix(oklab, text 5%, transparent)`, text = text. ChatGPT accent **black** (as in the screenshots): light bg `#000000` / text `#ffffff`; dark bg `rgb(50 50 50 / 85%)` / text `#fff`. Default accent: light `rgb(233 233 233 / 50%)` / `#0d0d0d` |
| Text | 14 / 22.75 (markdown, same as the reply); meas. heights 42.7 / 65.3 / 88 for 1/2/3 lines |
| Gaps (meas.) | consecutive user bubbles in one turn 16–17 (one 21); attachment → bubble 8; bubble bottom → "Worked for" text top ≈ 50 (includes a hidden 26–30 px action row; inferred) |

## Assistant reply (`_MarkdownRoot_lyk9f_2`, `app-initial`)
| Item | Value |
|---|---|
| Font | `--font-content` = `--codex-content-font-family` or the sans stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`). The screenshots show a serif, a user font setting (family unknown) |
| Size / line | `--codex-chat-font-size` = `--font-ui-size` = text-base **14** (electron); line = 14×1.625 = **22.75**; meas. 34 phys px = 22.7 |
| Paragraph gap | P+P `margin-block: 4×(--markdown-space = fs/4)` = **14**; meas. pitch 37 |
| Headings | semibold; h1 1.5em, line 8×space, margins 4×space / 2×space; h2 1.25em; h3 1.125em |
| Inline code | `bg: color-mix(primary-ghost-hover 60%, text 6%)`, radius 6, padding 1px 6px, mono at 0.92em; meas. bg `#eaeaea` |
| Links | `_DecoratedExternalLink`: inherit colour, dotted tertiary underline 1px, offset 2; hover `--color-text-info`. File links meas. blue ≈ `#2857a2` with a file icon (token unverified) |
| Text colour | `--color-text`; mono `ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` |

## "Worked for …" row (`collapsed-turn-disclosure` JS)
| Item | Value |
|---|---|
| Row | `text-size-chat text-secondary` wrapper > ghostTertiary inline button: **14 px**, tertiary colour (meas. `#8f8f8f`) |
| Chevron | `icon-2xs` = 14 px (`--icon-secondary-size`), `rotate-0` collapsed / `rotate-90` open, `duration-basic` |
| Hairline | next sibling `pt-1` > `w-full border-t border-default` (1 px `--color-border`, full column) |
| Spacing (meas.) | text centre → hairline 15.5; hairline → first reply line-box top ≈ 18 |

## Reply action icons
| Item | Value |
|---|---|
| Button | Button `size=icon`: electron `p-1` + svg `icon-sm` 18 → **26** square, `rounded-md`, ghost, `text-tertiary`, hover `bg-primary-ghost-hover` + `text-default` |
| Row | `turn-action-controls flex items-center gap-0.5` (2); meas. pitch 27, glyph ≈ 13, colour `#8e8e8e`, first glyph 3 px right of the text edge |
| Offset (meas.) | last line-box bottom → icon centre 20; icon row bottom → composer top ≈ 44 at max scroll |
| Turn to turn (meas.) | last reply line box → next user bubble 44 (inferred: a 26–28 px action row plus about 16) ; items inside a turn use `flex flex-col gap-3` (12). Source of the gap between turns: unknown |

## Prompt rail (`thread-user-message-navigation-rail-app`, `floating-navigation-rail-layout` CSS)

Elpis keeps the rail in a 28px target within the existing 32px gutter, so showing it does not resize the transcript.
| Item | Value |
|---|---|
| Shown | only with **≥ 4** user messages |
| Position | `nav absolute top-1/2 -translate-y-1/2 left-3 electron:left-4`, so **16 from the pane's left edge**, not from the column; vertically centred on the thread viewport (header bottom → window bottom). S1: centre y = pane midpoint |
| Slot | button `h-2.5 w-9` = **10 tall × 36 wide**, fixed pitch 10; inner `flex h-0.5 w-[30px]` |
| Dash | `_Marker`: 26 wide box, **2 px** thick (`spacing*.5`), left-aligned; line `scaleX(.2308+.7692·p)`, so the resting width is **6 px** |
| Colour | rest: `--color-codex-description` (tertiary) @ opacity .4 (meas. `#d2d2d2`); in view (`aria-current`): `--color-text` @ .6 (meas. `#747474`); hover/focus: text @ 1, width 26 |
| Neighbours (hover/scrub) | ±1 p=.7 → 20 px, ±2 p=.4 → 14, ±3 p=.2 → 10 (meas. 20/14/10); 0.16 s spring `linear(...)`; while the rail is hovered, the in-view dashes return to rest |
| Height | n × 10; list `max-h: min(70vh, 40rem)`, scrolls with `vertical-scroll-fade-mask --edge-fade-distance: 2.5rem`; chunks of 64 |
| Bookmark | `size-0.5` dot after the line; bookmarked marker at opacity 1 |
| Hover card | Tooltip `side=right align=center sideOffset=0`, so its left edge = rail button's right edge (pane +52; meas. 51.3); centred on the dash. `w-80` **320**, `rounded-xl` **12**, `p-2` **8**, `bg-surface-elevated-secondary` (meas. `#fff`), `ring-[0.5px] ring-border`, `shadow-xl-spread` = 0 0 0 .5px border + `0 8px 16px -4px #0000001f`; meas. 320×107 |
| Card text | title row `font-medium`, truncated, `text-sm leading-5` (13/20), bookmark ghost button at the right; preview markdown `mt-1 line-clamp-3`, 13 px, line 21, tertiary colour; outputs row `mt-2 gap-3` tertiary |

## Composer (meas. S2 unless stated)
| Item | Value |
|---|---|
| Width | column width: 736 + about 1 px ring per side (meas. 738) |
| Radius | `--composer-radius: spacing*5.5` = **22** (meas. ≈22) |
| Surface | `--color-surface-elevated-secondary` (meas. `#fff`); shadow `--elevation-composer`: `0 0 0 1px #0000000a, 0 2px 8px #0000000a, 0 4px 40px 8px #00000006`; dark `inset 0 0 1px #fff3` |
| Height | ≈ 99 at one line (placeholder line centre 25 from top; control row centre 76 from top) |
| Placeholder | tertiary × `--opacity-composer-placeholder .5` (meas. `#c7c7c7`), 14 px, about 14 from the left edge |
| Controls | `+` centre x 23; "Approve for me" (shield + text, tertiary) starts at 69; model label text default + effort word in purple (meas. `#a100f8`) + chevron; mic centre 36 left of send; send **28** circle (`--spacing-token-button-composer` 7), black accent `#000`/icon `#fff`, 9 from the right and bottom edges (`--spacing-composer-footer-bottom` 8) |
| Bottom gap | footer `pb-4` (electron; browser `pb-6`) = **16** above the window bottom (meas. 15.3) |

## Header and scroll button
| Item | Value |
|---|---|
| Header/tab bar | **52** (`--sidebar-navigation-header-height: spacing*13`; meas. 51.3); bottom hairline 0.5 px border (meas. `#f0f0f0`); pane has a hairline `#eaeaea` left edge on the `#f6f6f6` window |
| Scroll-to-bottom | `h-8 w-8` **32** circle, `border border-default bg-surface`, arrow `text-default`, centred on the column (`end-1/2 translate-x-1/2`), bottom = 24 above the footer (`bottom-[calc(100%+6*spacing)]`; meas. 24); fades with `opacity`/`duration-basic` |

## Mapping notes (worth reusable variables)
- `--thread-content-max-width: 768px`, `--padding-toolbar: 16px` → column 736; `--thread-content-top-inset: 32px`.
- `--edge-fade-top` / `--edge-fade-bottom`: set both to 32 px (ChatGPT uses 16 under the header and 32 above the composer); fade colour = `--color-surface`.
- `--codex-chat-font-size: 14px`, `--leading-relaxed: 1.625`, `--markdown-space: fs/4`.
- `--message-bubble-radius: 22px` = `--composer-radius`; `--user-chat-width: 70%`; bubble padding 10/16.
- Text ramp from one ink: secondary 69.5%, tertiary 49.5% (= codex-description), border 7.8%, strong 11.7%.
- Rail: `--rail-left: 16px`, `--rail-pitch: 10px`, `--rail-dash: 6px→26px × 2px`, opacities .4/.6/1, card 320/12/8 + `--shadow-xl`.
- `--elevation-composer`, `--shadow-xl`, scroll button 32/24.

## Shared scale (the whole app, 30 Oct; tokens in `app/globals.css`, listed in `DESIGN.md` §2)
| ChatGPT | Elpis token | Value | Where |
|---|---|---|---|
| `text-xs` / `text-sm` / `text-base` (4 sizes with the page title; 1 family) | `--text-xs` / `--text-sm` / `--text-base` | 12 / 13 / 14 | every CSS `font-size` maps to one of the three; titles keep their own size; `--serif` = `--ui-font` |
| thread text 14 (`--codex-chat-font-size`) | `--transcript-size` (Medium) | 14 (Small 13, Large 16) | `lib/reading.ts` |
| composer controls in one row, send 28 | `--control-h`, `--icon-size` | 28, 16 glyph | `.composer-controls` (plus, pills, model, effort, mic, send, stop) |
| composer: send 9 from right and bottom; Elpis default enlarged at Masih’s request on 31 Oct | `.composer` border 1 + padding 11/8/8/13; textarea 66 (22 px lines); 6 gap; 28 row | 121 | `.composer` |
| composer surface `surface-elevated-secondary` + `--elevation-composer`, ring 4% ink | `--composer`, `--composer-edge`, `--elevation-composer` | light `#fff`, ring 8% ink; dark `#17191d` (one step above the `#0a0b0d` chat), ring 14% ink | the gold focus edge stays (Elpis) |
| header / tab bar 52 | `--header-h` | 52, 14 px title | `.workspace-header` |
| Settings page: 48 top, header → 20 → sections 24 apart | `--page-pad`, `--page-head-gap`, `--page-section-gap`, `--page-content-width` | 48 32 64 / 20 / 24 / 860 | Settings, Customize, the Guide (`.page-scroll`) |
