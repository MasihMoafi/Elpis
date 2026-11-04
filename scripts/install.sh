#!/usr/bin/env bash
# install.sh: one command installs both Elpis apps, the desktop app and the terminal app, from the latest release.
#   curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/main/scripts/install.sh | bash
# Ubuntu and Debian get the two .deb packages through apt (asks for your password). Every other Linux gets the AppImage
# in ~/.local/lib/elpis, with `elpis-app` and `elpis` in ~/.local/bin and a menu entry. Every file's SHA-256 is checked.
#   ELPIS_RELEASE_VERSION=v0.5.1  a fixed release instead of the latest
#   ELPIS_USE_APPIMAGE=1          the AppImage even where apt exists
set -euo pipefail
[[ "$(uname -s)-$(uname -m)" == Linux-x86_64 ]] || { echo "Elpis publishes Linux x86_64 only (this is $(uname -s)-$(uname -m))." >&2; exit 1; }
repository=${ELPIS_GITHUB_REPOSITORY:-MasihMoafi/Elpis}
tag=${ELPIS_RELEASE_VERSION:-$(curl -fsSI "https://github.com/$repository/releases/latest" | tr -d '\r' | sed -n 's#^[Ll]ocation: .*/tag/##p')}
[[ $tag == v* ]] || { echo "Could not find the latest Elpis release." >&2; exit 1; }
version=${tag#v}; release="https://github.com/$repository/releases/download/$tag"
work=$(mktemp -d "${TMPDIR:-/tmp}/elpis-install.XXXXXX"); trap 'rm -rf "$work"' EXIT
fetch() { # fetch FILE: the file and its checksum, checked
  curl -fL --progress-bar "$release/$1" -o "$work/$1"
  curl -fsSL "$release/$1.sha256" -o "$work/$1.sha256"
  (cd "$work" && sha256sum -c --quiet "$1.sha256")
}
sudo_() { if [[ $(id -u) == 0 ]]; then "$@"; else sudo "$@"; fi; }

if command -v apt-get >/dev/null && [[ -z ${ELPIS_USE_APPIMAGE:-} ]]; then
  echo "Installing Elpis $version (terminal app and desktop app) with apt…"
  fetch "elpis_${version}_amd64.deb"; fetch "elpis-desktop_${version}_amd64.deb"
  sudo_ env DEBIAN_FRONTEND=noninteractive apt-get install -y "$work/elpis_${version}_amd64.deb" "$work/elpis-desktop_${version}_amd64.deb"
  echo "Done. Desktop app: elpis-app (or Elpis in your app menu). Terminal app: elpis"
  exit 0
fi

echo "Installing Elpis $version (terminal app and desktop app) as an AppImage…"
image="Elpis-${version}-x86_64.AppImage"; fetch "$image"
lib=${ELPIS_LIB_DIR:-$HOME/.local/lib/elpis}; bin=${ELPIS_INSTALL_DIR:-$HOME/.local/bin}; apps=${XDG_DATA_HOME:-$HOME/.local/share}
mkdir -p "$lib" "$bin" "$apps/applications" "$apps/icons/hicolor/256x256/apps"
install -m 0755 "$work/$image" "$lib/$image"; ln -sfn "$image" "$lib/Elpis.AppImage"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$lib/Elpis.AppImage" > "$bin/elpis-app"
printf '#!/bin/sh\nexec "%s" elpis "$@"\n' "$lib/Elpis.AppImage" > "$bin/elpis"
chmod 0755 "$bin/elpis-app" "$bin/elpis"
(cd "$work" && APPIMAGE_EXTRACT_AND_RUN=1 "./$image" --appimage-extract elpis.png >/dev/null 2>&1 && cp squashfs-root/elpis.png "$apps/icons/hicolor/256x256/apps/elpis.png") || true
cat > "$apps/applications/elpis.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=Elpis
Comment=Coding agents you can see and check
Exec=$bin/elpis-app %U
Icon=elpis
Terminal=false
Categories=Development;
StartupWMClass=elpis-desktop
ENTRY
case ":$PATH:" in *":$bin:"*) ;; *) echo "Add $bin to your PATH to run elpis and elpis-app from a terminal." ;; esac
echo "Done. Desktop app: elpis-app (or Elpis in your app menu). Terminal app: elpis"
