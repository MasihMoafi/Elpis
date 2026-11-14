#!/usr/bin/env bash
# build-appimage.sh [VERSION]: Elpis as one AppImage for any x86_64 Linux (Arch and Omarchy included), made from the
# snap that scripts/build-snap.sh built from this commit (same app, engine, bridge and launchers; they read $APPDIR).
# GitHub builds it (.github/workflows/desktop-packages.yml, on Ubuntu 22.04 so it runs on glibc 2.35 and newer); it is
# not built on Masih's laptop (docs/LOCAL_BUILD_RULES.md).
#   Elpis-VERSION-x86_64.AppImage          opens the desktop app
#   Elpis-VERSION-x86_64.AppImage elpis …  runs the terminal app
#   APPIMAGETOOL     appimagetool executable; default ~/.cache/elpis-tests/tools/appimagetool
#   ELPIS_STAGE_DIR  the folder build-snap.sh laid out (ELPIS_STAGE_DIR there too); used instead of a packed snap,
#                    and turned into the AppDir in place
#   ELPIS_APPIMAGE_UPDATE  update information to embed (appimagetool -u); a .zsync file is written beside the AppImage
set -euo pipefail
VERSION=${1:-0.5.3}
tool=${APPIMAGETOOL:-$HOME/.cache/elpis-tests/tools/appimagetool}
[[ -x "$tool" ]] || { echo "missing appimagetool: $tool" >&2; exit 1; }
OUT=${ELPIS_APPIMAGE_DIR:-$HOME/.cache/elpis-tests/appimage}; mkdir -p "$OUT" "$HOME/.cache/elpis-tests"
STAGE=$(mktemp -d "$HOME/.cache/elpis-tests/elpis-appimage.XXXXXX")
if [[ -n "${ELPIS_STAGE_DIR:-}" ]]; then
  [[ -f "$ELPIS_STAGE_DIR/meta/snap.yaml" ]] || { echo "not a staged package: $ELPIS_STAGE_DIR" >&2; exit 1; }
  A=$ELPIS_STAGE_DIR
else
  snap=${ELPIS_SNAP_DIR:-$HOME/.cache/elpis-tests/snap}/elpis-agent_${VERSION}_amd64.snap
  [[ -f "$snap" ]] || { echo "build the snap first: scripts/build-snap.sh $VERSION" >&2; exit 1; }
  A=$STAGE/Elpis.AppDir
  unsquashfs -q -n -d "$A" "$snap"
fi
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
gio trash "$A/meta" 2>/dev/null || rm -rf "$A/meta"
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
if [[ "${GITHUB_ACTIONS:-}" != true ]] && rg -l -F -e "$HOME/" "$A" || find "$A" -type l -lname "$HOME/*" | rg .; then echo "The AppImage names the builder's home; not built." >&2; exit 1; fi
f="$OUT/Elpis-${VERSION}-x86_64.AppImage"
update=(); [[ -z "${ELPIS_APPIMAGE_UPDATE:-}" ]] || update=(-u "$ELPIS_APPIMAGE_UPDATE")
(cd "$OUT" && APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 VERSION=$VERSION "$tool" --no-appstream --comp zstd ${update[@]+"${update[@]}"} "$A" "$f") > "$STAGE/appimagetool.log" 2>&1 \
  || { tail -n 40 "$STAGE/appimagetool.log" >&2; exit 1; }
if [[ -n "${ELPIS_APPIMAGE_UPDATE:-}" ]]; then
  [[ -s "$f.zsync" ]] || { tail -n 40 "$STAGE/appimagetool.log" >&2; echo "appimagetool wrote no $f.zsync" >&2; exit 1; }
fi
for g in "$f" ${ELPIS_APPIMAGE_UPDATE:+"$f.zsync"}; do (cd "$OUT" && sha256sum "$(basename "$g")" > "$(basename "$g").sha256"); done
gio trash "$STAGE" 2>/dev/null || rm -rf "$STAGE"
echo "$f $(du -h "$f" | cut -f1)"
