#!/usr/bin/env bash
# Installs Elpis with Claude subscription models in /model, for Masih's machine.
# Masih runs this himself: it changes ~/.local. It keeps backups and prints the undo.
#   bash ~/Desktop/p/Elpis-wt-acp/tools/elpis-claude/install-local.sh [path-to-built-elpis]
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
lib="$HOME/.local/lib/elpis-next"
bin="$HOME/.local/bin/elpis"
new="${1:-$HOME/Desktop/p/Elpis/codex-rs/target/release/codex}"

[ -x "$new" ] || { echo "No built Elpis at $new"; exit 1; }
[ -d "$here/node_modules/@agentclientprotocol/claude-agent-acp" ] \
  || (cd "$here" && npm install --omit=optional --no-fund --no-audit)
echo "New build: $("$new" --version)"

stamp=$(date +%Y%m%d-%H%M)
cp -p "$lib/elpis-next" "$lib/elpis-next.pre-claude-$stamp"
install -m 0755 "$new" "$lib/.elpis-next.installing"
mv -f "$lib/.elpis-next.installing" "$lib/elpis-next"

install -m 0755 "$here/elpis-wrapper" "$bin.installing"
mv -f "$bin.installing" "$bin"

echo "Installed. Run: elpis   then /model -> a model marked (Claude subscription)."
echo "Undo:  mv -f $lib/elpis-next.pre-claude-$stamp $lib/elpis-next && ln -sfn $lib/elpis-next $bin"
