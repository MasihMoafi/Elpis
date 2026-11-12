Elpis 0.5.3 starts on Arch and Omarchy again: the terminal app carries its own OpenSSL.

## Which file do I need?

| File | What it is |
| --- | --- |
| `elpis_0.5.3_amd64.deb` | Terminal app (TUI) and the engine, for Ubuntu and Debian |
| `elpis-desktop_0.5.3_amd64.deb` | Desktop app, for Ubuntu and Debian. Needs the terminal package: install both together |
| `Elpis-0.5.3-x86_64.AppImage` | Both apps in one file, for Fedora, Arch, Omarchy and any other Linux |
| `elpis-linux-x86_64`, `elpis-code-mode-host-linux-x86_64`, `elpis-bwrap-linux-x86_64` | The terminal app's own files, used by the install script and the npm package |
| `*.sha256` | A checksum for each file |

Install (Linux x86_64):
- Ubuntu, Debian: `sudo apt install ./elpis_0.5.3_amd64.deb ./elpis-desktop_0.5.3_amd64.deb`, then `elpis-app`
- Fedora, Arch, Omarchy, any Linux: `chmod +x Elpis-0.5.3-x86_64.AppImage && ./Elpis-0.5.3-x86_64.AppImage` (add `elpis` for the terminal app)
- Terminal app only: `curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/v0.5.3/scripts/install-elpis.sh | bash`
- Terminal app with npm: `npm install -g elpis-cli`, then `elpis`

Fixed in 0.5.3
- Arch moved to OpenSSL 4, and the terminal app of 0.5.1 and 0.5.2 stopped with "libssl.so.3: cannot open shared object file" there, which also left the desktop app without its engine. The engine now carries its own OpenSSL and uses your system's certificates; each release build checks that no shipped file needs a system OpenSSL and that HTTPS works on Ubuntu and on Arch.

Claude models run through your own Claude Code install. Every file has a SHA-256 checksum.
