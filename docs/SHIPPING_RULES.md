# Shipping Rules

Rules for anything that reaches a user's machine: the `elpis` binary, the installer,
and the `.deb`. Read them before a release, or before changing code that reads the
filesystem, the environment, or the network.

The governing question: **what does this do on a machine that is not Masih's?**

## 1. Nothing personal in the binary

- **No absolute paths from a developer's home layout** (`~/Desktop/p/...`,
  `/home/<name>/...`). Such a path scans a real directory on every user's system and
  silently admits what it finds into their context; `v0.1.0` shipped one
  (`elpis_context.rs`, fixed 2026-07-25).
- **Machine-specific locations are opt-in configuration**, never a default: an env var,
  `config.toml`, or a CLI flag. External skill libraries use `skills.extra_roots` in the
  user's Elpis configuration.
- Paths derived from the user's own workspace (`cwd`, `CODEX_HOME`, `dirs::home_dir()`
  joined with an Elpis-owned directory) are fine; paths derived from *our* workspace
  layout are not.
- The project's GitHub URL and authorship notes in comments are fine: they do not change
  what the program touches at runtime.

Before tagging, this must return only repo URLs:

```bash
grep -rn 'Desktop/\|/home/[a-z]' codex-rs --include='*.rs' | grep -v MasihMoafi
```

## 2. Verify on a machine that is not this one

A local `cargo build`, or a working local terminal, proves nothing about a fresh install.

- Install the published artifact in a clean container and run it.
- Check first-run behavior with no `~/.codex`, no config, no auth, no network cache.
- Verify anything that downloads at runtime from an empty environment, where pinned
  versions and missing artifacts fail.

## 3. Release mechanics

- **A tag push runs tests that a branch push does not** (the `refs/tags/v` guards in
  `embedded-elpis-linux.yml`). A green `main` does not predict a green tag.
- **A failed tag run publishes nothing.** The tag exists, the release does not, and
  `releases/latest` silently keeps serving the previous version (`v0.1.1`, 2026-07-24,
  unnoticed for a day).
- **After tagging, confirm the release exists**; do not infer it from the tag:

  ```bash
  gh release list --limit 3
  ```

- A version number that never reached a user is not spent. Reuse it; the workflow
  replaces a re-tagged release rather than failing.
- **A tag publishes everything; no file is built or uploaded by hand.** The tag run publishes the terminal
  files; the "Elpis desktop packages" workflow, on the same tag, attaches the AppImage (with its `.zsync`) and the
  desktop `.deb`, each with a `.sha256`, once the release exists, and replaces nothing. It builds on Ubuntu 22.04
  so every binary needs glibc 2.35 or older: a laptop build needs the laptop's glibc ([build rules](LOCAL_BUILD_RULES.md#desktop-packages-appimage-and-desktop-deb)).
- Move the version in `codex-rs/tui/Cargo.toml`, the assertion in the workflow's
  "Verify executable identity" step, and `Cargo.lock` together, or the tag run fails the
  version check.

## 4. Dependency weight is a shipping decision

- Do not make users download a machine-learning runtime for a feature they may not use.
  Prefer an API call or an already-installed local service; keep local models opt-in.
- Import heavy dependencies lazily, inside the branch that needs them, never at module
  top level. A top-level `import torch` costs every user gigabytes even when their
  provider never touches it.
- Do not pin an exact version of a large dependency without a stated reason. An exact
  pin with no wheel for a newer Python breaks installs on newer distros.
- Optional features degrade to a clear message, never a crash or a stall.

## 5. Claims must match reality

For anything user-facing:

- The README's stated version must be the version `releases/latest` serves.
- Do not describe a feature as available if the shipped install path cannot reach it.
- Retrieval and speech dependency boundaries: [technical guide](GUIDE.md#confirmed-requirements).

## 6. Selector evidence is not shipping evidence

`scripts/verify-elpis` is local verification, not shipping evidence; even a passing
`--surface full` run does not replace:

- a release artifact build;
- installing or packaging that artifact, or launching the installed result;
- the tag-only workflow and confirmation that the release was published;
- verification on a clean machine or clean container;
- an authorized remote-CI run;
- Masih's manual acceptance.

Its Cargo rows still compile code and use CPU and disk.

## 7. Provider network environment

Codex app-server children connect directly, with proxy variables cleared in both letter
cases and Node's environment-proxy switch removed. The provider bridge retains its
inherited settings for Mother. Case, 12 Nov: ordinary chats and private helper engines
inherited the paid VPN. Check all launch paths with
`node --test tools/elpis-claude/test/native-proxy.test.mts`.
