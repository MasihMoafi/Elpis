# Security Policy

## Supported versions

Only the latest published release receives security fixes. Older tags are not patched.

## Reporting a vulnerability

Report privately through GitHub's [Report a vulnerability](https://github.com/MasihMoafi/Elpis/security/advisories/new)
form, not a public issue. Include what an attacker gains, the steps to reproduce it, the
Elpis version (`elpis --version`) and your operating system.

You get an acknowledgement within seven days. Elpis has a single maintainer, so a fix
may take longer; you will be told where it stands.

## What Elpis does with your machine

Elpis runs a coding agent against your files and shell:

- **Permissions.** Read Only, Default, and Full Access modes ([baseline](GUIDE.md#permission-baseline))
  gate file changes and command execution. Full Access removes those gates by design.
- **Sandboxing.** On Linux, commands run under bubblewrap. Sandbox escapes are in scope.
- **Credentials.** Provider API keys and session tokens live in your local configuration
  directory. Anything that exfiltrates them, or routes a request to a provider you did
  not select, is in scope.
- **Durable evidence.** Conversations, terminal events, and artifacts are written to
  disk as plain files. They contain whatever your agent saw; treat them as sensitive.
- **Telemetry.** Elpis uploads no analytics, and every OpenTelemetry exporter defaults
  to off. A build that transmits data without explicit configuration is a bug; report it.

## Out of scope

- The model provider's own behavior, including anything the model generates or refuses.
- Damage from a command you approved in Default mode or from running Full Access.
- Vulnerabilities in upstream OpenAI Codex CLI code that Elpis has not modified. Report
  those to that project; they arrive here with the next merge.
