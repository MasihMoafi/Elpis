# Terminal permission repair — October 9, 2026

Full Access could appear selected while an active turn retained its previous
approval policy and sandbox. Native dispatch now reads accepted permission changes;
the ACP bridge reads confirmed engine settings instead of its turn-start policy.
Revoking ACP bypass stops the active turn. Rejected updates never grant access.

Reproduce with an absolute engine path:

```sh
node scripts/permissions-runtime.test.cjs /path/to/elpis
node scripts/permissions-runtime.test.cjs /path/to/elpis --code-mode
node scripts/permissions-bridge.test.cjs /path/to/elpis
node scripts/permissions-bridge.test.cjs /path/to/elpis --gemini
```

These use the real engine/bridge, isolated homes, and deterministic local provider
fixtures. Native tests assert actual writes into protected workspace metadata. Bridge tests
assert ACP approval outcomes and fixture writes through Claude's ACP interface and
Gemini's real adapter/approval socket. No provider credentials are used.

Installed baseline failed the mid-turn switch on native tools, code mode, Claude
and Gemini. Baseline evidence: `/tmp/elpis-live-permissions-EK63pC`,
`/tmp/elpis-live-permissions-yEGVdd`, `/tmp/elpis-bridge-permissions-KPi5sg`,
`/tmp/elpis-bridge-permissions-6TsVQR`.
The built candidate passes 12 native checks and 14 code-mode checks (including
nested tools in an already-running cell), plus 20 Claude and 14 Gemini checks.
Coverage includes restricted/never, rejected updates, automatic-edit revocation,
refusing a prompt when the provider rejects a restricted mode, and rejecting
stale approvals or delayed plan-mode changes after revocation. Evidence:
`/tmp/elpis-live-permissions-ZPrxvA`, `/tmp/elpis-live-permissions-2Lf9Nz`,
`/tmp/elpis-bridge-permissions-MPSFYH`, `/tmp/elpis-bridge-permissions-xy6MUk`.
Seven real terminal checks pass: Full Access selection and protected writes,
Enter steering, Shift+Up questions, visible names at 40/80 columns, and task
rename/delete controls. Evidence: `/tmp/elpis-terminal-input-LajZ0z`.
Production build passed. Focused Rust tests and the final color build remain in
progress. Nothing installed yet.

The October 8 security-session notes match the current Elpis defaults:
`:workspace` with `on-request`. Those defaults remain unchanged; an explicit
Full Access selection must take effect on the current turn. Login shells also
source Ubuntu's im-config initializer, whose systemd journal logging can emit
`Failed to create stream fd` inside the sandbox even when the requested command
succeeds. An isolated `pwd` comparison reproduces the warning only with login
startup, and `systemd-cat` reproduces the same error directly.

User check after installation: restart Elpis, select Full Access during a reply,
and confirm the following command runs without an approval prompt. Repeat with
GPT, Claude and Gemini. Switch back to Default and confirm restrictions return.
Automated evidence does not replace Masih's acceptance of the terminal behavior.
