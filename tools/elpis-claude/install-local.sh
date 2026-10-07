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
# The first install keeps the pre-Claude binary; later installs keep the replaced build
# separately, so the undo always returns to Elpis as it was before Claude.
orig=$(ls -1 "$lib"/elpis-next.pre-claude-* 2>/dev/null | head -1)
if [ -z "$orig" ]; then
  orig="$lib/elpis-next.pre-claude-$stamp"
  cp -p "$lib/elpis-next" "$orig"
else
  cp -p "$lib/elpis-next" "$lib/elpis-next.replaced-$stamp"
fi
install -m 0755 "$new" "$lib/.elpis-next.installing"
mv -f "$lib/.elpis-next.installing" "$lib/elpis-next"

install -m 0755 "$here/elpis-wrapper" "$bin.installing"
mv -f "$bin.installing" "$bin"

echo "Installed. Run: elpis   then /model -> Claude subscription or Antigravity."
echo "Undo:  mv -f $orig $lib/elpis-next && ln -sfn $lib/elpis-next $bin"
