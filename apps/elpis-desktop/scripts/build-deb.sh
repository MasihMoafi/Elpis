#!/usr/bin/env bash
# build-deb.sh [VERSION]: a small Debian package of the desktop app, built from this commit's out/ (npm run build first).
# The app and a copy of Electron go to /opt/elpis-desktop; only the English locale is kept and the package is xz -9.
# The engine is the `elpis` package; this package carries its Claude bridge (tools/elpis-claude), found beside the
# engine launcher /opt/elpis-desktop/engine/elpis-next. Without Node.js 22 or newer, Electron itself runs the bridges.
set -euo pipefail
VERSION=${1:-0.5.1}
APP="$(cd "$(dirname "$0")/.." && pwd)"
commit=$(git -C "$APP" rev-parse HEAD)
# out/ must be built from this commit, or from one whose app differs only in scripts/ (such as this script).
built=$(cat "$APP/out/.commit" 2>/dev/null || true)
[[ "$built" == "$commit" ]] || { [[ -n "$built" ]] && git -C "$APP" diff --quiet "$built" "$commit" -- . ':!scripts'; } \
  || { echo "out/ is not built from $commit: run npm run build" >&2; exit 1; }
mkdir -p "$HOME/.cache/elpis-tests"; STAGE=$(mktemp -d "$HOME/.cache/elpis-tests/elpis-deb.XXXXXX"); ROOT="$STAGE/root"; OPT="$ROOT/opt/elpis-desktop"
OUT="${ELPIS_DEB_DIR:-$HOME/.cache/elpis-tests/deb}"; mkdir -p "$OUT"

# Electron: this checkout's download, else the one the installed app already uses (no download).
electron=${ELECTRON_DIST:-$APP/node_modules/electron/dist}
[[ -x "$electron/electron" ]] || electron=$(dirname "$(readlink -f "$(dirname "$(readlink -f ~/.local/bin/elpis-app)")/runtime/electron/electron")")
# The renderer keeps this checkout's absolute path (and so the builder's home) in a few bundled URLs; the package
# carries a copy with that path replaced by where the app is installed.
cp -r "$APP/out" "$STAGE/out"
rg -l -F "$APP" "$STAGE/out" | xargs -r sed -i "s|$APP|/opt/elpis-desktop/app|g"
node "$APP/desktop/package.mjs" --source "$APP" --destination "$OPT" --electron-dist "$electron" --out-directory "$STAGE/out" > "$STAGE/manifest.json"
find "$OPT/runtime/electron/locales" -name '*.pak' ! -name 'en-US.pak' -delete
# Chromium's setuid sandbox helper: Ubuntu 24.04 blocks the user-namespace sandbox for apps without an AppArmor profile,
# and Electron then aborts unless this helper is root-owned and 4755 (as the VS Code and Slack packages ship it).
chmod 4755 "$OPT/runtime/electron/chrome-sandbox"
bridge="$APP/../../tools/elpis-claude"
[[ -d "$bridge/node_modules/@agentclientprotocol/claude-agent-acp" ]] || { echo "run npm ci --omit=dev in tools/elpis-claude" >&2; exit 1; }
# A script, not a link: the app resolves links, and the bridge must sit beside the path it finds.
mkdir -p "$OPT/engine/tools"; printf '#!/bin/sh\nexec /usr/bin/elpis "$@"\n' > "$OPT/engine/elpis-next"; chmod 0755 "$OPT/engine/elpis-next"
rsync -aL --exclude 'claude-agent-sdk-linux-*' --exclude test --exclude spike --exclude '*.orig' --exclude '*.test.*' "$bridge/" "$OPT/engine/tools/elpis-claude/"

mkdir -p "$OPT/bin" "$ROOT/usr/bin" "$ROOT/usr/share/applications" "$ROOT/usr/share/icons/hicolor/256x256/apps" "$ROOT/DEBIAN"
cat > "$OPT/bin/node" <<'NODE'
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec /opt/elpis-desktop/runtime/electron/electron "$@"
NODE
cat > "$OPT/bin/elpis" <<'TUI'
#!/usr/bin/env bash
# The terminal app on the desktop app's provider bridge (shared with the window), so Claude models work in both.
REAL=/opt/elpis-desktop/engine/elpis-next; BRIDGE_DIR=/opt/elpis-desktop/engine/tools/elpis-claude
NODE=$(command -v node || true)
if [[ -z "$NODE" ]] || (( $("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0) < 22 )); then NODE=/opt/elpis-desktop/bin/node; fi
export ELPIS_DESKTOP_APP="${ELPIS_DESKTOP_APP:-/usr/bin/elpis-app}"
for a in "$@"; do case "$a" in -h|--help|-V|--version) exec "$REAL" "$@" ;; esac; done
case "${1:-}" in ""|-*|resume|fork) ;; *) exec "$REAL" "$@" ;; esac
out="$(ELPIS_ENGINE_BIN="$REAL" NODE_USE_ENV_PROXY=1 "$NODE" "$BRIDGE_DIR/shared-runtime.mjs" "$BRIDGE_DIR/acp-bridge.mjs")" || exit $?
engine="$REAL"
case "$out" in *$'\n'"engine "*) engine="${out#*$'\n'engine }"; out="${out%%$'\n'*}" ;; *$'\n'*) echo 'elpis: unexpected bridge reply' >&2; exit 1 ;; esac
case "$out" in unix:///*) ;; *) echo 'elpis: unexpected bridge endpoint' >&2; exit 1 ;; esac
ELPIS_ENGINE_BIN="$engine" exec "$REAL" --elpis-local-bridge --remote "$out" "$@"
TUI
cat > "$ROOT/usr/bin/elpis-app" <<'LAUNCH'
#!/usr/bin/env bash
# The engine from the elpis package, with the Claude bridge beside its launcher; Node.js 22 or newer, else Electron's own.
export ELPIS_ENGINE_BIN=${ELPIS_ENGINE_BIN:-/opt/elpis-desktop/engine/elpis-next} ELPIS_TUI_BIN=${ELPIS_TUI_BIN:-/opt/elpis-desktop/bin/elpis}
if [[ -z "${ELPIS_NODE_BIN:-}" ]]; then
  node=$(command -v node || true)
  if [[ -z "$node" ]] || (( $("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0) < 22 )); then
    export ELPIS_NODE_BIN=/opt/elpis-desktop/bin/node
  fi
fi
exec /opt/elpis-desktop/launch "$@"
LAUNCH
chmod 0755 "$OPT/bin/node" "$OPT/bin/elpis" "$ROOT/usr/bin/elpis-app"
cp "$APP/desktop/elpis-icon.png" "$ROOT/usr/share/icons/hicolor/256x256/apps/elpis-desktop.png"
cat > "$ROOT/usr/share/applications/elpis-desktop.desktop" <<'ENTRY'
[Desktop Entry]
Type=Application
Name=Elpis
Comment=Elpis conversations and agents
Exec=elpis-app %U
Icon=elpis-desktop
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=elpis-desktop
ENTRY
# Licence notices for everything this package carries or bundles (the Electron runtime keeps its own LICENSE files).
mkdir -p "$ROOT/usr/share/doc/elpis-desktop"
node "$APP/scripts/third-party-notices.mjs" "$OPT" "$ROOT/usr/share/doc/elpis-desktop/THIRD-PARTY-NOTICES.txt"
cp "$APP/../../LICENSE" "$ROOT/usr/share/doc/elpis-desktop/LICENSE"
cat > "$ROOT/DEBIAN/control" <<CONTROL
Package: elpis-desktop
Version: $VERSION
Architecture: amd64
Maintainer: Elpis <MasihMoafi@users.noreply.github.com>
Depends: elpis (>= $VERSION), libgtk-3-0t64 | libgtk-3-0, libnss3, libgbm1, libasound2t64 | libasound2, libxss1, libxtst6, libsecret-1-0, xdg-utils
Installed-Size: $(du -sk "$ROOT" | cut -f1)
Homepage: https://github.com/MasihMoafi/Elpis
Description: Elpis desktop app: chats, Workflows and Love Spot on the Elpis engine
CONTROL

# No personal data: nothing in the package may name the builder's home folder or git email. (The bare user name can
# be an ordinary word in a bundled translation, so it is not searched.)
email=$(git -C "$APP" config user.email || true)
if rg -l -F -e "$HOME/" ${email:+-e "$email"} "$ROOT" || find "$ROOT" -type l -lname "$HOME/*" | rg .; then echo "The package names the builder's home or email; not built." >&2; gio trash "$STAGE"; exit 1; fi
deb="$OUT/elpis-desktop_${VERSION}_amd64.deb"
dpkg-deb --root-owner-group -Zxz -z9 --build "$ROOT" "$deb" >/dev/null
(cd "$OUT" && sha256sum "$(basename "$deb")" > "$(basename "$deb").sha256")
gio trash "$STAGE"
echo "$deb $(du -h "$deb" | cut -f1) (installed $(( $(sed -n 's/^Installed-Size: //p' <(dpkg-deb -f "$deb")) / 1024 )) MB) from ${commit:0:9}"
