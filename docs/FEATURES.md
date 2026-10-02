# Elpis features

DRAFT for Masih to correct. Everything Elpis v0.3.0 does that stock Codex does not, and every
Codex behavior v0.3.0 removed or changed, with a one-line check and its status in `elpis-next`.
Status as of 2026-09-30 (inventory of branch `next` at 094332d3 plus the audit); rows change
as fixes land. Evidence per row (file:line, audit finding) is kept outside the repo in
`~/.local/share/elpis/next-stage1/audit/inventory.md`.

Status: **works**, **partial**, **stub** (says "not in this build yet"), **missing**,
**kept from Codex** (0.159 does it natively), **removed-on-purpose**, **unknown** (nobody checked).

## A. Identity & look

| # | Feature | How to check (in elpis-next) | elpis-next status |
| - | ------- | ---------------------------- | ----------------- |
| A1 | Binary named `elpis`, Elpis version and help headline | `elpis-next --version`; `elpis-next --help` | partial: name and 0.4.0-dev are right, but the help body lists 26 Codex subcommands in Codex words (see R14) |
| A2 | The model is told it is Elpis on any model | Ask "who are you?", then again with `-c model=my-custom-model` | partial: catalog models get "Elpis, based on GPT-5/6". Models outside the catalog get "Elpis CLI … led by OpenAI" |
| A3 | Pragmatic-engineer personality | Ask anything on gpt-5.5 and read the tone | missing: upstream "vivid inner life … playful" personality |
| A4 | Screens say Elpis, never Codex (approvals, /permissions, sign-in, trust, /ide, exec) | Trigger an approval and read option 3 | partial: 356 Codex string literals in the TUI (v0.3.0 had 7). "tell Codex what to do differently", "Sign in … to use Codex" |
| A5 | Ember/orange-on-charcoal palette, Elpis popup borders, boxed approvals | Start `elpis-next` beside `elpis` | partial: palette works (evals; Masih's recognition check pending). Boxed prompts have left-border gaps; the approval lost its box |
| A6 | Session header "◆ Elpis (vX)" | Start it and read the first line | works |
| A7 | Header lines "model: … /model to change" and "startup: N s release" | Start it and read the header | missing |
| A8 | Identity line above the composer: "Elpis · model X · location Y" | Look above the composer | works |
| A9 | "Elpising…" label and animated name, still when idle | Send a message, watch, then wait after the reply | works (evals). An auditor saw the idle rail static; the label itself was not captured |
| A10 | Terminal title shows "Elpising…" with the paced spinner | Watch the tab title during a turn | works (code; auditors saw the title text) |
| A11 | Composer "Quiet Rail" and wash | Look at the composer | works (evals) |
| A12 | Max/Ultra effort ignition | `/model`, then pick Max effort | kept from Codex (0.159 has it); Elpis recolours it gold |
| A13 | Startup dissolve animation | Start it | missing |
| A14 | Welcome: ember ASCII art and "Welcome to Elpis" | Empty home in a terminal of 41+ rows | partial: the line says Elpis, but the art is Codex's ">_" logo; no ember |
| A15 | Elpis footer tips ("tab open the Context Ledger…") and busy hint "context unknown · Tab Context Ledger" | Look under the composer; press ? | missing: shows "? for shortcuts"; the ? sheet does not mention Tab |
| A16 | Readable in a light terminal (follows terminal colours) | Switch the terminal to light; read the footer and Ledger | works (auditor contrast ≥3.5:1, approximate; Masih has not checked) |
| A17 | `tui.appearance = "system"`/dark/light override | Set it in config.toml | missing: no such key |
| A18 | No upstream startup tips or announcement | Start it and look for "Tip: … Codex" | works |
| A19 | No OpenAI upgrade upsell; Esc never changes your model | Start with `model="gpt-5.5"` and press Esc on the first box | works since 2026-10-02: no upgrade prompt; checked on the real binary with gpt-5.5 (the 2026-09-30 build still shows "Meet GPT-6 Sol") |
| A20 | API key masked while typed (last 4 visible) | Empty home → "Provide your own API key" → type a key | missing: shown in clear |

## B. Context Ledger & admission

| #   | Feature                                                                                        | How to check (in elpis-next)                                                   | elpis-next status                                                                                                |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| B1  | Ledger beside the composer, shown by default, top-aligned, never trimmed                       | Start it and look right of the composer                                        | works (fullscreen mode starts it one row high)                                                                   |
| B2  | Tab opens, focuses and closes it (an open popup gets Tab first); Alt+C toggles; Esc closes     | Tab, Tab, Alt+C, Esc                                                           | works                                                                                                            |
| B3  | Ledger keys: ↑↓/jk, Space/Enter toggle, i all, g e none, w why, Backspace removes an added row | Tab, then each key                                                             | works (on screen only; see B5)                                                                                   |
| B4  | Mouse click toggles a row                                                                      | none                                                                           | removed-on-purpose: Masih, 2026-09-17, "no mouse"; the audit flagged it anyway                                   |
| B5  | The switches decide what the next request carries (`admission.toml`)                           | Plant a word in an admitted file, then include/exclude it and ask for the word | missing: switches are saved but the model never follows them                                                     |
| B6  | Global and project AGENTS.md rows can be excluded                                              | Exclude AGENTS.md, then ask about its contents                                 | missing: always sent                                                                                             |
| B7  | Development-rule rows (skills/dev/*.md) are included by default                                | Put a marker in `~/.elpis-next/skills/dev/AGENTS.md` and ask for it            | missing: the row shows INCLUDED but is never sent                                                                |
| B8  | Bundled dev rules (AGENTS.md, CODING_GUIDELINES.md) installed into the home                    | `ls ~/.elpis-next/skills/dev`                                                  | missing                                                                                                          |
| B9  | `skills.dev_rule_roots` (and `ELPIS_DEV_SKILLS_DIRS`) choose the rule folders                  | Set dev_rule_roots and open the Ledger                                         | missing: key not in config                                                                                       |
| B10 | `/add <file or dir>` (drag-and-drop paths too) adds an admitted row                            | `/add NOTES.md`, then ask for its contents                                     | missing: the row shows INCL, the file never reaches the model                                                    |
| B11 | GOAL.md row                                                                                    | `/goal …`, then Tab                                                            | missing                                                                                                          |
| B12 | SESSION CONTINUITY section with the ES.md row                                                  | Finish a turn, then Tab                                                        | missing                                                                                                          |
| B13 | MEMORY.md row: `c` creates it (not admitted), Space admits it                                  | Tab → MEMORY.md → c, Space, then ask                                           | partial: create and toggle work on screen; the contents are never sent (C1)                                      |
| B14 | CONTEXT WINDOW: measured total against the full window                                         | Send a message and read CONTEXT WINDOW                                         | works                                                                                                            |
| B15 | Category shares (user, agent, reasoning, tools, instructions, developer, tool definitions)     | Send two messages; read CONTEXT WINDOW or `/context`                           | missing: "category attribution unavailable" never changes                                                        |
| B16 | Per-source bytes and token estimates, with a "why" line                                        | Tab, w                                                                         | works (on screen)                                                                                                |
| B17 | Ctrl+click a row opens the file (OSC 8 link)                                                   | Ctrl+click the MEMORY.md row                                                   | unknown: code only                                                                                               |
| B18 | SMART PRUNE switch (`p`)                                                                       | Tab, p                                                                         | stub                                                                                                             |
| B19 | SUBAGENTS switch (`s`) stops the model delegating                                              | Tab, s, then ask it to spawn an agent                                          | works for every model since 2026-10-01 (it flips `multi_agent`; GPT-6 models used to ignore it); runtime-checked by config, the `s` key itself not run |
| B20 | Subagents listed in the Ledger with live status                                                | Delegate a task and watch the Ledger                                           | works: running subagents listed with their latest activity, refreshed as they work (unit-tested; not yet watched live) |
| B21 | The count holds the last provider figure when Enter sends (U22)                                | Note the count, press Enter                                                    | unknown                                                                                                          |
| B22 | Only skills you turn on reach the model; bundled skills off (U3)                               | Put a skill in ~/.agents/skills and ask what skills it has                     | unknown: fixed in code by 094332d3 after the audit found every skill sent; the installed binary predates the fix |

## C. Memory & continuity

| # | Feature | How to check (in elpis-next) | elpis-next status |
| - | ------- | ---------------------------- | ----------------- |
| C1 | MEMORY.md reaches the model when admitted | Put a fact in memories/MEMORY.md, admit it, ask | missing |
| C2 | `save_memory` tool: the responding agent saves MEMORY/ES in workspaces that opt in (`memory-autosave.json`) | Opt in, ask it to remember X, restart, ask | missing |
| C3 | Guarded saves: turn-start baseline, locks, size caps, stale-edit rejection, recovery receipts | With C2, look in memories/ for receipts | missing |
| C4 | Short numeric citations in memory, full ids in memory-references/sources.md (U16) | Read MEMORY.md after a save | missing |
| C5 | ES.md checkpoint after every turn (result, changed files, commands) | Finish a turn; `ls ~/.elpis-next/context/workspaces/*/ES.md` | missing |
| C6 | GOAL.md mirrors `/goal` | `/goal …`, then look in context/workspaces/<ws>/ | missing (`/goal` itself is kept from Codex) |
| C7 | Lean continuation: admitted GOAL/ES/rules are carried into every request as a World State section | New chat after C5; ask "where were we?" | missing |
| C8 | Switching provider keeps goal, ES and memory | Switch provider mid-task | missing (no other providers, no GOAL/ES) |
| C9 | Codex's own auto-memory pipeline off (/memories, /memory-drop, /memory-update) | Type /memories | removed-on-purpose, carried (features.memories=false, commands hidden) |
| C10 | Memory search through a user-registered RAG MCP | Ask it to search memory via rag | kept from Codex (MCP), but ~/.elpis-next has no MCP servers configured (L4) |
| C11 | Background model for naming and maintenance: `/memory-model`, `background_model`, `background_provider` | `/memory-model gpt-5.6-luna` | stub (session naming uses the main model) |

## D. Pruning & compaction

| # | Feature | How to check (in elpis-next) | elpis-next status |
| - | ------- | ---------------------------- | ----------------- |
| D1 | RTK shell-output hook written on first run when `rtk` is on PATH ("Hooks need review") | Fresh home with rtk installed, start it | missing. Unverified whether 0.159's own PreToolUse rewrite accepts RTK's output |
| D2 | Hard cap on huge tool output | Run a command that prints megabytes | kept from Codex |
| D3 | Smart Prune: shrink fresh tool output before the model first sees it (`/prune`, `/smart-prune on/off`, Ledger `p`, `/settings`; feature `automatic_context_pruning`) | `/smart-prune on`, then run a long command | stub |
| D4 | Smart Prune audit trail (logs/smart-prune) and report scripts | `ls ~/.elpis-next/logs` | missing |
| D5 | `/force-prune <1-100>` legacy rewrite with prune_report.md; `thread/prune/start` | `/force-prune 50` | stub |
| D6 | `/pruner-model` and `--pruner-model` | `/pruner-model` | stub (the flag is gone) |
| D7 | "Saved N tokens" line after a prune | none (depends on D3/D5) | missing |
| D8 | `/compact N`: compact when remaining context reaches N%, checked between tool calls (compaction.json) | `/compact 30` | missing: sent to the model as a chat message |
| D9 | `/compact <text>` guides the summary (also `thread/compact/start` instructions) | `/compact keep the blockers` | missing: sent as chat |
| D10 | `/compact` now, and automatic compaction near the window limit | `/compact` | kept from Codex |
| D11 | Hidden reasoning dropped from working history after each turn (rollout keeps it) | Compare request bodies of turn 2 | missing |
| D12 | Explicit prompt-cache breakpoints for GPT-5.6+ (feature `explicit_prompt_cache`, off) | `-c features.explicit_prompt_cache=true` | missing |

## E. Providers & models

| # | Feature | How to check (in elpis-next) | elpis-next status |
| - | ------- | ---------------------------- | ----------------- |
| E1 | ChatGPT subscription sign-in, OpenAI API key, `/model` with OpenAI models and effort | `/model` | kept from Codex |
| E2 | Reuse the existing Codex ChatGPT login (`~/.codex/auth.json`) while state stays in the Elpis home | Fresh `ELPIS_HOME`, start without logging in | partial: no code. The installed ~/.elpis-next has a hand-made auth.json symlink |
| E3 | Anthropic native Messages API (`ANTHROPIC_API_KEY`) | `-c model_provider=anthropic` | missing: "Model provider `anthropic` not found", then exit |
| E4 | Google Gemini native GenerateContent (`GEMINI_API_KEY`) | `-c model_provider=google-gemini` | missing |
| E5 | OpenRouter built in (`OPENROUTER_API_KEY`) | `-c model_provider=openrouter` | missing |
| E6 | Any OpenAI-compatible Chat Completions server (`wire_api = "chat"`: DeepSeek, Groq…) | Add a provider with wire_api="chat" | missing: 0.159 rejects wire_api chat |
| E7 | Amazon Bedrock, Ollama, LM Studio | `-c model_provider=ollama` | kept from Codex |
| E8 | `--provider` flag, including the claude/gemini/gemini-flash OpenRouter aliases | `elpis-next --provider anthropic` | missing: "unexpected argument" |
| E9 | Provider-aware `/model` ("Choose a mind", Change provider…, route/protocol/credential lines) | `/model` | missing: flat OpenAI list |
| E10 | Model lists fetched from each provider, with context window and price | `/model` → a provider | missing |
| E11 | Enter a provider key in `/model` or the dashboard Keys tab (masked; `account/provider/credentials/set`) | `/model` → provider → add key | missing |
| E12 | Reasoning effort on non-OpenAI providers | Pick an OpenRouter model, then effort | missing |
| E13 | Auto model routing (Auto row; feature `auto_model_routing`, off by default) | `/model` → Auto | missing |
| E14 | Switch provider mid-session without restarting | `/model` → another provider mid-chat | missing |
| E15 | GPT-6 / 5.6 tools through the code-mode host | Ask gpt-6-sol to run `ls` | kept from Codex: works in the 08:06 install; the `next-host` build mode (5b514d7f) has not been run |

## F. Commands, CLI & composer keys

| # | Feature | How to check (in elpis-next) | elpis-next status |
| - | ------- | ---------------------------- | ----------------- |
| F1 | `/` lists only Elpis's 33 commands | Type `/` and scroll to the end | partial: the 9 removed commands are hidden, but about 25 commands v0.3.0 hid or never had are listed (R12, R13). The uncommitted worktree edit changes this |
| F2 | `/yolo` saves Full Access for future chats | `/yolo`, `/new`, then `/permissions` | works (auditor: persists) |
| F3 | `/agent` opens the agent picker and shows the work graph | `/agent` | partial: the upstream picker opens; no work-graph cell (I2) |
| F4 | `/context`: category grid, checkpoints, system files, evidence link; Esc closes (U19) | `/context`, then Esc | partial: grid, checkpoints and system files are there and Esc closes; no categories (B15), no evidence link (H4) |
| F5 | `/usage` session card (model, provider, directory, permissions, session id, tokens, pruning) | `/usage` | missing: `/status` is hidden and `/usage` is ChatGPT account usage |
| F6 | `/usage daily`, `weekly` or `cumulative` token-activity chart | `/usage weekly` with a ChatGPT login | unknown: 0.159 has its own chart for ChatGPT logins; not checked |
| F7 | `/settings`: Keep computer awake and Smart Prune | `/settings` | missing: "Unrecognized command". Upstream `/experimental` has an analytics toggle and "Prevent sleep while running" |
| F8 | Command names /hotkeys, /settings, /del, /kill (and no /stop, /clean) | `/hotkeys` | missing: upstream /keymap, /experimental, /delete, /stop |
| F9 | `/mcp reset` reloads MCP connections on the next turn | `/mcp reset` | missing |
| F10 | `/new` starts a chat at once | `/new` | missing: a "Current checkout / New worktree" chooser comes first |
| F11 | Upstream commands v0.3.0 kept: /model /permissions /skills /hooks /resume /init /diff /mcp /theme /fork /goal /rename /copy /plan /clear /quit /subagents | Spot-check a few | kept from Codex |
| F12 | `elpis resume`, `delete`, `archive` and `unarchive` with an id | `elpis-next resume <id>` | kept from Codex (the auditor checked resume) |
| F13 | `--resume <id>` flag (U14 compatibility) | `elpis-next --resume <id>` | missing: "unexpected argument" |
| F14 | `\` then Enter inserts a newline (U20) | Type `a\` and press Enter | works (tested: backslash_enter_* composer tests) |
| F15 | Up during a turn brings every queued message plus the draft back into the composer | Queue two, then press Up | works (tested: Up pulls every queued message plus the draft) |
| F16 | Enter during a reply queues the message | Type during a reply, press Enter | works (tested) |
| F17 | Empty Enter during a reply interrupts and sends the queue once | Queue one, then Enter on an empty box | works (tested, with a no-queue negative); fixed 2026-10-01 |
| F18 | Tab never queues; Tab belongs to the Ledger | Type during a reply, press Tab | works |
| F19 | Shift+Tab cycles permissions (Read Only / Default / Full Access), with a lasting footer label | Shift+Tab | missing: cycles Plan (collaboration) mode |
| F20 | Esc with queued messages sends them (U18; not in v0.3.0) | Queue one mid-reply, press Esc | works as v0.3.0: Esc hands the queued message to the running turn without stopping it (tested) |
| F21 | Esc Esc steps back through earlier messages | Esc Esc | kept from Codex (inline pager, because Elpis turns the full-screen transcript off; R19) |
| F22 | Exit is immediate (U17; not in v0.3.0) | Quit during and after a turn | unknown: idle `/quit` takes about 75 ms in all three builds; mid-turn not measured |
| F23 | Middle-click pastes the primary selection; mouse copy in the composer | Middle-click in the composer | missing |
| F24 | Clean drag-select copy during a reply (no borders or prompts in the paste) | Drag-select while it streams, then paste | unknown |
| F25 | Two-finger swipe does not act as double-Esc (accepted 2026-09-16) | Swipe during a chat | unknown |
| F26 | Long chats stay responsive while typing and queueing (U21) | Type in a long chat | unknown: the installed build is unoptimized (see L5) |
| F27 | Output follows the newest line unless you scrolled up (U23) | Long reply at the bottom, then scroll up | kept from Codex |

## G. Sessions

| # | Feature | How to check (in elpis-next) | elpis-next status |
| - | ------- | ---------------------------- | ----------------- |
| G1 | Exact resume; the exit message prints the command | Quit, then run the printed command | partial: it prints `elpis resume …`, which during the trial opens v0.3.0 on ~/.elpis |
| G2 | Short task names from a cheap background model (4k-char input); manual names survive (U15) | Send a message, then `/resume` | partial: upstream names threads in the terminal. Each title request resends the ~21k-char agent prompt; app-server/VS Code clients get no title |
| G3 | The conversation title is visible on screen | After the first reply, look at the identity line | unknown: added in f90d8069 after the audit, not in the installed binary; the status line is forced off |
| G4 | Sessions worth deleting are marked in `/resume` ("review deletion", with reason) | `/resume` | missing |
| G5 | v0.3.0 conversations can be resumed | `/resume` in elpis-next | missing: separate home, and a v0.3.0 state database is refused (migration 41 clash) |
| G6 | One shared local runtime for every terminal (`--serve-local`); a chat is visible in all windows | Open two elpis-next windows | missing: the upstream daemon is off and cannot start without a packaged install |
| G7 | `--remote <socket>` joins an existing server | `elpis-next --remote unix:///…` | kept from Codex |

## H. Observability & dashboard

| # | Feature | How to check (in elpis-next) | elpis-next status |
| - | ------- | ---------------------------- | ----------------- |
| H1 | `/dashboard`: local HTML page with Activity, Context, Tokens, Smart Prune and Keys tabs | `/dashboard` | stub |
| H2 | Per-turn timing (duration, time to first token) and cost state; subscription cost shown as "unavailable" (U4) | Dashboard Activity tab | missing |
| H3 | Edit pruner settings from the dashboard | Dashboard Smart Prune tab | missing |
| H4 | Local evidence links (Ledger, `/context`, `/usage`) open readable reports | Ctrl+click the evidence link in `/context` | missing: removed from next's context_usage.rs |

## I. Agents & work graphs

| # | Feature | How to check (in elpis-next) | elpis-next status |
| - | ------- | ---------------------------- | ----------------- |
| I1 | Work-graph engine: acyclic plan check, write-scope conflicts, mandatory verifier, evidence gates (`features.enable_fanout`, off) | `-c features.enable_fanout=true`, then ask for a fan-out | works, on by default (follows SUBAGENTS); 17 unit + 5 end-to-end tests, runtime-checked on a fake model; not yet run on a real model |
| I2 | `workGraph/list` and the work-graph cell under `/agent` | `/agent` | works (tested; runtime-checked: `/agent` shows the graph) |
| I3 | Subagent repairs: another window's threads are not counted, the footer names the current agent, spawn rolls back on failure | Delegate in two windows | unknown |

The subagent switch and the subagent list are B19 and B20.

## J. Privacy & defaults

| # | Feature | How to check (in elpis-next) | elpis-next status |
| - | ------- | ---------------------------- | ----------------- |
| J1 | No telemetry: analytics, feedback and OTEL exporters off, no prompt logging; only model requests leave | `node scripts/elpis-next-privacy.test.cjs`, or capture one turn | works: 4/4 checks, 0 outbound. v0.3.0 deleted the crates; next switches them off |
| J2 | No unconditional network calls at startup or per turn (update check, announcements, git attribution) | Capture the network during startup | works |
| J3 | Own home (`~/.elpis`; `~/.elpis-next` during the trial); an inherited CODEX_HOME is ignored and not passed to shells | Start it and check which folders change | works |
| J4 | Project folder `.elpis` for config, write-protected like .git and .codex | Put config in `<repo>/.elpis`; check the protected list in the request | missing: back to `.codex`, and `.elpis` is not protected |
| J5 | Plugins, apps and tool suggestions only when you add them (U13) | Fresh home; look for plugin/app text in the request | partial: plugins, apps and tool_suggest are off; `remote_plugin` keeps its upstream "on"; not run |
| J6 | Guardian (model) approval reviewer off | none | missing: the upstream default is on; the effect was not checked |
| J7 | Permission presets Read Only / Default / Full Access | `/permissions` | kept from Codex |

## K. VS Code

| # | Feature | How to check | elpis-next status |
| - | ------- | ------------ | ----------------- |
| K1 | Elpis VS Code extension: chat panel, approvals, unsaved-document reads, diagnostics, definitions and references, approval-gated edits | VS Code → "Elpis: Open Chat" | unknown for elpis-next: extension 0.1.30 bundles and runs the v0.3.0 runtime and has never been pointed at `elpis-next app-server` |
| K2 | Terminal and VS Code share one runtime: IDE History resumes terminal chats, with live two-way messages and interrupts | Open the same project in both | missing (needs G6) |
| K3 | `/ide on/off/status` sends the editor selection and open tabs | `/ide on` with the extension open | missing: it asks for "the Codex extension" and looks for ~/.elpis-next/ipc/ipc.sock |
| K4 | Provider keys saved in VS Code are applied to the runtime | Save a key in the extension | missing (needs E11's RPC) |

## L. Install & update

| # | Feature | How to check | elpis-next status |
| - | ------- | ------------ | ----------------- |
| L1 | One-line installer: Linux x86_64, SHA-256 check, bundled bwrap sandbox, optional RTK; refuses macOS | Run the installer | missing for elpis-next (no release; local build and manual install) |
| L2 | `elpis --update` replaces the binary from GitHub releases; the update prompt runs it | `elpis-next --update` | missing: "unexpected argument". Upstream `update` points at Codex (R9) |
| L3 | `--migrate-from-codex` preview and apply (config, hooks, rules, skills, plugins, history, sessions, cache) | `elpis-next --migrate-from-codex` | missing |
| L4 | Carry the v0.3.0 setup over: MCP servers (rag, voice-commander, gmail), Full Access default, dev rules, MEMORY.md, hooks, conversation-cleanup skill, sessions | Start elpis-next; check `/mcp` and `/permissions` | missing: ~/.elpis-next holds only auth, a minimal config and new sessions |
| L5 | Optimized release build | `elpis-next update` (prints "debug build") or `ls -la ~/.local/lib/elpis-next` | partial: the installed 08:06 binary is unoptimized (about 4-5× Codex's CPU while streaming). `next-release`/`next-host` build modes exist (5b514d7f) but no release build is installed |
| L6 | Tagged release pipeline (binary, sandbox helper, .deb, checksums, tag gate) | none | missing for next |

## R. Codex behaviors v0.3.0 removed or changed, and whether elpis-next carries the change

| # | Codex behavior | What v0.3.0 did | Carried in elpis-next? |
| - | -------------- | --------------- | ---------------------- |
| R1 | Analytics uploads | Deleted the crate | partial: switched off by config; `/experimental` still offers an "Analytics plan history" toggle |
| R2 | Feedback upload and `/feedback` | Deleted | partial: off by config and hidden, but the interrupt notice still says "use /feedback" (fix uncommitted in the worktree) |
| R3 | Automatic memories pipeline, `/memories`, `/memory-drop`, `/memory-update`, the memory RPCs | Deleted the crates and commands | yes, by config: features.memories=false and the commands are hidden; crates and RPCs remain |
| R4 | Codex Cloud tasks | Deleted the crates | no: `elpis-next cloud` exists and tells you to run `codex login` |
| R5 | Realtime voice (realtime-webrtc) | Deleted | no: `/voice` is listed with a ChatGPT login |
| R6 | Pets | Deleted | yes: `/pets` hidden (code remains) |
| R7 | Startup tips and announcements | Deleted | yes: show_tooltips=false; announcement fetch skipped |
| R8 | `/status`, `/exit`, `/rollout`, `/test-approval` | Removed; `/status` folded into `/usage` | yes: hidden (but F5's card is missing) |
| R9 | Codex updater (npm/brew/curl) and npm update check | Replaced by `elpis --update` | no: the startup check is off, but `elpis-next update` and `/daemon` → "Install latest public stable" run the Codex installer |
| R10 | ChatGPT usage view and usage-limit reset | Replaced by the Elpis `/usage` card | no: upstream `/usage` is back (ChatGPT only) |
| R11 | 20 upstream commands kept out of the popup (/review /delete /side /btw /logout /setup-default-sandbox /approve /import /archive /app /mention /raw /debug-config /title /statusline /apps /plugins /ps /stop /vim) | Hidden | no in committed next; the uncommitted worktree edit unlists 16 and hides 4 |
| R12 | 0.159 commands v0.3.0 never had (/fast /worktree /recap /voice /agents /export /tui /daemon /warnings /cd /pwd) | n/a (newer than v0.3.0) | no: all listed. /agents and /daemon cannot work. Masih decides on /cd /export /pwd /recap /tui /warnings /worktree |
| R13 | The full multitool CLI (exec, login, logout, mcp, plugin, app-server, remote-control, completion, update, doctor, sandbox, debug, apply, queue, migrate-rollouts, fork, cloud, exec-server, features, agents, review, app) | Only resume/delete/archive/unarchive plus Elpis flags | no: all back; `exec` prints "OpenAI Codex v0.159.0" and labels replies "codex" |
| R14 | Shift+Tab cycles Plan (collaboration) mode | Cycles permission presets | no (F19) |
| R15 | Tab queues a follow-up | Unbound; Tab opens the Ledger | yes |
| R16 | Alt+Up / Shift+Left edits the last queued message | Plain Up recalls all queued messages plus the draft | no (F15) |
| R17 | Footer status line (model · dir · title) | Suppressed; the identity line replaces it | yes, with side effects: `/statusline` does nothing and the title shows only via G3 |
| R18 | Full-screen transcript (0.159) | n/a (v0.3.0 was inline) | yes: forced off (`tui.fullscreen_transcript=false`). Masih decides |
| R19 | Upstream defaults on: apps, plugins, tool_suggest, remote_plugin, guardian_approval | All five off | partial: apps, plugins and tool_suggest off; remote_plugin and guardian_approval still on |
| R20 | Bundled OpenAI skills; all discovered skills enabled | Bundled off; skills default off | yes in code (094332d3), not run; the installed binary sends every skill |
| R21 | Codex home `~/.codex`, project `.codex` | `~/.elpis` and `.elpis`, auth reused from ~/.codex | partial: own home yes; project folder is `.codex` again; no auth reuse (E2) |
| R22 | Playful/friendly default personality | Pragmatic engineer | no (A3) |
| R23 | Background daemon ("work continues after quit") and agents command center (0.159) | n/a; v0.3.0 had its own shared server (G6) | partial: auto-start off, but `/agents`, `/daemon` and the `agents` subcommand are visible and broken |
| R24 | Claude Code memory import (external-agent-migration memory_import) | Deleted | no: the code is present and `/import` is listed; not run |
| R25 | Codex git-attribution request to ChatGPT | Not made by the elpis binary | yes: gated on ELPIS_HOME (bc960b5e) |
