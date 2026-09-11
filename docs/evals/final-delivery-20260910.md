# Local delivery — September 10, 2026

This records the earlier installed build. Subsequent corrections and current
verification are tracked in [the terminal and release investigation](terminal-selection-20260910.md).
The current pressure threshold is 30; the historical value below was 25. The newer
source candidate has not yet been installed or published as the final release.

Installed for Masih's acceptance. One checkout remains: `/home/masih/Desktop/p/Elpis`
on `main`. No public release or additional research campaign was performed.

## Included changes

- Tab exclusively toggles the ledger during conversations and bottom-pane views;
  it preserves drafts and never queues or submits them. The sidebar needs 80
  columns. It displays cached sources, and explicitly distinguishes source
  estimates from request usage that is unmeasured before the first request.
- Up with an empty composer restores all queued follow-ups in order for editing.
  Already submitted steers remain in flight; the dedicated edit-last shortcut
  retains its existing behavior.
- Removed the equalizer beside “Elpising” and obsolete text-dissolve code. The Elpis
  name retains its original brand colors; permission and active Read/Search/Run labels animate
  their existing gradient. Reduced-motion settings remain respected.
- Transcript and ledger glyphs remain stable. Removed the artificial 500 ms line
  commit delay. The caret is hidden during drawing and restored at its final
  position to address transient colored cursor artifacts.
- `/context` evidence uses readable foreground styling. Category shares estimate
  context contents; they are not percentages determined by reasoning effort.
  See `context-attribution-audit-20260910.md` for the earlier 18% investigation.
- `/compact N` checks pressure before each user turn for finite 0 < N < 70.
  Masih's installed threshold is 25. Plain `/compact` still acts immediately.
- Smart Prune uses Low optimizer effort, retaining original-output fallback on
  failures. Optimized builds include both CLI and standalone IDE runtime, with
  at most two Cargo jobs and one compiler thread by default.
- IDE 0.1.19 disables Send until JavaScript initialization. An early submit can
  otherwise navigate the webview into a blank page. No previous session is needed.

## Artifacts and evidence

CLI `~/.local/bin/elpis`, version 0.2.0, SHA256:
`d94d86f7ee81698aec3a7ec9408caa2c2d63cf8ea7378e201bc1a31ff7f3ae66`.
IDE `elpis-local.elpis-editor` 0.1.19, bundled runtime SHA256:
`3cf9f152a278176418c8b96c075aa72d4bffe77c25b51a782b0166fcecfa84da`.

After Masih's UI review, the Elpis name's white shimmer was reverted to its
original brand styling. This correction was rebuilt and installed; the rebuild
from the sole main checkout took 11m 05s, including dependency recompilation.

Before removing the integrated candidate, Rust subtree hashes matched main:
`2487059958e8179c600bb3c754736ab33d114825`; editor subtree:
`60ecb5686f2bc650c643c9cc277b4cd24c8cd222`.

- 158 focused Rust checks passed; three optional captures were skipped. Coverage:
  context/ledger, compaction, Up/Tab, motion, status, terminal drawing, command
  rendering, startup, streaming. Warnings remain; no full inherited-suite claim.
- 44 editor Node checks passed with a real runtime. `editor.test.js` is an extension
  host harness, not a standalone Node test.
- Final installed IDE and bundled runtime passed six actual VS Code webview
  conversations: two each in empty, file-only, and project-folder windows. The old
  build failed early submit with `ERR_BLOCKED_BY_CLIENT`; the change passed.
- Old CLI failed the real VTE Tab control: it queued the draft and kept the ledger
  open. Candidate and installed replacement passed toggle/no-send/draft retention
  and native drag selection of an exact streamed sentinel. Local-provider latency
  was 103 ms and 105 ms. One intermediate selection capture failed before a
  successful installed repeat; universal elimination of terminal artifacts is
  not established. Masih's terminal remains the acceptance environment.
- Both optimized binaries built successfully. Final cached build: 12.9 seconds,
  peak 62 C. This is not a cold-build or general Codex performance comparison.
- Four Smart Prune aggregation checks passed, covering duplicates, failures,
  missing usage, unrelated-text negatives, and independent totals.

Raw local evidence remains in `.tmp/final-candidate` and
`.tmp/candidate-build-evidence`. The installed app was opened in a visible terminal;
its real workspace ledger showed admitted sources. Existing CLI processes retain
the old binary. VS Code needs **Developer: Reload Window** to load 0.1.19.

## Recovery, memory, research

The original 79 worktrees were not 79 finished features. The coherent latest CLI
was restored and integrated. Twenty unfinished experiments remain committed under
`recovery/committed-20260910/*`, including 178 previously untracked source/evidence
files. Original backup branches and `.git/worktree-recovery-20260910*` archives
remain. Only the integrated candidate checkout was removed in this delivery.
See `../WORKTREE_CLEANUP_20260910.md`. Preserved experiments are not claimed to be
integrated or accepted features.

Memory is manual: edit `MEMORY.md` and explicitly admit it through the ledger.
There is no automatic extraction, consolidation, or promotion pipeline. The paper
has a draft, synthetic evidence, and limited real-task pilots; universal cost or
quality improvements and fewer compactions remain unproven.

The refreshed [Smart Prune report](smart-prune-usage-20260910.html) records 1,776,029
estimated tokens removed, 726 successful batches, and 19 sessions. Optimizer usage
was 7,225,368 tokens. These counters do not establish net token or monetary savings.

## Masih's checklist

1. Start the installed Elpis. Inspect ledger sources; press Tab twice during a
   reply with a draft present. It should close/reopen without sending the draft.
2. Queue two follow-ups, then press Up with an empty composer. Both should return
   in order, editable, without autosending.
3. Type and drag-select during replies. Check the red caret artifact, original Elpis
   brand colors, animated permission/tool labels, and absence of the old equalizer.
4. Inspect lower `/context` evidence. Try `/compact 30`, then `/compact 25` to
   restore the installed threshold; plain `/compact` remains immediate.
5. Reload VS Code, open a different project or an empty window, open Elpis, and
   send a first message. Start another new chat and repeat.

Rollback CLI: reinstall
`~/.local/share/elpis/release-recovery/final-20260910/elpis-before` with
`scripts/install-elpis-binary.sh`. Prior IDE 0.1.18 VSIX remains in
`~/.local/share/elpis/release-recovery/latest-cli-20260910-MocvHE/`.
