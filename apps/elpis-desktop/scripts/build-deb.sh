#!/usr/bin/env bash
# build-deb.sh [VERSION]: a small Debian package of the desktop app, built from this commit's out/ (npm run build first).
# The app and a copy of Electron go to /opt/elpis-desktop; only the English locale is kept and the package is xz -9.
# The engine is the `elpis` package. Without Node.js 22 or newer, Electron itself runs the bridge (ELECTRON_RUN_AS_NODE).
set -euo pipefail
VERSION=${1:-0.5.0}
APP="$(cd "$(dirname "$0")/.." && pwd)"
commit=$(git -C "$APP" rev-parse HEAD)
[[ "$(cat "$APP/out/.commit" 2>/dev/null)" == "$commit" ]] || { echo "out/ is not built from $commit: run npm run build" >&2; exit 1; }
mkdir -p "$HOME/.cache/elpis-tests"; STAGE=$(mktemp -d "$HOME/.cache/elpis-tests/elpis-deb.XXXXXX"); ROOT="$STAGE/root"; OPT="$ROOT/opt/elpis-desktop"
OUT="${ELPIS_DEB_DIR:-$HOME/.cache/elpis-tests/deb}"; mkdir -p "$OUT"

node "$APP/desktop/package.mjs" --source "$APP" --destination "$OPT" > "$STAGE/manifest.json"
find "$OPT/runtime/electron/locales" -name '*.pak' ! -name 'en-US.pak' -delete

mkdir -p "$OPT/bin" "$ROOT/usr/bin" "$ROOT/usr/share/applications" "$ROOT/usr/share/icons/hicolor/256x256/apps" "$ROOT/DEBIAN"
cat > "$OPT/bin/node" <<'NODE'
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec /opt/elpis-desktop/runtime/electron/electron "$@"
NODE
cat > "$ROOT/usr/bin/elpis-app" <<'LAUNCH'
#!/usr/bin/env bash
# The system's Node.js when it is 22 or newer, else Electron's own.
if [[ -z "${ELPIS_NODE_BIN:-}" ]]; then
  node=$(command -v node || true)
  if [[ -z "$node" ]] || (( $("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0) < 22 )); then
    export ELPIS_NODE_BIN=/opt/elpis-desktop/bin/node
  fi
fi
exec /opt/elpis-desktop/launch "$@"
LAUNCH
chmod 0755 "$OPT/bin/node" "$ROOT/usr/bin/elpis-app"
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

deb="$OUT/elpis-desktop_${VERSION}_amd64.deb"
dpkg-deb --root-owner-group -Zxz -z9 --build "$ROOT" "$deb" >/dev/null
(cd "$OUT" && sha256sum "$(basename "$deb")" > "$(basename "$deb").sha256")
gio trash "$STAGE"
echo "$deb $(du -h "$deb" | cut -f1) (installed $(( $(sed -n 's/^Installed-Size: //p' <(dpkg-deb -f "$deb")) / 1024 )) MB) from ${commit:0:9}"
