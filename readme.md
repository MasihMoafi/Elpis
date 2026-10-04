# Elpis

Elpis is a Linux coding-agent environment built on OpenAI's Codex CLI. It keeps the execution and terminal foundation while adding control over admitted context, durable memory, continuity and provider selection.

**Change the runtime. Keep the thread.**

[Releases](https://github.com/MasihMoafi/Elpis/releases) · [Website](https://elpis.masihmoafi.com) · [Technical guide](docs/GUIDE.md) · [License](LICENSE)

## Install

[v0.4.1](https://github.com/MasihMoafi/Elpis/releases/tag/v0.4.1) is the Linux x86_64 release, based on Codex `rust-v0.160.0`. Review the installer before running it:

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/v0.4.1/scripts/install-elpis.sh | bash
~/.local/bin/elpis
```

The installer verifies SHA-256 checksums and installs Elpis, its Code Mode host and the bundled Linux sandbox. A Debian package is also available in the release. RTK is optional and is not installed automatically. macOS and Windows binaries are not included.

Sign in or configure a provider, then choose a model with `/model`.

## State and upgrades

Elpis uses `~/.elpis-next`, or the directory explicitly selected by `ELPIS_HOME`. It ignores inherited `CODEX_HOME`. Existing next-build users keep their state there.

v0.3.0's state database is incompatible with the new foundation. Elpis refuses that database and preserves it; automatic migration is not included. Keep a backup of the old executable for rollback. The [v0.3.0 guide](https://github.com/MasihMoafi/Elpis/blob/v0.3.0/readme.md) records that release's behavior and historical evidence.

## Included

- Context Ledger controls admission of workspace instructions, chosen files and memory; `/add` and `/context` expose the working set.
- The responding agent explicitly saves durable knowledge and the workspace checkpoint through a guarded local tool. Saving and admission are separate choices.
- `/compact` accepts a pressure threshold or custom instructions. Experimental Smart Prune and reasoning expiry limit disposable context.
- `/model` and `--provider` select providers; the local gateway supports Anthropic, Gemini and OpenRouter paths alongside OpenAI.
- `/dashboard` and `/usage` expose local session information. Subscription price remains unavailable.
- Elpis identity, composer queuing, chosen skills and permission controls surround the selected model.

No model weights, retrieval engine or speech engine are bundled. External capabilities come through tools or explicitly registered integrations.

## Verification and limits

Masih tested the September 30 candidate and accepted it for release. [Release CI](https://github.com/MasihMoafi/Elpis/actions/workflows/embedded-elpis-linux.yml) gates publication on focused Elpis Rust checks, actual runtime evals with failing controls, installer checks and clean offline binary/Debian installations. Automated evidence does not establish general coding-quality gains.

The whole inherited Codex suite is not claimed green: appearance/snapshot differences and identity-rename failures remain. `/force-prune`, Auto routing and `tui.appearance` are not ported. Strict configuration currently misses unknown keys in gateway-provider tables. Light-theme acceptance and all historical outcome-ledger cases remain separate from this release's acceptance.

## Development

Read [AGENTS.md](AGENTS.md), [the guide](docs/GUIDE.md), [shipping rules](docs/SHIPPING_RULES.md) and [local build rules](docs/LOCAL_BUILD_RULES.md) before changing or building Elpis. The upstream Rust workspace version stays at `0.160.0`; the Elpis product version lives in the CLI manifest and TUI branding constant.

Upstream Codex is Apache-2.0. Elpis retains its attribution and notices. See [LICENSE](LICENSE).
