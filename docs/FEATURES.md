# Elpis features

DRAFT for Masih to correct. What Elpis must do, and how to check it in a few seconds. The
status column is from the 2026-09-30 audit of `elpis-next` (Codex 0.159 base); nothing here
is accepted until Masih checks it. Audit results are leads: each row is rechecked when fixed.

Status: **works**, **partial**, **stub** (says "not in this build yet"), **missing**,
**broken**, **unchecked**.

## Elpis's own features

| # | Feature | How to check | elpis-next |
| - | ------- | ------------ | ---------- |
| 1 | Named Elpis everywhere, never Codex | Ask "who are you?"; open /permissions, an approval, sign-in, `--help` | partial: the model says Elpis; many screens, `exec` and `--help` still say Codex |
| 2 | Elpis look: ember/red-black palette, Elpis header, motion | Start it; compare with `elpis` | partial: header yes; welcome screen shows Codex's logo in tall windows |
| 3 | Context Ledger beside the composer, top-aligned, Tab opens it | Press Tab | works (mouse clicks missing) |
| 4 | Ledger switches decide what the model gets (MEMORY.md, AGENTS.md, dev rules, `/add` files) | Plant a fact, switch it off, ask for it | broken: switches show but the model never follows them |
| 5 | Ledger shows where the context goes (user/agent/tool shares) | Send two messages, read CONTEXT WINDOW | missing |
| 6 | Only chosen skills load (dev rules + picked skills) | Put a skill in `~/.agents/skills`, ask what skills it has | broken: every installed skill is sent |
| 7 | Plugins only when added | Fresh home, look for plugins in the prompt | unchecked |
| 8 | Memory: the agent saves what matters; recalled after restart | Ask it to remember something; restart; ask | missing (no save tool, no ES.md/GOAL.md) |
| 9 | Smart Prune `/prune` trims big tool output; `/force-prune`; `/pruner-model` | Run a long command with `/prune` on | stub |
| 10 | `/compact 30` sets when compaction happens; `/compact <text>` guides it | Type `/compact 30` | broken: sent to the model as chat |
| 11 | Shell output compressed through RTK | Run `git status`, check the request | missing |
| 12 | `/dashboard`: live page with context, timing, usage (price shown as unavailable) | Type `/dashboard` | stub |
| 13 | Claude, Gemini, OpenRouter by API key; `/model` shows provider and Auto | Open `/model` | missing |
| 14 | `/agent` and the work graph | Type `/agent` | missing |
| 15 | No telemetry: nothing leaves except model requests | Network capture of one turn | works (4/4 checks, 0 outbound) |
| 16 | Own home (`~/.elpis`), own project folder (`.elpis`) | Start it; check which folders it writes | partial: home yes; project folder is back to `.codex` |
| 17 | API key hidden while typed | First start, type a key | broken: shown in clear |
| 18 | `\` then Enter makes a new line | Type `a\`, Enter | missing: sends |
| 19 | Up during a turn brings back all queued messages | Queue two, press Up | missing: only the last |
| 20 | Esc sends the queued message instead of stopping | Queue one mid-answer, press Esc | unchecked |
| 21 | Exit is immediate | Quit during and after a turn | unchecked |
| 22 | Context count stays still until the model reports | Note the count, press Enter | unchecked |
| 23 | Only Elpis commands in `/` and `--help` | Type `/`; run `elpis-next --help` | partial: removed commands hidden; ~25 upstream commands and 26 CLI subcommands back |
| 24 | `elpis --update`, `--migrate-from-codex` | Run them | missing |

## Codex features Elpis keeps

| # | Feature | How to check | elpis-next |
| - | ------- | ------------ | ---------- |
| 25 | Fast and light (release build) | Stream a long answer; watch CPU | broken: debug build installed; release build in progress |
| 26 | GPT-6 / 5.6 tools work (code-mode helper) | Ask it to run `ls` on gpt-6-sol | works in the install; build script now builds the helper |
| 27 | Conversation named after its content, shown on screen | Send a message, look under the composer | partial: named, but shown only in the tab title and `/resume` |
| 28 | Full-screen transcript (Esc Esc scrolls back in place, clean exit) | Esc Esc | off by an Elpis default; Masih decides |
| 29 | `elpis resume <id>` reopens a chat | Quit, run the printed command | partial: printed command opens the old `elpis` during the trial |
| 30 | `/ide` context from VS Code | Type `/ide` | broken: asks for the Codex extension |
