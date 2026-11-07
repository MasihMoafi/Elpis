#!/usr/bin/env bash
# build-snap.sh [VERSION]: the elpis-agent snap (classic confinement): the desktop app with Electron, the engine, its
# provider bridge (tools/elpis-claude) and a terminal launcher. Packed with `snap pack` from a prepared folder, so no
# build VM is needed. Run `npm run build` in apps/elpis-desktop first.
#   ENGINE_DIR  a folder with codex, codex-code-mode-host and bwrap (a CI build); default: the installed engine.
#   ELECTRON_DIST  an Electron folder; default: the checkout's, else the installed app's (no download).
set -euo pipefail
VERSION=${1:-0.5.1}
R=$(cd "$(dirname "$0")/.." && pwd -P); APP=$R/apps/elpis-desktop
commit=$(git -C "$R" rev-parse HEAD)
built=$(cat "$APP/out/.commit" 2>/dev/null || true)
[[ "$built" == "$commit" ]] || { [[ -n "$built" ]] && git -C "$R" diff --quiet "$built" "$commit" -- apps/elpis-desktop ':!apps/elpis-desktop/scripts'; } \
  || { echo "apps/elpis-desktop/out is not built from $commit: run npm run build" >&2; exit 1; }
installed=$(dirname "$(readlink -f ~/.local/bin/elpis-next)")
if [[ -n "${ENGINE_DIR:-}" ]]; then codex=$ENGINE_DIR/codex; host=$ENGINE_DIR/codex-code-mode-host; bwrap=$ENGINE_DIR/bwrap
else codex=$installed/codex; host=$installed/codex-code-mode-host; bwrap=$installed/../codex-resources/bwrap; fi
for f in "$codex" "$host" "$bwrap"; do [[ -x "$f" ]] || { echo "missing engine file: $f" >&2; exit 1; }; done
bridge=$R/tools/elpis-claude
[[ -d "$bridge/node_modules/@agentclientprotocol/claude-agent-acp" ]] || { echo "run npm ci --omit=dev in tools/elpis-claude" >&2; exit 1; }

mkdir -p "$HOME/.cache/elpis-tests"; STAGE=$(mktemp -d "$HOME/.cache/elpis-tests/elpis-snap.XXXXXX"); S=$STAGE/prime
OUT=${ELPIS_SNAP_DIR:-$HOME/.cache/elpis-tests/snap}; mkdir -p "$OUT"

# The desktop app and Electron, the renderer with this checkout's path replaced (as build-deb.sh does).
electron=${ELECTRON_DIST:-$APP/node_modules/electron/dist}
[[ -x "$electron/electron" ]] || electron=$(dirname "$(readlink -f "$(dirname "$(readlink -f ~/.local/bin/elpis-app)")/runtime/electron/electron")")
cp -r "$APP/out" "$STAGE/out"
real_app=$(dirname "$(readlink -f "$APP/node_modules")")
(rg -l -F -e "$APP" -e "$real_app" "$STAGE/out" || true) | xargs -r sed -i -e "s|$APP|/snap/elpis-agent/current/desktop/app|g" -e "s|$real_app|/snap/elpis-agent/current/desktop/app|g"
node "$APP/desktop/package.mts" --source "$APP" --destination "$S/desktop" --electron-dist "$electron" --out-directory "$STAGE/out" > "$STAGE/manifest.json"
find "$S/desktop/runtime/electron/locales" -name '*.pak' ! -name 'en-US.pak' -delete

# The engine, laid out as an installed bundle: runtimeTools() finds tools/elpis-claude beside package/.
mkdir -p "$S/engine/package/bin" "$S/engine/package/codex-resources" "$S/engine/tools"
install -m 0755 "$codex" "$S/engine/package/bin/codex"
install -m 0755 "$host" "$S/engine/package/bin/codex-code-mode-host"
install -m 0755 "$bwrap" "$S/engine/package/codex-resources/bwrap"
ln -s package/bin/codex "$S/engine/elpis-next"
rsync -aL --exclude 'claude-agent-sdk-linux-*' --exclude test --exclude spike --exclude '*.orig' --exclude '*.test.*' "$bridge/" "$S/engine/tools/elpis-claude/"

# Launchers. Node is Electron's own (ELECTRON_RUN_AS_NODE), so the host needs no Node.js.
mkdir -p "$S/bin" "$S/meta/gui"
# The same launchers serve the snap ($SNAP) and the AppImage ($APPDIR; scripts/build-appimage.sh).
cat > "$S/bin/node" <<'NODE'
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "${SNAP:-$APPDIR}/desktop/runtime/electron/electron" "$@"
NODE
cat > "$S/bin/elpis-app" <<'APPL'
#!/bin/sh
R=${SNAP:-$APPDIR}
# ELPIS_TUI_BIN: the chat menu's Open in > Elpis TUI runs this package's terminal app.
export ELPIS_ENGINE_BIN="$R/engine/elpis-next" ELPIS_NODE_BIN="$R/bin/node" ELPIS_TUI_BIN="$R/bin/elpis" PATH="$R/bin:$PATH"
# A snap or AppImage cannot ship Chromium's setuid sandbox helper, and Ubuntu 24.04 blocks the user-namespace sandbox for apps
# without an AppArmor profile; only there does the window run without Chromium's sandbox (it would abort otherwise).
[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] && set -- --no-sandbox "$@"
exec "$R/desktop/launch" "$@"
APPL
cat > "$S/bin/elpis" <<'TUI'
#!/usr/bin/env bash
# The terminal app: the provider bridge first (shared with the desktop app), then the TUI on it.
R=${SNAP:-$APPDIR}; REAL=$R/engine/elpis-next; BRIDGE_DIR=$R/engine/tools/elpis-claude; NODE=$R/bin/node
export ELPIS_DESKTOP_APP="${ELPIS_DESKTOP_APP:-$R/bin/elpis-app}"   # /app opens this package's desktop app
for a in "$@"; do case "$a" in -h|--help|-V|--version) exec "$REAL" "$@" ;; esac; done
case "${1:-}" in ""|-*|resume|fork) ;; *) exec "$REAL" "$@" ;; esac
out="$(ELPIS_ENGINE_BIN="$REAL" NODE_USE_ENV_PROXY=1 "$NODE" "$BRIDGE_DIR/shared-runtime.mjs" "$BRIDGE_DIR/acp-bridge.mjs")" || exit $?
engine="$REAL"
case "$out" in *$'\n'"engine "*) engine="${out#*$'\n'engine }"; out="${out%%$'\n'*}" ;; *$'\n'*) echo 'elpis: unexpected bridge reply' >&2; exit 1 ;; esac
case "$out" in unix:///*) ;; *) echo 'elpis: unexpected bridge endpoint' >&2; exit 1 ;; esac
ELPIS_ENGINE_BIN="$engine" exec "$REAL" --elpis-local-bridge --remote "$out" "$@"
TUI
cat > "$S/bin/love-spot" <<'LOVEAPPL'
#!/bin/sh
R=${SNAP:-$APPDIR}
exec "$R/bin/elpis-app" --love-spot-app "$@"
LOVEAPPL
cat > "$S/bin/elpis-workflows" <<'WFAPPL'
#!/bin/sh
R=${SNAP:-$APPDIR}
exec "$R/bin/elpis-app" --workflows-app "$@"
WFAPPL
chmod 0755 "$S/bin/"*
cp "$APP/desktop/elpis-icon.png" "$S/meta/gui/icon.png"
cp "$APP/desktop/love-spot-icon.png" "$S/meta/gui/love-spot.png"
cp "$APP/desktop/love-spot-icon.svg" "$S/meta/gui/love-spot.svg"
cat > "$S/meta/gui/elpis-agent.desktop" <<'ENTRY'
[Desktop Entry]
Type=Application
Name=Elpis
Comment=Coding agents you can see and check
Exec=elpis-agent %U
Icon=${SNAP}/meta/gui/icon.png
Terminal=false
Categories=Development;
StartupWMClass=elpis-desktop
ENTRY
cat > "$S/meta/gui/love-spot.desktop" <<'LOVEENTRY'
[Desktop Entry]
Type=Application
Name=Love Spot
GenericName=Excalidraw
Comment=Shared drawing board with Matilda and multi-provider AI accounts
Exec=elpis-agent.love-spot %U
Icon=${SNAP}/meta/gui/love-spot.svg
Terminal=false
Categories=Graphics;Development;
StartupWMClass=excalidraw
LOVEENTRY
cat > "$S/meta/gui/workflows.desktop" <<'WFENTRY'
[Desktop Entry]
Type=Application
Name=Elpis Workflows
GenericName=Multiagent Control Center
Comment=Design and run multi-agent teams across GPT, Claude and Gemini
Exec=elpis-agent.workflows %U
Icon=${SNAP}/meta/gui/icon.png
Terminal=false
Categories=Development;
StartupWMClass=elpis-workflows
WFENTRY
cat > "$S/meta/snap.yaml" <<YAML
name: elpis-agent
title: Elpis
version: '$VERSION'
summary: Coding agents you can see, check and combine
description: |
  Elpis is an open-source coding agent harness for Linux, built on OpenAI's Codex CLI. A desktop app and a terminal app share one engine.

  **You choose what each agent sees.** The Context Ledger lists every instruction file, chosen file and memory with its token cost, and you include or exclude each one.

  **Each agent owns what it writes.** In Workflows, the Mother agent designs a team on a board and picks each agent's model. Each agent owns its folder in its own Git worktree, a second agent checks its work, and only checked work reaches your project.

  * Teams can mix GPT, Claude and Gemini agents on your own subscriptions.
  * Claude models run through your own Claude Code install.
  * Love Spot: a drawing board where Matilda, the app's companion, answers and draws with you.

  Commands: \`elpis-agent\` opens the desktop app; \`elpis-agent.love-spot\` opens Love Spot; \`elpis-agent.workflows\` opens Workflows; \`elpis-agent.elpis\` opens the terminal app.
links:
  website:
    - https://elpis.masihmoafi.com
  source-code:
    - https://github.com/MasihMoafi/Elpis
  issues:
    - https://github.com/MasihMoafi/Elpis/issues
base: core24
grade: stable
confinement: classic
architectures: [amd64]
license: Apache-2.0
apps:
  elpis-agent:
    command: bin/elpis-app
  love-spot:
    command: bin/love-spot
  workflows:
    command: bin/elpis-workflows
  elpis:
    command: bin/elpis
YAML

# The Store rejects a snap.yaml that does not parse (3 Nov: revision 3, an unquoted URL in a flow list).
python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1]))' "$S/meta/snap.yaml" || { echo "meta/snap.yaml does not parse" >&2; exit 1; }

# Licence notices for everything the snap carries or bundles.
node "$APP/scripts/third-party-notices.mjs" "$S" "$S/THIRD-PARTY-NOTICES.txt"; cp "$R/LICENSE" "$S/LICENSE"

# No personal data: nothing may name the builder's home folder or git email.
email=$(git -C "$R" config user.email || true)
if rg -l -F -e "$HOME/" ${email:+-e "$email"} "$S" || find "$S" -type l -lname "$HOME/*" | rg .; then echo "The snap names the builder's home or email; not built." >&2; exit 1; fi
snap pack --compression=xz "$S" "$OUT" >/dev/null
f="$OUT/elpis-agent_${VERSION}_amd64.snap"
(cd "$OUT" && sha256sum "$(basename "$f")" > "$(basename "$f").sha256")
gio trash "$STAGE"
echo "$f $(du -h "$f" | cut -f1) from ${commit:0:9}"
