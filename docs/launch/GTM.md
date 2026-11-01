# Elpis go-to-market (draft, 1 Nov 2026)

**One line (GitHub description):** An agent harness for Linux, built on Codex: you choose what each agent sees, and in a team each agent owns its folder, is checked, and merges only after review.

## Audience

1. **First:** developers on Linux who already pay for ChatGPT or Claude and run several coding agents at once, by hand, in tmux or worktrees.
2. **Second:** people who build multi-agent systems and want a board to design them on, with ready-made patterns (Sequential, Parallel, Kahn waves, Recursive, Voting).
3. **Not now:** macOS and Windows users; teams that need a hosted service.

## Positioning

The problem: several agents on one task overwrite each other, nobody checks the work, and you merge by hand. Elpis answers with ownership: one writer per folder, a check after every writer, a Mother agent review before the merge.

| Tool | What it does well | What Elpis adds (verify their docs on launch day) |
| --- | --- | --- |
| Claude Code | Strong single agent; subagents | A drawn team across providers; a check after every writer; a reviewed, fast-forward merge |
| Codex | The engine Elpis is built on | The Context Ledger; Workflows; a desktop app with Claude and Gemini beside GPT |
| Cursor | Editor with parallel agents | Ownership rules refused before the run; the team as a graph you edit; runs on your subscriptions |
| CloudRoom (David Ondrej) | Agents run in the cloud | Local, open source, your own subscriptions. Ask David before naming CloudRoom publicly; offer a joint demo |

Lead with one idea: **Rust's ownership rule, applied to agents.** Never say "best", "first" or "fastest".

## Channels

| Channel | Post | Proof attached |
| --- | --- | --- |
| masihmoafi.com | Launch post: the problem, the Voting run, the ownership table, install | Workflows film |
| GitHub | README, release notes, description and topics | README images, CI badge |
| X | Thread: 1 failure (two agents overwrite each other) → 2 film → 3 ownership table → 4 Kahn diagram → 5 link | 30 s Workflows clip |
| Hacker News | "Show HN: Elpis – Rust-style ownership for teams of coding agents (Linux, open source)"; first comment: what is enforced, what is not yet | Link to README, not the website |
| Reddit | r/LocalLLaMA, r/ClaudeAI, r/ChatGPTCoding, r/rust (ownership angle only). Ask one question: how do you stop parallel agents overwriting each other? | Film or diagram |
| YouTube | Workflows film (full run), Logo film, Love Spot film | Real run times on screen |

## Launch day (all steps need Masih)

1. Morning: push `main`, publish the release, check the install line on a clean machine.
2. Deploy the website; post on masihmoafi.com.
3. 15:00–16:00 UTC (a weekday, Tuesday to Thursday): Show HN; stay in the thread for 4 hours.
4. One hour later: X thread, then YouTube.
5. Next day: Reddit, one subreddit per day, each post adapted, never cross-posted.
6. Message David Ondrej once the README and film are live.

## First-week metrics

| Metric | Source | Target (a guess, revise after day 1) |
| --- | --- | --- |
| Release downloads (terminal, desktop) | `gh release view --json assets` | over 200 |
| GitHub stars and forks | repo insights | over 300 stars |
| Issues opened by strangers | GitHub | over 10; each answered within 24 h |
| Show HN points and comments | HN | front page for 2 hours |
| Film views and watch-through | YouTube Studio | watch-through over 40% |
| Workflow runs reported finished | issues, X replies | 5 named users |

Prerequisites: `docs/launch/CHECKLIST.md` rows 1–8 and 13–17.
