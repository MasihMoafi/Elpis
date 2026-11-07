#!/usr/bin/env bash
# build-love-spot-deb.sh [VERSION]: standalone Debian package of Love Spot (/opt/love-spot), carrying the desktop app,
# Electron, the Elpis engine, and the Claude provider bridge so `sudo apt install ./love-spot_VERSION_amd64.deb` works
# in one command with no extra repository or engine package required.
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

STAGE_BASE=${ELPIS_STAGE_DIR:-$HOME/.cache/elpis-tests}
mkdir -p "$STAGE_BASE"; STAGE=$(mktemp -d "$STAGE_BASE/love-spot-deb.XXXXXX"); ROOT="$STAGE/root"; OPT="$ROOT/opt/love-spot"
OUT="${ELPIS_DEB_DIR:-$STAGE_BASE/deb}"; mkdir -p "$OUT"

electron=${ELECTRON_DIST:-$APP/node_modules/electron/dist}
[[ -x "$electron/electron" ]] || electron=$(dirname "$(readlink -f "$(dirname "$(readlink -f ~/.local/bin/elpis-app)")/runtime/electron/electron")")
cp -r "$APP/out" "$STAGE/out"
real_app=$(dirname "$(readlink -f "$APP/node_modules")")
(rg -0 -l -F -e "$APP" -e "$real_app" "$STAGE/out" || true) | xargs -0 -r sed -i -e "s|$APP|/opt/love-spot/app|g" -e "s|$real_app|/opt/love-spot/app|g"
node "$APP/desktop/package.mts" --source "$APP" --destination "$OPT" --electron-dist "$electron" --out-directory "$STAGE/out" > "$STAGE/manifest.json"
find "$OPT/runtime/electron/locales" -name '*.pak' ! -name 'en-US.pak' -delete
chmod 4755 "$OPT/runtime/electron/chrome-sandbox"

mkdir -p "$OPT/engine/package/bin" "$OPT/engine/package/codex-resources" "$OPT/engine/tools"
install -m 0755 "$codex" "$OPT/engine/package/bin/codex"
install -m 0755 "$host" "$OPT/engine/package/bin/codex-code-mode-host"
install -m 0755 "$bwrap" "$OPT/engine/package/codex-resources/bwrap"
ln -s package/bin/codex "$OPT/engine/elpis-next"
rsync -aL --exclude 'claude-agent-sdk-linux-*' --exclude test --exclude spike --exclude '*.orig' --exclude '*.test.*' "$bridge/" "$OPT/engine/tools/elpis-claude/"

mkdir -p "$OPT/bin" "$ROOT/usr/bin" "$ROOT/usr/share/applications" "$ROOT/usr/share/icons/hicolor/256x256/apps" "$ROOT/usr/share/icons/hicolor/scalable/apps" "$ROOT/DEBIAN"
cat > "$OPT/bin/node" <<'NODE'
#!/bin/sh
R=$(cd "$(dirname "$0")/.." && pwd)
ELECTRON_RUN_AS_NODE=1 exec "$R/runtime/electron/electron" "$@"
NODE
cat > "$OPT/bin/elpis" <<'TUI'
#!/usr/bin/env bash
R=$(cd "$(dirname "$0")/.." && pwd)
REAL=$R/engine/elpis-next; BRIDGE_DIR=$R/engine/tools/elpis-claude
NODE=$(command -v node || true)
if [[ -z "$NODE" ]] || (( $("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0) < 22 )); then NODE=$R/bin/node; fi
export ELPIS_DESKTOP_APP="${ELPIS_DESKTOP_APP:-/usr/bin/love-spot}"
for a in "$@"; do case "$a" in -h|--help|-V|--version) exec "$REAL" "$@" ;; esac; done
case "${1:-}" in ""|-*|resume|fork) ;; *) exec "$REAL" "$@" ;; esac
out="$(ELPIS_ENGINE_BIN="$REAL" NODE_USE_ENV_PROXY=1 "$NODE" "$BRIDGE_DIR/shared-runtime.mjs" "$BRIDGE_DIR/acp-bridge.mjs")" || exit $?
engine="$REAL"
case "$out" in *$'\n'"engine "*) engine="${out#*$'\n'engine }"; out="${out%%$'\n'*}" ;; *$'\n'*) echo 'elpis: unexpected bridge reply' >&2; exit 1 ;; esac
case "$out" in unix:///*) ;; *) echo 'elpis: unexpected bridge endpoint' >&2; exit 1 ;; esac
ELPIS_ENGINE_BIN="$engine" exec "$REAL" --elpis-local-bridge --remote "$out" "$@"
TUI
cat > "$ROOT/usr/bin/love-spot" <<'LOVELAUNCH'
#!/usr/bin/env bash
R=${LOVE_SPOT_ROOT:-/opt/love-spot}
# The window names this package's launcher, so the dock shows Love Spot's icon (desktop/main-profile.cts).
export LOVE_SPOT_DESKTOP=love-spot.desktop
export ELPIS_ENGINE_BIN=${ELPIS_ENGINE_BIN:-$R/engine/elpis-next} ELPIS_TUI_BIN=${ELPIS_TUI_BIN:-$R/bin/elpis}
if [[ -z "${ELPIS_NODE_BIN:-}" ]]; then
  node=$(command -v node || true)
  if [[ -z "$node" ]] || (( $("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0) < 22 )); then
    export ELPIS_NODE_BIN=$R/bin/node
  fi
fi
exec "$R/launch" --love-spot-app "$@"
LOVELAUNCH
chmod 0755 "$OPT/bin/node" "$OPT/bin/elpis" "$ROOT/usr/bin/love-spot"
cp "$APP/desktop/love-spot-icon.png" "$ROOT/usr/share/icons/hicolor/256x256/apps/love-spot.png"
cp "$APP/desktop/love-spot-icon.svg" "$ROOT/usr/share/icons/hicolor/scalable/apps/love-spot.svg"
cat > "$ROOT/usr/share/applications/love-spot.desktop" <<'LOVEENTRY'
[Desktop Entry]
Actions=new-page;
Type=Application
Name=Love Spot
GenericName=Excalidraw
Comment=Shared drawing board with Matilda and multi-provider AI accounts
Exec=love-spot %U
Icon=love-spot
Terminal=false
Categories=Graphics;Development;
StartupNotify=true
StartupWMClass=love-spot

[Desktop Action new-page]
Name=New page
Exec=love-spot
LOVEENTRY
mkdir -p "$ROOT/usr/share/doc/love-spot"
node "$APP/scripts/third-party-notices.mjs" "$OPT" "$ROOT/usr/share/doc/love-spot/THIRD-PARTY-NOTICES.txt"
cp "$R/LICENSE" "$ROOT/usr/share/doc/love-spot/LICENSE"
cat > "$ROOT/DEBIAN/control" <<CONTROL
Package: love-spot
Version: $VERSION
Architecture: amd64
Maintainer: Elpis <MasihMoafi@users.noreply.github.com>
Depends: libc6 (>= 2.39), libssl3t64 | libssl3, libgcc-s1, libstdc++6, libgtk-3-0t64 | libgtk-3-0, libnss3, libgbm1, libasound2t64 | libasound2, libxss1, libxtst6, libsecret-1-0, xdg-utils
Conflicts: elpis-desktop
Replaces: elpis-desktop
Installed-Size: $(du -sk "$ROOT" | cut -f1)
Homepage: https://github.com/MasihMoafi/Elpis
Description: Love Spot drawing board with Matilda, 12 theme characters, and multi-provider AI logins
CONTROL

email=$(git -C "$R" config user.email || true)
if rg -l -F -e "$HOME/" ${email:+-e "$email"} "$ROOT" || find "$ROOT" -type l -lname "$HOME/*" | rg .; then echo "The package names the builder's home or email; not built." >&2; gio trash "$STAGE"; exit 1; fi
deb="$OUT/love-spot_${VERSION}_amd64.deb"
dpkg-deb --root-owner-group -Zxz -z9 --build "$ROOT" "$deb" >/dev/null
(cd "$OUT" && sha256sum "$(basename "$deb")" > "$(basename "$deb").sha256")
gio trash "$STAGE"
echo "$deb $(du -h "$deb" | cut -f1) (installed $(( $(sed -n 's/^Installed-Size: //p' <(dpkg-deb -f "$deb")) / 1024 )) MB) from ${commit:0:9}"
