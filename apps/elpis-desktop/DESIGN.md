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

Message actions (reply, copy, read aloud, "More") show under his every message and under each turn's final reply all the time, never only on hover (Masih, 13 Nov: "show for all messages all the time"). They hang in the room the message keeps under it, so nothing moves when the pointer does; `--subtle-foreground` at rest, `--foreground` while the message is hovered or the row holds focus. A reply still arriving shows none; a reply in the middle of a turn offers them in its right-click menu.

Reconnect and error notices follow the last message inside `.chat-content`. Showing, updating or dismissing one never changes the composer or transcript viewport's position or size. Other pages, and a chat hidden behind the side panel, keep their notices at the workspace bottom.

Notices about a chat action (Deleted with its Undo, Undone or Redone after Ctrl+Z, a kept worktree) never cover the transcript or the message box (Masih, 13 Nov: they showed "on top of the last message of any conversation"). `ActionNotices` (`components/workspace-notices.tsx`, `.action-notices`) stacks them small at the sidebar's foot, above its footer; with the sidebar closed, in the window's bottom left corner; where that corner would touch the chat (a narrow window), in the title bar's free middle, the first notice only. They keep `role="status"`, their buttons in the tab order, Ctrl+Z, and their 8 s on screen.

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

The shared static UI check is owned by the shared-system package (`~/Desktop/p/shared-system/lint/lint.mjs`, on npm as `@masihmoafi/shared-system`; the old path under `skills/web-dev/` is a link to it). This app holds a generated copy, `scripts/ui-lint.generated.mjs`. After changing the owner, run `node scripts/ui-lint-sync.mts --write` from this app; `node scripts/ui-lint-sync.mts --check` runs in every build and on CI, and fails on a stale copy.

## 8. Known UI exceptions
What `ui-check.known.json` still allows, one row per key (rule, then file or page); the list only shrinks. The R2 control-height rows are grouped by control instead, with their number of keys (25 in all). A disclosure is `Disclosure` with `DisclosureSummary` (`components/ui/disclosure-summary.tsx`, the one native `details`), so it has no row. An R5 row stays where `Button` or `Input` would change the look: their base classes add the bevel clip, a 1 px transparent border, medium weight, a 1 px press shift and the focus ring. Matching a control to the pixel needs an unstyled shared variant and a look check for that control.

| Rule | File or page | Why it stays; what would change it |
| --- | --- | --- |
| R2 | `/` brand row | The 73×36 wordmark and the 28 px Close sidebar button share a centre line; equal boxes means clipping the wordmark or a 38 px hover box on Close |
| R2 | `/` sidebar nav rows (7 keys) | New chat, Lab, Workflows, Love Spot, Elpis, Observability and Customize are 34 px. Rule R2 arrived on 12 Nov 2026 from the shared system; Elpis's pass to the shared heights (32, 36, 40 px) is a design change Masih sees first |
| R2 | `/` sidebar chat rows (3 keys) | Each chat row is 34 px. Same reason: R2 arrived on 12 Nov 2026; the pass to the shared heights waits for Masih |
| R2 | `/` usage summary (1 key) | "Usage unavailable" at the sidebar foot is 34 px. Same reason |
| R2 | `/` composer chips and triggers (7 keys) | Local, Work in a project, Full access, the permissions chip on the phone (icon only), the model picker, Add files and the context gauge are 28 px. Same reason |
| R2 | `/` feature chips (3 keys) | Smart Prune, Subagents and RAG under the composer are 28 px. Same reason |
| R2 | `/` buttons and triggers (4 keys) | The Elpis home wordmark is 38 px; Close sidebar and Pin Matilda are 28 px; Add new project, the theme toggle and Settings are 24 px; the Character, Sort chats and chat-row action menus are 24 px. Same reason |
| R3 | `/` brand row | The same pair: their tops differ by 5 px because they are centred; top-aligning moves the toggle off the wordmark's centre |
| R4 | `components/agents-canvas.css` | The board's kind, sticky-note and iso-face colours have no theme token; adding them is a theme change in `design/design.json` |
| R5 | `components/agents-iso-places.tsx` | Ports, wire ends and flow labels are marks placed on the board; Button's box and clip would move them |
| R5 | `components/appearance-settings.tsx` | The native colour swatch; Input's bevel clip and padding would crop it |
| R5 | `components/approval-card.tsx` | A native checkbox in the accent colour; the shared Checkbox draws a different box |
| R5 | `components/archived-view.tsx` | The same native checkboxes (select all and one per row) |
| R5 | `components/browser-annotations.tsx` | A numbered comment pin on the page; Button's size and clip would change the pin |
| R5 | `components/browser-panel-chrome.tsx` | The zoom value reads as text and resets on click; Button adds padding and weight |
| R5 | `components/browser-panel.tsx` | The same zoom value in the older toolbar |
| R5 | `components/chat-team-panel.tsx` | Team rows are list rows with a state dot; Button's centring and clip would change them |
| R5 | `components/composer-controls.tsx` | The 12 px × inside the Plan pill; the smallest Button is 24 px |
| R5 | `components/context-files.tsx` | A file name that reads as a link; Button adds padding and weight |
| R5 | `components/context-ledger.tsx` | The ledger's full-width heading row; Button centres it and clips its corners |
| R5 | `components/decision-card.tsx` | Choice rows with a second line; Button is one centred line |
| R5 | `components/edit-rows.tsx` | The Changes row with its counts; Button's centring and clip would change it |
| R5 | `components/elpis-features.tsx` | The feature chips under the composer (dot and label); Button adds height and weight |
| R5 | `components/experiment-lab.tsx` | Saved-experiment rows with two lines; Button is one centred line |
| R5 | `components/file-cards.tsx` | A native dialog for a full-size image; the app has no shared dialog other than the alert dialog |
| R5 | `components/file-editor.tsx` | The editor's find field and code area keep the editor's mono look; Input and Textarea add the bevel and border |
| R5 | `components/file-ref.tsx` | An inline file link inside message text; Button would break the line |
| R5 | `components/file-tree.tsx` | The tree's filter field in the panel's own style; Input adds the bevel and height |
| R5 | `components/improve-elpis.tsx` | A menu item placed in another owner's context menu; `menu-row` needs its owner's keys |
| R5 | `components/matilda-companion.tsx` | Matilda's face and resize grip are a drawn character and a drag handle |
| R5 | `components/mcp-settings.tsx` | A native checkbox in the import list |
| R5 | `components/message-reply.tsx` | The quoted message is a two-line block; Button is one centred line |
| R5 | `components/prompt-rail.tsx` | Rail ticks are 28 px marks in a 32 px gutter; the bookmark sits in the preview card |
| R5 | `components/provider-usage.tsx` | The usage bars as one clickable block; Button centres and clips it |
| R5 | `components/queued-follow-ups.tsx` | A full-width queued row with preview text |
| R5 | `components/settings-view.tsx` | "Back to app" is a sidebar row (`--row-h`), not a button size |
| R5 | `components/sidebar-group.tsx` | A group header row with its chevron at `--row-h` |
| R5 | `components/sidebar-thread-row.tsx` | The status dot and the chat row; both are sidebar rows, not buttons |
| R5 | `components/tab-strip.tsx` | A tab with icon and label; Button's centring and clip would change it |
| R7 | `/` composer `.model-controls` | Real: the plus is drawn at 2.3 px and the lock at 0.9 px beside the 1.3 px chevron; evening them means redrawing approved Elpis glyphs (the plus and the whole second sheet) |
| R7 | `/` sidebar `.nav-list` | The check reads 1 px on filled Elpis glyphs; drawn, the outlined ones match lucide (1.2–1.3 px), but the Elpis mark is a solid 2 px mark; evening it means redrawing his logo mark |
| R7 | `/` composer `.composer-tray` | Drawn the same (folder 1.04 px, laptop 1.08 px at 13 px), but the folder is filled, so the check reads 1 px; declaring a stroke on Elpis glyphs would also hide the real cases above |
| R7 | `/` composer `.composer-right` | The context ring beside the model picker is drawn at 2 px and its neighbours at 1.3 px. It is a gauge, not an icon: its line carries how full the context is, and at 1.3 px in the border colour it is faint in the light theme. Evening it is a change to how the gauge looks, which waits for Masih |
