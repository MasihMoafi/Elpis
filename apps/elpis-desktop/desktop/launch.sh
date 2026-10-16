#!/usr/bin/env bash
# Opens the Elpis desktop window and starts or reuses the installed Elpis runtime.
#   desktop/launch.sh                  open the window (builds the renderer once if missing)
#   desktop/launch.sh --desktop-entry  print a .desktop launcher for this checkout; installs nothing
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == "--desktop-entry" ]]; then
  sed "s|@APP_DIR@|${APP_DIR}|g" "$APP_DIR/desktop/elpis-desktop.desktop.in"
  exit 0
fi
cd "$APP_DIR"
# GNOME application launchers do not load the interactive shell's Node installation.
elpis_node="${ELPIS_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$elpis_node" && -x /usr/local/node/bin/node ]]; then
  elpis_node=/usr/local/node/bin/node
fi
if [[ -n "$elpis_node" ]]; then
  export ELPIS_NODE_BIN="$elpis_node"
  export PATH="$(dirname "$elpis_node"):$PATH"
fi
[[ -f out/index.html ]] || npm run build
# Apps started from the dock may lack the proxy; when one is set, background Node follows it,
# and loopback (the bridge itself) is never proxied.
if [[ -n "${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}" ]]; then
  export NODE_USE_ENV_PROXY=1
  bypass="${NO_PROXY:-${no_proxy:-}}"
  export NO_PROXY="${bypass:+${bypass},}localhost,127.0.0.1,::1"
  export no_proxy="$NO_PROXY"
fi
# Started as the app directory so Electron takes its name ("Elpis", WM_CLASS) from package.json.
elpis_electron="$(< "$APP_DIR/node_modules/electron/path.txt")"
exec "$APP_DIR/node_modules/electron/dist/$elpis_electron" "$APP_DIR" "$@"
