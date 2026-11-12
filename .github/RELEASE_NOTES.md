Elpis 0.5.2 brings the Elpis chat, which routes your requests to your other chats, and a steadier desktop app.

## Which file do I need?

| File | What it is |
| --- | --- |
| `elpis_0.5.2_amd64.deb` | Terminal app (TUI) and the engine, for Ubuntu and Debian |
| `elpis-desktop_0.5.2_amd64.deb` | Desktop app, for Ubuntu and Debian. Needs the terminal package: install both together |
| `Elpis-0.5.2-x86_64.AppImage` | Both apps in one file, for Fedora, Arch, Omarchy and any other Linux |
| `elpis-linux-x86_64`, `elpis-code-mode-host-linux-x86_64`, `elpis-bwrap-linux-x86_64` | The terminal app's own files, used by the install script and the npm package |
| `*.sha256` | A checksum for each file |

Install (Linux x86_64):
- Ubuntu, Debian: `sudo apt install ./elpis_0.5.2_amd64.deb ./elpis-desktop_0.5.2_amd64.deb`, then `elpis-app`
- Fedora, Arch, Omarchy, any Linux: `chmod +x Elpis-0.5.2-x86_64.AppImage && ./Elpis-0.5.2-x86_64.AppImage` (add `elpis` for the terminal app)
- Terminal app only: `curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/v0.5.2/scripts/install-elpis.sh | bash`
- Terminal app with npm: `npm install -g elpis-cli`, then `elpis`

New in 0.5.2
- The Elpis chat: one chat that sees your other chats, starts and stops work in them, and tells you when one finishes, fails or waits for you.
- Workflows opens on a Map of your sessions: the Elpis chat, its workers, chats with their agents and workflow runs.
- Chats keep your reading place when earlier messages load and when you switch back.
- Zip files can be attached; they are unpacked into a folder the agent can read.
- Settings follow the ChatGPT app's layout, and each control that is off says why.
- Imported Claude Code chats show their tool calls as steps.
- Very large chats no longer freeze the app.
- Ctrl+Z and Ctrl+Shift+Z undo and redo chat actions.
- Terminal app: forced compaction and queued messages survive an interrupt; `/model` offers Claude accounts only for the Claude subscription.
- Security updates: OpenSSL 0.10.80, rustls 0.23.46, zip 9.1 and others.

Claude models run through your own Claude Code install. Every file has a SHA-256 checksum.
