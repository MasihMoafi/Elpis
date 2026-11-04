#!/usr/bin/env bash
# build-appimage.sh [VERSION]: Elpis as one AppImage for any x86_64 Linux (Arch and Omarchy included), made from the
# snap that scripts/build-snap.sh built from this commit (same app, engine, bridge and launchers; they read $APPDIR).
#   Elpis-VERSION-x86_64.AppImage          opens the desktop app
#   Elpis-VERSION-x86_64.AppImage elpis …  runs the terminal app
#   APPIMAGETOOL  appimagetool executable; default ~/.cache/elpis-tests/tools/appimagetool
set -euo pipefail
VERSION=${1:-0.5.1}
snap=${ELPIS_SNAP_DIR:-$HOME/.cache/elpis-tests/snap}/elpis-agent_${VERSION}_amd64.snap
tool=${APPIMAGETOOL:-$HOME/.cache/elpis-tests/tools/appimagetool}
[[ -f "$snap" ]] || { echo "build the snap first: scripts/build-snap.sh $VERSION" >&2; exit 1; }
[[ -x "$tool" ]] || { echo "missing appimagetool: $tool" >&2; exit 1; }
OUT=${ELPIS_APPIMAGE_DIR:-$HOME/.cache/elpis-tests/appimage}; mkdir -p "$OUT"
STAGE=$(mktemp -d "$HOME/.cache/elpis-tests/elpis-appimage.XXXXXX"); A=$STAGE/Elpis.AppDir
unsquashfs -q -n -d "$A" "$snap"
cp "$A/meta/gui/icon.png" "$A/elpis.png"; ln -s elpis.png "$A/.DirIcon"
cat > "$A/elpis.desktop" <<'ENTRY'
[Desktop Entry]
Type=Application
Name=Elpis
Comment=Coding agents you can see and check
Exec=elpis %U
Icon=elpis
Terminal=false
Categories=Development;
StartupWMClass=elpis-desktop
ENTRY
gio trash "$A/meta"
cat > "$A/AppRun" <<'RUN'
#!/bin/sh
# The desktop app, or the terminal/Love Spot/Workflows app when the first argument selects it.
export APPDIR="${APPDIR:-$(dirname "$(readlink -f "$0")")}"
if [ "${1:-}" = elpis ]; then shift; exec "$APPDIR/bin/elpis" "$@"; fi
if [ "${1:-}" = love-spot ]; then shift; exec "$APPDIR/bin/love-spot" "$@"; fi
if [ "${1:-}" = workflows ]; then shift; exec "$APPDIR/bin/elpis-workflows" "$@"; fi
exec "$APPDIR/bin/elpis-app" "$@"
RUN
chmod 0755 "$A/AppRun"
# No personal data: nothing may name the builder's home folder.
if rg -l -F -e "$HOME/" "$A" || find "$A" -type l -lname "$HOME/*" | rg .; then echo "The AppImage names the builder's home; not built." >&2; exit 1; fi
f="$OUT/Elpis-${VERSION}-x86_64.AppImage"
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 VERSION=$VERSION "$tool" --no-appstream --comp zstd "$A" "$f" >/dev/null 2>&1
(cd "$OUT" && sha256sum "$(basename "$f")" > "$(basename "$f").sha256")
gio trash "$STAGE"
echo "$f $(du -h "$f" | cut -f1)"
