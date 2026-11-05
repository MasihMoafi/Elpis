# Desktop verification

## Definition of done

Masih, 24 Oct: "make sure all the issues are fixed not just addressed and also end-2-end tested, unit-tested, all sort of tests … especially all features". The rules come from *AI-Native Software Engineering* ch. 8 and *Clean Code* ch. 9 (his books, ~/Desktop/books). An item is done only when all hold:

1. **The end-to-end test bites.** A test drives the real packaged app and the real engine as he would (clicks, keys, restarts) and checks what he sees. It fails on the build before the fix and passes after; both runs are recorded. A test written with the fix and never seen failing proves nothing ("tests are theater" when one agent writes code and tests).
2. **Unit tests for the logic, property tests for its rules.** Every changed function has unit tests that assert behaviour, not lines walked or source text. Logic with a rule that must hold for any input (paging and ordering, list and tree building, journal and resume, archive then unarchive) gets property-based tests over many inputs and the edges: empty, one, boundary, Unicode.
3. **F.I.R.S.T.** Tests are fast, independent (one failure never cascades), repeatable (wait for states, never for luck; a busy machine must not fail them), self-validating (pass or fail, no log reading) and written first.
4. **The whole gate is green.** `npx tsc --noEmit -p .`, `npm test` (fast, bridge, desktop and every UI file) and every opt-in runtime test the change touches, run on the integrated commit before any install.
5. **A fresh adversarial review.** Before any install, a reviewer that did not write the change (a fresh session, a different model where possible) reads the diff and its tests with the brief "assume it has bugs": the wrong thing built against his words, missed edge cases, tests that would not catch a regression, leftovers (debug code, unused helpers), personal data in logs, SPEC.md not updated. Its findings are fixed and re-tested.

## The gate

`test-inventory.json` owns every app test exactly once: **fast** (helpers and component contracts), **bridge**, **desktop** (main/preload contracts), **ui** (browser journeys) or **opt-in** (native/engine). The gate scans app sources, including legacy files importing `node:test`; unassigned, duplicate and missing files fail before any test runs. Add new tests to the inventory.

**`npm test`** runs the complete ordinary gate serially: build bridge resources → fast → bridge → desktop → locked renderer build → every UI file, with a 180 s limit per file. Resources are prepared before any selected tier; only UI runs build the renderer, once, before their first file. It needs no prebuilt resources or `out/`. Set `ELPIS_PLAYWRIGHT_PACKAGE` when Playwright is outside local dependencies and `ELPIS_CHROMIUM` for a system browser. Tier runs use a throwaway `ELPIS_HOME`. Dependencies must already exist; the gate never installs anything. `npm run test:inventory` checks ownership; `npm run test:fast`, `test:bridge`, `test:desktop` and `test:ui` select a tier from the same inventory.

Each run prints `/tmp/elpis-test-gate-*/summary.json` and keeps per-file TAP and build logs there. `wallMs` includes shared-lock waits and build time; `testMs` sums Node test durations without them. Compare like scopes: the architecture review measured bridge 4.77 s (328), desktop plus selected helpers 3.06 s (155), renderer 3.84 s (1) and live-events 0.18 s (13), **without a full UI gate measurement**. A focused browser test: `flock /tmp/elpis-desktop-ui.lock node --test --test-timeout=180000 --test-reporter=tap tests/<file>`, output redirected to a TAP file.

Focused checks: `npm run test:drafts` (drafts); `npm run test:desktop` (includes browser and dictation checks); `tests/project-journey.runtime.mjs` checks the actual desktop and installed runtime with isolated local inference.

Opt-ins stay explicit; never run the whole tier blindly. `ELPIS_TEST_ENGINE=/absolute/elpis-next node --test tests/composer-engine.test.mjs` uses an isolated engine without inference. Native window tests (`code-opens-electron`, `session-windows-electron`) need a private display: `ELPIS_PRIVATE_DISPLAY=1 xvfb-run -a flock /tmp/elpis-desktop-ui.lock node --test tests/<file>.test.cjs`. Other runtime scripts document their arguments and profile isolation in their headers; some make subscription turns. Keep `ELPIS_HOME` isolated and read the script before running it.

## Artifact gate and install

GitHub's desktop workflow tests the exact exported renderer before uploading it. The artifact gate keeps the UI tests and helpers from its committed baseline, plus the saved-workspace round-trip test, and also runs candidate additions and changed tests. The baseline reconstructs the deployed workspace reader, including both project-chat and Session Manager keys; it does not declare every existing feature accepted. Removing or weakening a candidate test cannot remove the retained regression. Each file must run named cases with no failures, skips, cancellations or todos. A timeout blocks the artifact.

The receipt binds the source commit, baseline, test plan, results and renderer bytes. `install-desktop.mjs NAME --actions` verifies it again on both the downloaded and the packaged renderer, checks packaged production sources and generated app identity against the original commit, and rechecks the clean source before changing the selector. Use this installer and verifier for every candidate; an older branch's installer lacks these checks. Follow the [desktop build rules](../../docs/LOCAL_BUILD_RULES.md); a local install needs `out/.commit` to match the commit. Keep the deployed source repairs when assembling a candidate, and let Masih verify one visible change before advancing the retained baseline.

## Request diagnostics

Bridge failure responses carry `code`, `requestId` (also `X-Request-Id`) and, when present, a numeric `runtimeCode`. Error notices show the code and ID through `lib/api.ts`. HTTP 5xx diagnostics go to `<ELPIS_HOME>/logs/desktop-requests.jsonl` (0600): timestamp, ID, fixed method/area/cause categories, status and codes only. No bodies, headers, query strings, paths, error messages or stacks enter the log. Writes serialize per bridge; the file resets at 1 MiB (at most about 1 MiB plus one record). If file logging fails, the same sanitized record goes to stderr. This limits forensic detail and retention on purpose; unknown-delivery messages keep their wording and no request is retried automatically.
