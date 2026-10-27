# Elpis Agent Map

## Start

- `VISION.md`: project purpose. `docs/HANDOFF.md`: current project state, installed/candidate versions, worktree triage and next action. `ES.md`: earlier session notes; read the handoff first.
- Desktop app work: `apps/elpis-desktop/SPEC.md` lists what to build, with acceptance checks and state. Masih's rules are in `~/Desktop/p/skills/dev/MASIH-RULES.md`; read its `[all]` rules and the R rules before UI work.
- Product and architecture: `docs/GUIDE.md`. Context, session and pruning behavior: `docs/context.md`, `docs/sessions.md`. Anything that reads the filesystem, environment or network, or a release: `docs/SHIPPING_RULES.md`. Builds: `docs/LOCAL_BUILD_RULES.md` (GitHub Actions only).
- Verify repository state before editing and preserve unrelated changes.

## Rules that matter here

- Masih is the sole arbiter of truth. CI, tests and agent claims are evidence, not acceptance. Say plainly what is partial or unchecked.
- Never restart his running app. Desktop installs go forward only, through `apps/elpis-desktop/scripts/install-desktop.mjs`.
- Evals first: behavior that can silently do nothing needs a test that fails before the change and passes after, with a positive and a negative case.
- Keep text readable against its real background in both themes, including secondary labels and animated highlights.
- Do not run two agents against the same files. One coordinator owns `GUIDE.md`, `docs/USER_REQUESTS.md` and integration; workers do bounded tasks and do not rewrite them.
- Website only (`website/`): use daisyUI, following `.agents/skills/daisyui/SKILL.md`. The desktop app uses shadcn components and the tokens in `apps/elpis-desktop/app/globals.css`.

## Delegation

Every delegated prompt states: task ID, the user-visible behavior, why, allowed files, forbidden scope, the acceptance test, required checks, and what to return (summary, changed files, verification, risks, commit hash). For deterministic multi-agent graphs follow `docs/WORK_GRAPHS.md`.
