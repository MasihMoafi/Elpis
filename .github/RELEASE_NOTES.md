Elpis 0.5.4 builds the AppImage and desktop `.deb` on Ubuntu 22.04 (glibc 2.35), removes idle provider adapter workers, and fixes Matilda tidy dismissal and Workflows sidebar visibility.

## Which file do I need?

| File | What it is |
| --- | --- |
| `elpis_0.5.4_amd64.deb` | Terminal app (TUI) and the engine, for Ubuntu and Debian |
| `elpis-desktop_0.5.4_amd64.deb` | Desktop app, for Ubuntu and Debian (carries its own engine) |
| `Elpis-0.5.4-x86_64.AppImage` | Both apps in one file, for Fedora, Arch, Omarchy and any other Linux (`Elpis-0.5.4-x86_64.AppImage.zsync` for AppImageUpdate) |
| `elpis-linux-x86_64`, `elpis-code-mode-host-linux-x86_64`, `elpis-bwrap-linux-x86_64` | The terminal app's own files, used by the install script and the npm package |
| `*.sha256` | A checksum for each file |

Install (Linux x86_64):
- Ubuntu, Debian: `sudo apt install ./elpis_0.5.4_amd64.deb ./elpis-desktop_0.5.4_amd64.deb`, then `elpis-app`
- Fedora, Arch, Omarchy, any Linux: `chmod +x Elpis-0.5.4-x86_64.AppImage && ./Elpis-0.5.4-x86_64.AppImage` (add `elpis` for the terminal app)
- Terminal app only: `curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/v0.5.4/scripts/install-elpis.sh | bash`
- Terminal app with npm: `npm install -g elpis-cli`, then `elpis`

Fixed in 0.5.4
- Desktop packages (`Elpis-0.5.4-x86_64.AppImage` and `elpis-desktop_0.5.4_amd64.deb`) are now built on Ubuntu 22.04 for glibc 2.35 and newer, carry their own engine, embed AppImage update metadata (`.zsync`), and smoke-launch on Ubuntu 22.04 and 24.04.
- Opening Elpis, opening terminals, and listing cached models no longer leave idle Claude (`context-agent.mts`) or Antigravity (`agy-acp.mts`) adapter processes running; adapters start on demand and release when idle or closed.
- Matilda's tidy notification returns to her pinned button on `OK`, `Later`, or `Tidy`, and scheduled workflow runs appear in the sidebar `Workflows` section by default with `Workflows · ` names.
- Carries forward v0.5.3's self-contained OpenSSL build for Arch and Omarchy.

Claude models run through your own Claude Code install. Every file has a SHA-256 checksum.
