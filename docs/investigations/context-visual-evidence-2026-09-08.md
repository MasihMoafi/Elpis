# Context visuals: evidence investigation

Date: 2026-09-08. Scope: investigation, not a product change or functional acceptance.

## Outcome

Learn primarily from OpenClaw's explicit relationship between tracked content and visual area, not its palette or exact layout. Borrow Hermes's category/provenance labels and Pi's post-compaction unknown state. Do not copy Hermes's minimum-one-cell sizing if the grid claims to represent percentages accurately. Preserve Elpis's own orange identity and consistent category semantics.

An upstream implementation is evidence of an approach, not proof that it meets Elpis's requirements. In particular, a tracked-character composition map is not a measured context-window occupancy gauge.

## Reference revisions and scope

All references are in the separate sibling `../elpis-references/` directory. They are intentionally partial source checkouts; `MANIFEST.json` records the initial selection. Two additional OpenClaw files were subsequently downloaded at the same pinned revision: `src/auto-reply/reply/context-treemap.ts` and `commands-context-report.test.ts`. Entire reference collection remains below 100 MB: 71,462,912 allocated bytes after these additions.

| Reference | Revision | Evidence inspected |
| --- | --- | --- |
| OpenClaw | `8ac88a1a335aa5f6ec467e539f6bbce3df478d84` | Context report, treemap renderer, report tests; focused execution of original grouping/layout functions |
| Hermes | `fef0e16fe19b79ded929209f87c7434270b03825` | Context breakdown, provenance tests; focused execution of original text renderer |
| Gemini CLI | `85aca163f6c73ac6ce380b5447359146b8adcae4` | Full Git path index, built-in command loader, context footer component/calculation/tests |
| Pi | `b2602be77cb7b0de45dd616407fd210daa48aa75` | Session context calculation, compaction estimation, footer |

## What the visuals actually mean

### OpenClaw

`src/auto-reply/reply/context-treemap.ts` groups conversation, workspace files, system prompt, tool schemas, and skills. Group values are tracked character counts. The binary layout divides rectangle areas proportionally to these values. This represents composition of tracked content, not percent of the full model window. Inner borders, padding, and labels mean exact raw layout area is not identical to the final painted pixel area.

Workspace files marked `native_unverified` are excluded. Project framing and skill text are separated from their parent prompt sections to avoid counting the same content twice. Tool-schema regions use serialized schema character counts. The caption explicitly distinguishes tracked characters/estimated tokens from cached actual context; unavailable actual usage is labeled unavailable. Group colors are categorical, not evidence of token accuracy.

The command/report tests include unknown-file exclusion, transcript/model-only content attribution, and refusing to draw a map from an estimated report. These full upstream tests were inspected, not run.

### Hermes

`agent/context_breakdown.py` contains shared category labels, glyphs, and dashboard color identifiers. Text categories carry `~` estimates, and the headline identifies provider usage, local estimates, or provider usage plus estimated new messages.

However, the 100-cell grid sizes each estimated category independently and grants every nonempty category at least one cell. It clips the concatenated cells to 100. This can exaggerate small categories and, at overflow, omit later categories. The grid/table free space derives from estimated totals, whereas the headline can derive from provider usage. Labeling the distinction helps, but the two must not be presented as one exact gauge.

### Pi

`packages/coding-agent/src/core/agent-session.ts:getContextUsage` combines the last valid usage with trailing-message estimates. Immediately after compaction it returns null usage/percentage until a valid post-compaction assistant measurement is available. The interactive footer renders that state as `?`. This is a useful truthful-state pattern, not a detailed visual decomposition to copy.

### Gemini CLI: bounded discovery, not an absence claim

The pinned tree index and `packages/cli/src/services/BuiltinCommandLoader.ts` did not reveal a built-in `/context` command. The loader explicitly registers memory and stats commands. A narrow search of the locally installed CLI bundle (version 0.54.4) also did not find a context-command registration. This does not rule out another release, custom command, extension, or differently implemented view; the user's observed `/context` remains unmatched. No claim about that view's design is justified by the current evidence.

The located `ContextUsageDisplay.tsx` displays rounded `promptTokenCount / tokenLimit(model)` and uses warning/error colors for thresholds. `contextUsage.ts` returns zero for missing/invalid model information, so this helper alone does not preserve an explicit unknown state. This footer is not a substitute for inspecting the user's `/context` view.

## Executed checks

Diagnostic harness: `/tmp/elpis-context-visual-check.mjs`. No dependencies installed. It executes OpenClaw's original pure functions after removing module imports and stripping TypeScript; only `expectDefined` is replaced with a small guard. PNG rendering and complete command execution are not exercised. Hermes's original module is executed with `runpy`; the checks call its real rendering functions. These are constructed inputs, not captured user sessions.

| Check | Observed result |
| --- | --- |
| OpenClaw 25/75 values inside a 100×100 rectangle | Areas 2,500 and 7,500; zero-valued item excluded |
| OpenClaw unknown injected file | Excluded; known file plus project frame totals 100 characters |
| OpenClaw skill/system separation | 10 skill characters removed from 50 non-project prompt characters, leaving 40 |
| OpenClaw provenance negative control | Changing the unknown file's provenance admits it; the exclusion check is sensitive to this input |
| Hermes empty / 50%-used estimated baselines | 0 / 50 filled cells |
| Hermes eight one-token categories, 10,000-token window | 8 filled cells (8%) for 0.08% estimated content: strict proportionality fails |
| Hermes 1,000 estimated category tokens, 8,000 measured total, 10,000 window | Grid 10%, headline 80%; same-occupancy invariant fails, with estimate/provenance text present |

Final harness exit: 0, meaning all diagnostic expectations were reproduced. It does **not** mean the intentionally failed visual invariants passed. Initial adapter mistakes in the harness were corrected before the successful run.

## Elpis source findings

Inspected `codex-rs/tui/src/chatwidget/context_usage.rs` and `context_ledger.rs`; no Rust code changed or Cargo checks run.

1. Overall grid fill derives from `last_token_usage.tokens_in_context_window()` relative to the model window, with a no-snapshot state. Category colors subdivide that used portion. Existing source tests cover half-full and oversize-category cases; they were not executed here.
2. `scale_token_counts` shrinks category estimates when their sum exceeds measured usage. It does not inflate them when below usage; the remainder becomes Other. Consequently, displayed category numbers can change when overall usage changes without their original content changing. Source attribution should remain inspectable separately from this display reconciliation.
3. The row-bar chart normalizes category widths against the largest category, whereas the overall bar uses the model window. These are different denominators and should be unmistakable to the reader.
4. INCLUDED/EXCLUDED labels use fixed cyan/amber, while section colors are independently selected. This directly explains the source-level mismatch with Masih's requested category-consistent styling.
5. The inspected context view has hard-coded yellow tool-call styling; the ledger has a yellow instruction-category color. Those call sites do not themselves enforce the requested no-yellow light-theme rule. Final terminal color behavior still requires a rendered light-theme check.
6. No explicit Tool schemas category was found in the inspected context_usage files, including corresponding worktree copies. Therefore this investigation cannot establish the precise cause of the reported changing schema numbers in the running application. Matching that surface to its actual implementation is a prerequisite to fixing it, not grounds to invent a cause.

## Recommended visual contract for implementation

- Keep occupancy (measured or explicitly estimated) separate from composition attribution.
- Every colored region names its quantity and maps to actual request content; inspection reveals source, inclusion, and measurement provenance.
- Use category colors consistently across chart, legend, ledger, and status text. Indicate inclusion separately through text/markers and muted treatment, not unrelated category colors.
- Do not enlarge tiny categories to imply a larger share. Keep them in the legend, with a less-than-one-cell label where appropriate.
- Never silently distribute unknown usage among known categories. Show unattributed/unknown state explicitly.
- Keep tool count separate from serialized schema size. Unchanged actual schemas must yield stable raw attribution; distinguish content changes from display normalization.
- After compaction, stale measurements must not masquerade as current usage. State freshness explicitly.
- Apply Elpis's orange palette to brand/chrome and activity text; reserve category colors for their stable meanings. Verify light mode without yellow and dark mode separately.

Implementation acceptance would require controlled changes to admitted content and tool definitions, pruning/reset/unknown states, positive and negative controls, and real light/dark terminal captures compared with the underlying request evidence. Those product changes and end-to-end checks are not claimed complete by this investigation.
