# Plan: move the desktop bridge and Electron main to TypeScript

Status: plan only (6 Nov 2026). Nothing has moved yet.

## Goal

Every file in `apps/elpis-desktop/bridge`, `desktop` and `lib` (219 `.mjs`/`.cjs` files: 118 sources, 101 tests) becomes TypeScript under the strict flags DeepSeek Harness uses, with each step kept green by the checks below.

## The checks that keep each batch green

All run from `apps/elpis-desktop` and in CI (`.github/workflows/lint.yml`, job `strict`):

- `npm run typecheck`: the renderer, which must stay at zero errors.
- `npm run typecheck:strict` (`tsconfig.node.json`, `tsconfig.strict.json`): the JS with `checkJs`, and the renderer under `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride` and `noFallthroughCasesInSwitch`.
- `npm run lint` (oxlint, `.oxlintrc.json`) and `npm run duplication` (jscpd, `.jscpd.json`).
- `strict-baseline.json` holds every existing finding, per file and rule. A count may only go down, and a file not listed must be clean. After a fix, record it with `node scripts/strict-baseline.mjs <check> --update`; that command refuses to raise a count.
- The test tiers in `test-inventory.json`, run by `.github/workflows/elpis-desktop.yml` on every push to `main` and `integrate/**` and on every pull request.

Baseline on 6 Nov: 9,143 JS type errors (TS7006, untyped parameters, is about half), 496 renderer errors under the extra flags, 365 lint findings, 5 duplicate blocks (0.10% of lines).

## Before the first batch

1. Check whether Electron 44's Node runs `.mts`/`.cts` directly (type stripping). If it does, the bridge runs its sources with no build step: add `erasableSyntaxOnly`, `allowImportingTsExtensions` and `rewriteRelativeImportExtensions` to `tsconfig.node.json`. If it does not, add one `tsc` emit step for `desktop/` and keep the bridge on Node 26 stripping.
2. Teach `desktop/package.mjs` (its explicit file list, checked by `desktop/package.test.mjs`), `scripts/test-gate.mjs` and `.jscpd.json` the new extensions.

## Order: leaf modules first

The import graph of the 118 sources has 13 levels. A batch moves files whose local imports have already moved, so each one compiles against typed neighbours:

| Batch | Level | Sources | Type errors now | Examples |
|---|---|---|---|---|
| 1-3 | 0 (import nothing local) | 53 | 759 | `bridge/app-identity.mjs`, `bridge/love-spot-order.cjs`, `lib/*.mjs` |
| 4-5 | 1 | 25 | 701 | `bridge/github-connector.mjs`, `desktop/improve.cjs` |
| 6 | 2-3 | 13 | 768 | `desktop/preferences.cjs`, `bridge/workflow-acp.mjs` |
| 7 | 4 | 1 | 495 | `bridge/client.mjs` (175 KB), on its own |
| 8-9 | 5-6 | 18 | 675 | `bridge/files.mjs`, `desktop/runtime.mjs` |
| 10 | 7-12 | 8 | 563 | `bridge/server.mjs`, `desktop/browser.cjs`, last `desktop/main.cjs` |

A test file moves in the same batch as the module it tests. The rest of the errors sit in the tests and in the imported `tools/elpis-claude` files.

## One batch

1. Rename 10-20 files (`.mjs` to `.mts`, `.cjs` to `.cts`) and their tests. Update their importers in the same commit.
2. Type the exported functions first. Then clear the file's errors without `any`: use `unknown` and narrow it.
3. Run `node scripts/strict-baseline.mjs --update`. The moved files must leave the baseline at zero; a file still listed means the batch is not done.
4. Run the batch's test tier locally against the last CI build, then push. CI runs the full set.
5. Keep each batch to one commit, so a failure reverts cleanly.

## Done

- No `.mjs`/`.cjs` remains in `bridge`, `desktop` or `lib`, except files a tool requires as JS (record the reason beside each).
- `tsconfig.node.json` passes with no baseline entries, and the strict flags move into `tsconfig.json`.
- `strict-baseline.json` lists only lint and duplication findings still being worked down.
