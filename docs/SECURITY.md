# Security Policy

## Supported versions

Only the latest published release of Elpis receives security fixes. Older tags are
not patched.

## Reporting a vulnerability

Report privately through GitHub's [Report a vulnerability](https://github.com/MasihMoafi/Elpis/security/advisories/new)
form. Do not open a public issue for an unfixed vulnerability.

Please include what an attacker gains, the steps to reproduce it, and the Elpis
version (`elpis --version`) and operating system you used.

You will get an acknowledgement within seven days. This is a single-maintainer
project, so a fix may take longer than that; you will be told where it stands.

## What Elpis does with your machine

Elpis runs a coding agent against your files and shell, so its security surface is
larger than a normal CLI. The parts that matter:

- **Permissions.** Read Only, Default, and Full Access modes gate file changes and
  command execution. Full Access removes those gates by design.
- **Sandboxing.** On Linux, commands run under bubblewrap. Sandbox escapes are
  in scope for this policy.
- **Credentials.** Provider API keys and session tokens live in your local
  configuration directory. Anything that exfiltrates them, or that routes a request
  to a provider you did not select, is in scope.
- **Durable evidence.** Conversations, terminal events, and artifacts are written to
  disk in plain files. Treat them as sensitive; they contain whatever your agent saw.
- **Telemetry.** Elpis uploads no analytics, and every OpenTelemetry exporter defaults
  to off. A build that transmits data without explicit configuration is a bug — report it.

## Out of scope

- The model provider's own behavior, including anything the model generates or refuses.
- Damage caused by a command you approved in Default mode or by running Full Access.
- Vulnerabilities in the upstream OpenAI Codex CLI that Elpis has not modified. Report
  those to that project; they will be picked up here on the next merge.
