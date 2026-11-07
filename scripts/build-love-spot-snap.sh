#!/usr/bin/env bash
# build-love-spot-snap.sh [VERSION]: the standalone Love Spot snap (strict confinement): Love Spot with Electron, the
# engine, and its provider bridge (tools/elpis-claude). Packed with `snap pack` from a prepared folder, so no build VM
# is needed. Run `npm run build` in apps/elpis-desktop first.
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
mkdir -p "$STAGE_BASE"; STAGE=$(mktemp -d "$STAGE_BASE/love-spot-snap.XXXXXX"); S=$STAGE/prime
OUT=${ELPIS_SNAP_DIR:-$STAGE_BASE/snap}; mkdir -p "$OUT"

electron=${ELECTRON_DIST:-$APP/node_modules/electron/dist}
[[ -x "$electron/electron" ]] || electron=$(dirname "$(readlink -f "$(dirname "$(readlink -f ~/.local/bin/elpis-app)")/runtime/electron/electron")")
cp -r "$APP/out" "$STAGE/out"
real_app=$(dirname "$(readlink -f "$APP/node_modules")")
(rg -0 -l -F -e "$APP" -e "$real_app" "$STAGE/out" || true) | xargs -0 -r sed -i -e "s|$APP|/snap/love-spot/current/desktop/app|g" -e "s|$real_app|/snap/love-spot/current/desktop/app|g"
node "$APP/desktop/package.mts" --source "$APP" --destination "$S/desktop" --electron-dist "$electron" --out-directory "$STAGE/out" > "$STAGE/manifest.json"
find "$S/desktop/runtime/electron/locales" -name '*.pak' ! -name 'en-US.pak' -delete

# Stage core24-compatible GTK3/NSS/ALSA/X11/Wayland/GBM libraries so strict confinement works out of the box.
if [[ -d /snap/core24/current/usr/lib/x86_64-linux-gnu && -d /snap/gnome-46-2404/current/usr/lib/x86_64-linux-gnu ]]; then
  mkdir -p "$S/usr/lib/x86_64-linux-gnu"
  lib_path="/snap/core24/current/usr/lib/x86_64-linux-gnu:/snap/gnome-46-2404/current/usr/lib/x86_64-linux-gnu:/snap/mesa-2404/current/usr/lib/x86_64-linux-gnu:$electron"
  /snap/core24/current/lib64/ld-linux-x86-64.so.2 --list --library-path "$lib_path" "$electron/electron" \
    | awk '/=> \/snap\/(gnome-46-2404|mesa-2404)\// {print $3}' | sort -u | while read -r lib; do
      cp -L "$lib" "$S/usr/lib/x86_64-linux-gnu/$(basename "$lib")"
    done
fi

mkdir -p "$S/engine/package/bin" "$S/engine/package/codex-resources" "$S/engine/tools"
install -m 0755 "$codex" "$S/engine/package/bin/codex"
install -m 0755 "$host" "$S/engine/package/bin/codex-code-mode-host"
install -m 0755 "$bwrap" "$S/engine/package/codex-resources/bwrap"
ln -s package/bin/codex "$S/engine/elpis-next"
rsync -aL --exclude 'claude-agent-sdk-linux-*' --exclude test --exclude spike --exclude '*.orig' --exclude '*.test.*' "$bridge/" "$S/engine/tools/elpis-claude/"

mkdir -p "$S/bin" "$S/meta/gui"
cat > "$S/bin/node" <<'NODE'
#!/bin/sh
R=${SNAP:-$APPDIR}
if [ -n "${SNAP:-}" ]; then
  export LD_LIBRARY_PATH="$R/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
ELECTRON_RUN_AS_NODE=1 exec "$R/desktop/runtime/electron/electron" "$@"
NODE
cat > "$S/bin/elpis" <<'TUI'
#!/usr/bin/env bash
R=${SNAP:-$APPDIR}; REAL=$R/engine/elpis-next; BRIDGE_DIR=$R/engine/tools/elpis-claude; NODE=$R/bin/node
export ELPIS_DESKTOP_APP="${ELPIS_DESKTOP_APP:-$R/bin/love-spot}"
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
if [ -n "${SNAP:-}" ]; then
  export LD_LIBRARY_PATH="$R/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  # Keep boards, settings and model credentials in the user's home folder under strict confinement.
  if [ -n "${SNAP_REAL_HOME:-}" ] && mkdir -p "$SNAP_REAL_HOME/.elpis" 2>/dev/null; then
    export HOME="$SNAP_REAL_HOME"
  elif [ -n "${SNAP_REAL_HOME:-}" ] && mkdir -p "$SNAP_REAL_HOME/LoveSpot/.elpis" 2>/dev/null; then
    export HOME="$SNAP_REAL_HOME/LoveSpot"
  elif [ -n "${SNAP_USER_COMMON:-}" ]; then
    export HOME="$SNAP_USER_COMMON"
  fi
fi
export ELPIS_ENGINE_BIN="$R/engine/elpis-next" ELPIS_NODE_BIN="$R/bin/node" ELPIS_TUI_BIN="$R/bin/elpis" PATH="$R/bin:$PATH"
cfg_dir="${ELPIS_HOME:-$HOME/.elpis-next}"
if [ ! -e "$cfg_dir/config.toml" ] && mkdir -p "$cfg_dir" 2>/dev/null; then
  (umask 077 && : > "$cfg_dir/config.toml") 2>/dev/null || true
fi
if [ -n "${SNAP:-}" ] || [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
  set -- --no-sandbox "$@"
fi
exec "$R/desktop/launch" --love-spot-app "$@"
LOVEAPPL
chmod 0755 "$S/bin/"*
cp "$APP/desktop/love-spot-icon.png" "$S/meta/gui/icon.png"
cp "$APP/desktop/love-spot-icon.png" "$S/meta/gui/love-spot.png"
cp "$APP/desktop/love-spot-icon.svg" "$S/meta/gui/love-spot.svg"
cat > "$S/meta/gui/love-spot.desktop" <<'LOVEENTRY'
[Desktop Entry]
Type=Application
Name=Love Spot
GenericName=Excalidraw
Comment=Shared drawing board with Matilda and multi-provider AI accounts
Exec=love-spot %U
Icon=${SNAP}/meta/gui/love-spot.png
Terminal=false
Categories=Graphics;Development;
StartupWMClass=excalidraw
LOVEENTRY
cat > "$S/meta/snap.yaml" <<YAML
name: love-spot
title: Love Spot
version: '$VERSION'
summary: Shared Excalidraw drawing board with Matilda and multi-provider AI accounts
description: |
  Love Spot is a local-first Excalidraw drawing board where Matilda and 12 theme characters chat, draw, and brainstorm with you on a shared canvas.

  • Bring your own AI subscriptions and keys: ChatGPT Plus/Pro, Claude Pro/Max, and OpenRouter or custom Responses API keys
  • 13 selectable companion characters (Matilda default + 12 theme characters), each with light and dark palettes
  • Multi-page Excalidraw boards, live canvas sync, and voice mode
  • Local-first privacy: no Love Spot account, no server — boards, settings, and model credentials stay in your home folder

  This snap uses strict confinement and stores boards in your home folder. To access files on another drive, run: sudo snap connect love-spot:removable-media
links:
  website:
    - https://elpis.masihmoafi.com
  source-code:
    - https://github.com/MasihMoafi/Elpis
  issues:
    - https://github.com/MasihMoafi/Elpis/issues
base: core24
grade: stable
confinement: strict
architectures: [amd64]
license: Apache-2.0
apps:
  love-spot:
    command: bin/love-spot
    plugs:
      - home
      - removable-media
      - network
      - network-bind
      - opengl
      - desktop
      - desktop-legacy
      - wayland
      - x11
      - gsettings
      - audio-playback
      - audio-record
YAML

python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1]))' "$S/meta/snap.yaml" || { echo "meta/snap.yaml does not parse" >&2; exit 1; }
node "$APP/scripts/third-party-notices.mjs" "$S" "$S/THIRD-PARTY-NOTICES.txt"; cp "$R/LICENSE" "$S/LICENSE"

email=$(git -C "$R" config user.email || true)
if rg -l -F -e "$HOME/" ${email:+-e "$email"} "$S" || find "$S" -type l -lname "$HOME/*" | rg .; then echo "The snap names the builder's home or email; not built." >&2; exit 1; fi
snap pack --compression=xz "$S" "$OUT" >/dev/null
f="$OUT/love-spot_${VERSION}_amd64.snap"
(cd "$OUT" && sha256sum "$(basename "$f")" > "$(basename "$f").sha256")
gio trash "$STAGE"
echo "$f $(du -h "$f" | cut -f1) from ${commit:0:9}"
