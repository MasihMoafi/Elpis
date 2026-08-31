# Shipping Rules

Rules for anything that reaches a user's machine: the `elpis` binary, the installer,
and the `.deb`. Read this before a release or before changing code that reads the
filesystem, the environment, or the network.

The governing question is always: **what does this do on a machine that is not Masih's?**

## 1. Nothing personal in the binary

- **No absolute paths from a developer's home layout.** `~/Desktop/p/...`,
  `/home/<name>/...`, or any directory that exists only on one machine. Such a path
  scans a real directory on every user's system and silently admits whatever it finds
  into their context. This shipped in `v0.1.0` (`elpis_context.rs`, fixed 2026-07-25)
  and it also broke the tests that gate releases, because tests build a clean tempdir
  and got the developer's real files back.
- **Machine-specific locations are opt-in through configuration**, never a default:
  an env var, `config.toml`, or a CLI flag. External skill libraries use
  `skills.extra_roots` in the user's Elpis configuration.
- Paths derived from the user's own workspace (`cwd`, `CODEX_HOME`, `dirs::home_dir()`
  joined with an Elpis-owned directory) are fine. Paths derived from *our* workspace
  layout are not.
- The project's GitHub URL and authorship notes in comments are fine. They do not
  change what the program touches at runtime.

Before tagging, this must return only repo URLs:

```bash
grep -rn 'Desktop/\|/home/[a-z]' codex-rs --include='*.rs' | grep -v MasihMoafi
```

## 2. Verify on a machine that is not this one

`cargo build` succeeding here proves nothing about a fresh install. Neither does
"it works on my terminal."

- Install the actual published artifact in a clean container and run it.
- Check first-run behavior with no `~/.codex`, no config, no auth, no network cache.
- For anything that downloads at runtime, verify from an empty environment, because
  that is where pinned versions and missing artifacts fail.

## 3. Release mechanics

- **A tag push runs tests that a branch push does not** (see the `refs/tags/v` guards
  in `embedded-elpis-linux.yml`). A green `main` does not predict a green tag.
- **A failed tag run publishes nothing.** The tag will exist, the release will not, and
  `releases/latest` silently keeps serving the previous version. This is what happened
  to `v0.1.1` on 2026-07-24 and it went unnoticed for a day.
- **After tagging, confirm the release exists** — do not infer it from the tag:

  ```bash
  gh release list --limit 3
  ```

- A version number that never reached a user is not spent. Reuse it; the workflow
  replaces a re-tagged release rather than failing on it.
- The version in `codex-rs/tui/Cargo.toml`, the assertion in the workflow's
  "Verify executable identity" step, and `Cargo.lock` must move together, or the tag
  run fails on the version check.

## 4. Dependency weight is a shipping decision

- Do not make users download a machine-learning runtime for a feature they may not use.
  Prefer an API call or an already-installed local service; keep local models opt-in.
- Keep heavy imports lazy — inside the branch that needs them, never at module top
  level. A top-level `import torch` costs every user gigabytes even when their
  configured provider never touches it.
- Do not pin an exact version of a large dependency without a stated reason. An exact
  pin with no wheel for a newer Python breaks installs on newer distros.
- Optional features must degrade to a clear message, never a crash or a stall.

## 5. Do not commit build or test artifacts

`cargo test` writes `*.snap.new` and `.*.pending-snap` next to the sources when
snapshot tests fail. A blind `git add -A` sweeps in a hundred of them. Check
`git status --short` before staging.

## 6. Claims must match reality

Per `AGENTS.md`, Masih is the sole arbiter of done. In addition, for anything
user-facing:

- The README's stated version must be the version `releases/latest` actually serves.
- Do not describe a feature as available if the shipped install path cannot reach it.
- Never add a machine-learning dependency to this repository. Retrieval is an MCP server
  the user registers; the engine, its models, and their download size stay outside Elpis
  and outside the release artifact.

## 7. Selector evidence is not shipping evidence

`scripts/verify-elpis` is proportional local/Linux verification evidence, not shipping
evidence. Even a passing `--surface full` run does not replace:

- a release artifact build;
- installing or packaging that artifact, or launching the installed result;
- the tag-only workflow and confirmation that the release was published;
- verification on a clean machine or clean container;
- an authorized remote-CI run;
- Masih's manual acceptance.

The selector does not build or prove a shippable release artifact; it does not install,
package, launch, tag, publish, or grant acceptance. Its Cargo check and test rows may
still compile code and consume CPU and disk. Keep the release mechanics and
clean-machine checks above.
