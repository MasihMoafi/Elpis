# Claude accounts: update handoff — 20 October 2026

## Current evidence

- The second-email requirement is resolved. Masih's default Pro login and Reza's isolated login are authenticated, have distinct identities and organizations, and are both retained by the account index. The saved default remains Masih's account. No additional login or credential copying is needed.
- Implementation branch: `feat/claude-accounts-20261020`. Implementation commits: `fea460113` and `d87d83fef`; outcome checkpoint: `c662d0946`.
- Fresh verification: 15 provider/account checks, 8 desktop/API checks, and TypeScript pass. Three focused checks against the actual selected provider bundle also pass. Account routing, usage, conversation continuity, active-turn rejection, duplicate detection, private storage, CLI browser-code sign-in, and the reported popup crash have evidence.
- The running bridge is still the older `tui-ledger-20261019-fb21bb0d-edf91367` bridge (PID 14989 at this checkpoint). Its account RPC requires a restart. The selected next native version is `claude-accounts-20261020-fea460113`.
- Current selected desktop: `composer-chats-20261020-09537abaa`. It retains the exact tested popup fix and matching manifest hash. This newer renderer must be preserved; its suffix is not a commit available in this checkout and it has no `out/.commit` marker.
- No credentials, installed bundles, runtime selectors, or running chats were changed during this resumed verification. No push, publication, build, deployment, or restart was performed.

## Remaining input

One user authorization is outstanding: permission to push the integrated change to a temporary branch such as `build/claude-accounts-20261020` on `MasihMoafi/Elpis`, run the existing `elpis-desktop.yml` GitHub Actions renderer build, and retrieve its artifact. Existing project instructions require permission before pushes and require GitHub Actions for renderer builds. The renewed priority instruction did not lift that prohibition. Do not ask for another email.

## Local integration and update checklist

1. Coordinate the authoritative desktop source with the session owning the composer/chat changes. Do not replace the current renderer with a build of this older feature branch alone.
2. Integrate the account changes into that source, preserving existing dirty work. Prepared patches are `/tmp/elpis-claude-accounts-20261020/desktop-source.patch` and `/tmp/elpis-claude-accounts-20261020/provider-source.patch`. Both pass `git apply --check` against `Elpis-wt-working-facets-20261020`. In `Elpis-wt-continuity`, the overlapping files are `desktop/browser.cjs`, `desktop/browser.test.cjs`, and `tools/elpis-claude/acp-bridge.mjs`; merge those deliberately rather than overwriting them. These were checks only; neither source was modified.
3. Run the focused account/provider/API/browser checks and TypeScript on the integrated source; commit the exact build candidate locally. The only untracked files in this feature worktree are its two development `node_modules` symlinks.
4. After explicit approval, push that candidate to the agreed `build/*` branch. Wait for the existing workflow, download the `renderer` artifact, and check its `out/.commit` against the exact candidate commit. This authorizes a build branch, not a release or publication.
5. Run `tests/anthropic-signout.test.cjs` against that renderer, including its new two-account selector scenario. Inspect the account card and sign-in-code field, and check light/dark and constrained layout. The actual renderer scenario and visual checks have not yet run; there is no local renderer build.
6. Coordinate before touching shared installed bundles. Preserve the latest chat/composer changes and popup fix, validate the staged manifest, and perform the checked update through Elpis's graceful update path. Preserve active/saved conversations and drafts; do not kill an active provider turn or change credentials.
7. After the graceful restart, verify `claudeAccounts/read` on the live bridge returns both distinct accounts and the correct selected default. Verify identity/usage for each selection without paid inference, then obtain Masih's acceptance. Recorded automated checks alone do not establish completion.
