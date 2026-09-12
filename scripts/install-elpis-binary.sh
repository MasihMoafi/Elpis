#!/usr/bin/env bash
set -euo pipefail

source_binary=${1:?"usage: scripts/install-elpis-binary.sh PATH_TO_ELPIS_BINARY [PATH_TO_BWRAP]"}
install_dir=${ELPIS_INSTALL_DIR:-"$HOME/.local/bin"}
destination="$install_dir/elpis"
temporary="$install_dir/.elpis.installing"

test -f "$source_binary"
if [ "$(uname -s)" = Linux ]; then
    sandbox=${2:-"$(dirname "$source_binary")/bwrap"}
    test -x "$sandbox" || {
        printf 'Missing bundled sandbox: pass its path as the second argument.\n' >&2
        exit 1
    }
fi
mkdir -p "$install_dir"
if [ "$(uname -s)" = Linux ]; then
    mkdir -p "$install_dir/codex-resources"
    install -m 0755 "$sandbox" "$install_dir/codex-resources/.bwrap.installing"
    mv -f "$install_dir/codex-resources/.bwrap.installing" "$install_dir/codex-resources/bwrap"
fi
install -m 0755 "$source_binary" "$temporary"
mv -f "$temporary" "$destination"

printf 'Installed Elpis at %s\n' "$destination"
