#!/usr/bin/env bash
# build-snap.sh [VERSION]: the elpis-agent snap (classic confinement): the desktop app with Electron, the engine, its
# provider bridge (tools/elpis-claude) and a terminal launcher. Packed with `snap pack` from a prepared folder, so no
# build VM is needed. Run `npm run build` in apps/elpis-desktop first.
#   ENGINE_DIR  a folder with codex, codex-code-mode-host and bwrap (a CI build); default: the installed engine.
#   ELECTRON_DIST  an Electron folder; default: the checkout's, else the installed app's (no download).
set -euo pipefail
VERSION=${1:-0.5.0}
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
rg -l -F "$APP" "$STAGE/out" | xargs -r sed -i "s|$APP|/snap/elpis-agent/current/desktop/app|g"
node "$APP/desktop/package.mjs" --source "$APP" --destination "$S/desktop" --electron-dist "$electron" --out-directory "$STAGE/out" > "$STAGE/manifest.json"
find "$S/desktop/runtime/electron/locales" -name '*.pak' ! -name 'en-US.pak' -delete

# The engine, laid out as an installed bundle: runtimeTools() finds tools/elpis-claude beside package/.
mkdir -p "$S/engine/package/bin" "$S/engine/package/codex-resources" "$S/engine/tools"
install -m 0755 "$codex" "$S/engine/package/bin/codex"
install -m 0755 "$host" "$S/engine/package/bin/codex-code-mode-host"
install -m 0755 "$bwrap" "$S/engine/package/codex-resources/bwrap"
ln -s package/bin/codex "$S/engine/elpis-next"
rsync -a --exclude test --exclude spike --exclude '*.orig' --exclude '*.test.*' "$bridge/" "$S/engine/tools/elpis-claude/"

# Launchers. Node is Electron's own (ELECTRON_RUN_AS_NODE), so the host needs no Node.js.
mkdir -p "$S/bin" "$S/meta/gui"
cat > "$S/bin/node" <<'NODE'
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "$SNAP/desktop/runtime/electron/electron" "$@"
NODE
cat > "$S/bin/elpis-app" <<'APPL'
#!/bin/sh
export ELPIS_ENGINE_BIN="$SNAP/engine/elpis-next" ELPIS_NODE_BIN="$SNAP/bin/node" PATH="$SNAP/bin:$PATH"
exec "$SNAP/desktop/launch" "$@"
APPL
cat > "$S/bin/elpis" <<'TUI'
#!/usr/bin/env bash
# The terminal app: the provider bridge first (shared with the desktop app), then the TUI on it.
REAL=$SNAP/engine/elpis-next; BRIDGE_DIR=$SNAP/engine/tools/elpis-claude; NODE=$SNAP/bin/node
for a in "$@"; do case "$a" in -h|--help|-V|--version) exec "$REAL" "$@" ;; esac; done
case "${1:-}" in ""|-*|resume|fork) ;; *) exec "$REAL" "$@" ;; esac
out="$(ELPIS_ENGINE_BIN="$REAL" NODE_USE_ENV_PROXY=1 "$NODE" "$BRIDGE_DIR/shared-runtime.mjs" "$BRIDGE_DIR/acp-bridge.mjs")" || exit $?
engine="$REAL"
case "$out" in *$'\n'"engine "*) engine="${out#*$'\n'engine }"; out="${out%%$'\n'*}" ;; *$'\n'*) echo 'elpis: unexpected bridge reply' >&2; exit 1 ;; esac
case "$out" in unix:///*) ;; *) echo 'elpis: unexpected bridge endpoint' >&2; exit 1 ;; esac
ELPIS_ENGINE_BIN="$engine" exec "$REAL" --elpis-local-bridge --remote "$out" "$@"
TUI
chmod 0755 "$S/bin/"*
cp "$APP/desktop/elpis-icon.png" "$S/meta/gui/icon.png"
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
cat > "$S/meta/snap.yaml" <<YAML
name: elpis-agent
version: '$VERSION'
summary: Coding agents you can see, check and combine
description: |
  Elpis is an open-source agent harness built on OpenAI's Codex CLI.
  You choose what each agent sees: the Context Ledger lists every instruction file and memory with its token cost.
  In Workflows, a Mother agent designs a team; each agent owns its folder, a second agent checks its work,
  and only checked work is merged. Teams can mix GPT, Claude and Gemini agents on your own subscriptions.
  Commands: elpis-agent (desktop app), elpis-agent.elpis (terminal app).
base: core24
grade: stable
confinement: classic
architectures: [amd64]
license: Apache-2.0
apps:
  elpis-agent:
    command: bin/elpis-app
    desktop: meta/gui/elpis-agent.desktop
  elpis:
    command: bin/elpis
YAML

# No personal data: nothing may name the builder's home folder or git email.
email=$(git -C "$R" config user.email || true)
if rg -l -F -e "$HOME/" ${email:+-e "$email"} "$S"; then echo "The snap names the builder's home or email; not built." >&2; exit 1; fi
snap pack --compression=xz "$S" "$OUT" >/dev/null
f="$OUT/elpis-agent_${VERSION}_amd64.snap"
(cd "$OUT" && sha256sum "$(basename "$f")" > "$(basename "$f").sha256")
gio trash "$STAGE"
echo "$f $(du -h "$f" | cut -f1) from ${commit:0:9}"
