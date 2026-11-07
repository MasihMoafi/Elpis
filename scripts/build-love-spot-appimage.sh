#!/usr/bin/env bash
# build-love-spot-appimage.sh [VERSION]: standalone Love Spot as one AppImage for any x86_64 Linux, made from the
# snap that scripts/build-love-spot-snap.sh built from this commit.
set -euo pipefail
VERSION=${1:-0.5.1}
STAGE_BASE=${ELPIS_STAGE_DIR:-$HOME/.cache/elpis-tests}
snap=${ELPIS_SNAP_DIR:-$STAGE_BASE/snap}/love-spot_${VERSION}_amd64.snap
tool=${APPIMAGETOOL:-$HOME/.cache/elpis-tests/tools/appimagetool}
[[ -f "$snap" ]] || { echo "build the snap first: scripts/build-love-spot-snap.sh $VERSION" >&2; exit 1; }
[[ -x "$tool" ]] || { echo "missing appimagetool: $tool" >&2; exit 1; }
OUT=${ELPIS_APPIMAGE_DIR:-$STAGE_BASE/appimage}; mkdir -p "$OUT"
STAGE=$(mktemp -d "$STAGE_BASE/love-spot-appimage.XXXXXX"); A=$STAGE/LoveSpot.AppDir
unsquashfs -q -n -d "$A" "$snap"
cp "$A/meta/gui/love-spot.png" "$A/love-spot.png"; ln -s love-spot.png "$A/.DirIcon"
cat > "$A/love-spot.desktop" <<'ENTRY'
[Desktop Entry]
Type=Application
Name=Love Spot
GenericName=Excalidraw
Comment=Shared drawing board with Matilda and multi-provider AI accounts
Exec=love-spot %U
Icon=love-spot
Terminal=false
Categories=Graphics;Development;
StartupWMClass=excalidraw
ENTRY
gio trash "$A/meta"
if [[ -d "$A/usr/lib/x86_64-linux-gnu" ]]; then gio trash "$A/usr"; fi
cat > "$A/AppRun" <<'RUN'
#!/bin/sh
export APPDIR="${APPDIR:-$(dirname "$(readlink -f "$0")")}"
if [ "${1:-}" = elpis ]; then shift; exec "$APPDIR/bin/elpis" "$@"; fi
exec "$APPDIR/bin/love-spot" "$@"
RUN
chmod 0755 "$A/AppRun"
if rg -l -F -e "$HOME/" "$A" || find "$A" -type l -lname "$HOME/*" | rg .; then echo "The AppImage names the builder's home; not built." >&2; exit 1; fi
f="$OUT/Love-Spot-${VERSION}-x86_64.AppImage"
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 VERSION=$VERSION "$tool" --no-appstream --comp zstd "$A" "$f" >/dev/null 2>&1
(cd "$OUT" && sha256sum "$(basename "$f")" > "$(basename "$f").sha256")
gio trash "$STAGE"
echo "$f $(du -h "$f" | cut -f1)"
