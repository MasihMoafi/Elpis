# Elpis desktop: the design system

Desktop tokens, components and layout. Requirements are in [SPEC.md](SPEC.md), project rules in [MASIH-RULES.md](../../docs/MASIH-RULES.md), general UI rules in `~/Desktop/p/skills/web-dev/UI-RULES.md`.

## 1. Stack
Next 16 static export (`app/page.tsx` is the one page shell), React 19, Tailwind 4 in `app/globals.css`, shadcn/ui "base-nova" on Base UI (`components/ui`, `components.json`), lucide icons, Electron 44. The look is "HUD": bevelled corners, accent ticks, 12 px mono labels. No daisyUI; do not add it.

## 2. Tokens
In `app/globals.css` (`:root` and `.dark`). Never use a literal where a token exists.

| Concept | Tokens |
| --- | --- |
| Colour | `--canvas` `--ink` `--background` `--foreground` `--card` `--border` `--hairline` `--hover` `--selected` `--muted-foreground` `--subtle-foreground` `--destructive` |
| Accent | `--primary` (set by `data-accent`: amber default, blue, teal, green, violet, rose, orange), `--accent-text` |
| Type | three sizes, as ChatGPT: `--text-xs` 12 (`--text-small`, the floor), `--text-sm` 13, `--text-base` 14 (Tailwind `text-xs/sm/base` read them); every CSS `font-size` uses one of them, except titles; one family `--ui-font` (`--serif` is the same face); `--mono` for code and `.hud-label` only; thread text `--transcript-size` (Medium 14, Small 13, Large 16; `lib/reading.ts`); replies that need the tighter reading rhythm use `--reply-line-height` 1.45 and `--reply-paragraph-gap` .725em |
| Size | `--icon-size` 16 (one per row and in every `Button`; the one smaller glyph is a 14 px disclosure chevron); gaps 2/4/6/8/12/16 only; `--text-title` 28 for page titles; `--control-h` 28 (the `.composer-controls` row: plus, pills, model, effort, mic, send, stop); `--row-h` 34 (every sidebar row and Settings tab, all window heights); `--header-h` 52 (`.workspace-header`, 14 px title); pages (`.page-scroll`: Settings, Customize, the Guide) `--page-pad` 48 32 64, `--page-content-width` 860, `--page-head-gap` 20, `--page-section-gap` 24 |
| Composer | `.composer`: border 1, padding 11/8/8/13, textarea 66 (22 px lines), 6 gap, 28 row: 121 tall, enlarged at Masih's request (31 Oct). Surface one step above the chat: `--composer`, `--composer-edge`, `--elevation-composer`; light `#fff` with an 8% ink ring, dark `#17191d` (chat `#0a0b0d`) with a 14% ink ring. It keeps the Elpis bevel; the gold edge shows only on focus |
| Shape | `--cut-sm` 4 px, `--cut` 7 px, `--cut-lg` 10 px; `.hud-cut` on controls, `.hud-cut-sm` on controls 24 px or less, `--cut-lg` on panels. Round only dots, rings, switches |
| Motion | `--motion-fast` .12 s, `--motion` .2 s, `--ease` |

### The chat thread follows the ChatGPT app
Masih, 29 Oct: "map every style feature of chatgpt app into a clear spec that's reusable and make our design match it". [specs/chatgpt-chat-style.md](specs/chatgpt-chat-style.md) holds ChatGPT's measured thread values and maps its scale to the tokens above ("Shared scale"). The thread tokens `--thread-tertiary`, `--thread-hairline`, `--thread-inset`, `--thread-edge-fade` and `--shadow-xl` carry them; change a value there and in the spec together. The Elpis marks stay: your messages are bevelled cards with the gold right edge (Masih, 29 Oct: "That needs to come back.").

## 3. Primitives (`components/ui`): use, do not re-make
`button` (variants: default, outline, secondary, ghost, destructive, link; sizes: xs, sm, default, lg, icon, icon-xs, icon-sm, icon-lg), `input`, `textarea`, `search-field`, `switch`, `checkbox`, `alert-dialog`, `dropdown-menu`, `context-menu`, `popover`, `tooltip`, `select`, `combobox`, `option-select`, `disclosure-summary`, `menu-row` (a menu row whose owner drives its own keys, styled as a dropdown item).

## 4. Shared patterns: reuse before writing
| Need | Use | Where |
| --- | --- | --- |
| A settings page | `SettingsHeader`, `SettingsGroup`, `SettingRow`, `SettingsNotice`, `SettingsEmpty`, `SettingsActions`, `Segmented`, `Choice` | `components/settings/rows.tsx` |
| A list of items with a state and an action | `CustomizeRow` in `.customize-list` | `components/customize-view.tsx`, `customize-plugins.tsx` |
| Actions on an item | `MenuAction` with `MoreMenu` / `RightClickMenu`; one action is a button, not a menu | `components/action-menu.tsx`, `thread-actions.tsx` |
| A dialog | `AlertDialog`: title, one sentence, cancel left, the action right | `components/ui/alert-dialog.tsx` |
| A key beside a command | `shortcutHint(id)` and `.kbd-hint` (or `data-shortcut` on a row); follows Settings → Keyboard shortcuts | `lib/shortcuts.ts` |
| A section title | the accent tick + hairline (`.settings-group-heading`, `.customize-title`) | `app/globals.css` |
| Chat rows, agents, projects | `thread-row`, `ReorderItem`, `chat-groups` | `app/page.tsx`, `components/reorder.tsx` |

## 5. Layout
`title-bar` → `aside.sidebar` (brand, nav, search, chat list, footer) + `main.workspace` (header, one page column, composer) + optional side panel (browser, files, terminal). Settings replaces the sidebar and has its own page column. Sidebar footer, left to right: the user's name (shown, never clickable), a status line, the Theme button, the Settings gear.

The accepted Working status: `WorkingPlacement` portals `WorkingStatus` into `.composer-working`, directly above the composer, on its left edge, with an 18 px gap. Keep it there through window resize, full-size restore and opening either side panel. Never position it with viewport or panel offsets. The rotor, dot and six independently phased edge opacities animate.

The prompt rail keeps a 28 px target inside the existing 32 px gutter, so showing it does not resize the transcript.

Reconnect and error notices follow the last message inside `.chat-content`. Showing, updating or dismissing one never changes the composer or transcript viewport's position or size. Other pages, and a chat hidden behind the side panel, keep their notices at the workspace bottom.

## 6. Rules for every screen
- A shown name or label is not a control.
- A page the user cannot act on is removed or made to work. A hidden page leaves the sidebar and the command menu.
- Lists have a planned order; one setting has one control.

## 7. Adding or changing UI, in order
1. Search for the concept (`rg`) and read its owner; check the tokens and shared patterns above.
2. Extend the owner (a prop or variant) before adding a component; a page-local style is the last resort.
3. Fix the shared source, delete the local overrides it makes obsolete, then check every page that uses it.
4. Test: a UI test through `tests/parity-fixture.cts` (light and dark); anything the real server must serve or the real engine must do needs a test at that boundary.
5. Retained tests change only through `scripts/renderer-artifact-gate.mts` (pin with Masih's words as approval).
6. Follow [desktop verification](TESTING.md) before installation.
