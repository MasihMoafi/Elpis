# Elpis desktop: the design system

One page. Every UI change starts here; the rules come from Masih's logged rules (`skills/dev/MASIH-RULES.md`) and the `web-dev` and `designer` skills.

**Operating principle:** radically prioritize. Fix what is broken before anything new; delete before adding; one source per concept. If two places show the same thing, one shared component, variant or token owns it.

## 1. Stack
Next 16 static export (`app/page.tsx` is the one page shell), React 19, Tailwind 4 in `app/globals.css`, shadcn/ui "base-nova" on Base UI (`components/ui`, `components.json`), lucide icons, Electron 44 around it. The look is "HUD": bevelled corners, accent ticks, 12 px mono labels. No daisyUI; do not add it.

## 2. Tokens (`app/globals.css`, `:root` and `.dark`). Never use a literal where a token exists
| Concept | Tokens |
| --- | --- |
| Colour | `--canvas` `--ink` `--background` `--foreground` `--card` `--border` `--hairline` `--hover` `--selected` `--muted-foreground` `--subtle-foreground` `--destructive` |
| Accent | `--primary` (set by `data-accent`: amber default, blue, teal, green, violet, rose, orange), `--accent-text` |
| Type | three sizes, as ChatGPT: `--text-xs` 12 (`--text-small`, the floor), `--text-sm` 13, `--text-base` 14 (Tailwind `text-xs/sm/base` read them); one family `--ui-font` (`--serif` is the same face); `--mono` for code and `.hud-label` only |
| Size | `--icon-size` 16 (one per row and in every `Button`; the one smaller glyph is a 14px disclosure chevron); gaps 2/4/6/8/12/16 only; `--text-title` 28 for page titles; `--control-h` 28 (composer row), `--header-h` 52; pages `--page-pad`, `--page-content-width` 860, `--page-head-gap` 20, `--page-section-gap` 24 |
| Shape | `--cut-sm` 4 px, `--cut` 7 px, `--cut-lg` 10 px; `.hud-cut` on controls, `.hud-cut-sm` on controls 24 px or less, `--cut-lg` on panels. Round only dots, rings, switches |
| Motion | `--motion-fast` .12 s, `--motion` .2 s, `--ease` |

### The chat thread follows the ChatGPT app
`specs/chatgpt-chat-style.md` holds every measured value of ChatGPT's thread (column, insets, edge fades, bubble, reply type, fold row, actions, prompt rail, composer, scroll button). The thread's tokens (`--thread-tertiary`, `--thread-hairline`, `--thread-inset`, `--thread-edge-fade`, `--shadow-xl`) carry them; change a value there and in the spec together. The Elpis marks stay: your messages are bevelled cards with the gold right edge (Masih, 29 Oct: "That needs to come back.") (29 Oct, Masih: "map every style feature of chatgpt app into a clear spec that's reusable and make our design match it").
Its "Shared scale" section carries the same scale to every page (the Size and Type rows above): a new text size, icon size, control height or page gap uses a token, never a literal. The composer keeps the Elpis bevel and the gold focus edge; its surface sits one step above the chat (`--composer`, `--composer-edge`, `--elevation-composer`).

## 3. Primitives (`components/ui`): use, do not re-make
`button` (variants: default, outline, secondary, ghost, destructive, link; sizes: xs, sm, default, lg, icon, icon-xs, icon-sm, icon-lg), `input`, `textarea`, `search-field`, `switch`, `alert-dialog`, `dropdown-menu`, `context-menu`, `popover`, `tooltip`, `select`, `combobox`, `option-select`, `disclosure-summary`, `menu-row` (a row of a menu whose owner drives its own keys: the look of a dropdown item).

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

## 6. Rules that apply to every screen
- A menu with one choice is a button. Keys sit beside names. A shown name or label is not a control.
- No triangle markers anywhere; even strokes; card decorations at border width; roomy stacked text.
- A page the user cannot act on is removed or made to work. A hidden page leaves the sidebar and the command menu. A section lists only what its name says (Recents: chats outside any project).
- Lists have a planned order; choices are menus, never typed names; one setting, one control, one truth.
- Check light and dark, 820 to 1600 px, before showing anything. Visual claims need a screenshot first.

## 7. Adding or changing UI, in order
1. Search for the concept (`rg`) and read its owner; check the tokens and the shared patterns above.
2. Extend the owner (a prop or variant) before adding a new component; a page-local style is the last resort.
3. Fix the shared source, delete the local overrides it makes obsolete, then check every page that uses it.
4. Test: a UI test through `tests/parity-fixture.cjs` (light and dark); anything the real server must serve or the real engine must do needs a test at that boundary (the fixture's own server hid a missing `.webp` type once).
5. Retained tests change only through `scripts/renderer-artifact-gate.mjs` (pin with Masih's words as approval); new tests go in `test-inventory.json`.
6. Run `npm run check:install`, build, install with `scripts/install-desktop.mjs`, then ask Masih to test what only eyes can judge.
