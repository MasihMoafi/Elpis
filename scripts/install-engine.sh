#!/usr/bin/env bash
# Local engine bundles retain bridge dependencies outside the daemon's CLI package.
set -euo pipefail

if [ "$#" -ne 1 ] || ! [[ "$1" =~ ^[[:alnum:]][[:alnum:]_.-]*$ ]]; then
    printf 'usage: %s <bundle-name> (letters, digits, dots, underscores and hyphens)\n' "$0" >&2
    exit 2
fi
R=${ELPIS_SOURCE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}
V=$HOME/.local/lib/elpis-next/versions
BIN=${CARGO_TARGET_DIR:-$R/codex-rs/target}/release/codex
OLD=$(dirname "$(readlink -f "$HOME/.local/bin/elpis-next")")
# current_exe resolves the compatibility alias into package/bin/codex.
while [ ! -f "$OLD/elpis-wrapper" ] && [ "$OLD" != / ]; do OLD=$(dirname "$OLD"); done
[ "$OLD" != / ] || { printf 'cannot locate the previous engine bundle\n' >&2; exit 1; }
HOST=$OLD/codex-code-mode-host
RESOURCES=$OLD/codex-resources
if [ -d "$OLD/package" ]; then
    HOST=$OLD/package/bin/codex-code-mode-host
    RESOURCES=$OLD/package/codex-resources
fi
# A host built with the engine (cargo's target dir, or a CI runtime laid out like one) matches it.
[ -x "$(dirname "$BIN")/codex-code-mode-host" ] && HOST=$(dirname "$BIN")/codex-code-mode-host
RG=$(command -v rg)
for input in "$BIN" "$HOST" "$RESOURCES/bwrap" "$RG"; do
    if [ ! -x "$input" ] || [ ! -f "$input" ]; then
        printf 'missing executable: %s\n' "$input" >&2
        exit 1
    fi
done
[ -d "$R/codex-rs/prompts" ] && [ -d "$OLD/tools/elpis-claude" ]
case "$(uname -sm)" in
    'Linux x86_64') TARGET=x86_64-unknown-linux-gnu ;;
    'Linux aarch64') TARGET=aarch64-unknown-linux-gnu ;;
    *) printf 'unsupported local engine platform\n' >&2; exit 1 ;;
esac
VERSION=$("$BIN" --version)
VERSION=${VERSION##* }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'unexpected engine version: %s\n' "$VERSION" >&2; exit 1; }
SHA=$(sha256sum "$BIN"); SHA=${SHA%% *}
NEW=$V/$1-${SHA:0:8}
if [ -e "$NEW" ] || [ -L "$NEW" ]; then
    printf 'exists: %s\n' "$NEW" >&2
    exit 1
fi
HEADC=$(git -C "$R" rev-parse HEAD)
mkdir -p "$V"
mkdir "$NEW"
activated=false
trap 'if [ "$activated" = false ]; then gio trash "$NEW"; fi' EXIT
mkdir -p "$NEW/package/bin" "$NEW/package/codex-path" "$NEW/package/codex-resources" "$NEW/codex-rs" "$NEW/tools"
install -m 0755 "$BIN" "$NEW/package/bin/codex"
install -m 0755 "$HOST" "$NEW/package/bin/codex-code-mode-host"
install -m 0755 "$RG" "$NEW/package/codex-path/rg"
install -m 0755 "$RESOURCES/bwrap" "$NEW/package/codex-resources/bwrap"
ln -s package/bin/codex "$NEW/elpis-next"
node - "$NEW/package/codex-package.json" "$VERSION+elpis.${SHA:0:8}" "$TARGET" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
    layoutVersion: 1, version: process.argv[3], target: process.argv[4],
    variant: 'elpis', entrypoint: 'bin/codex', resourcesDir: 'codex-resources', pathDir: 'codex-path',
}) + '\n');
NODE
cp -a "$R/codex-rs/prompts" "$NEW/codex-rs/"
cp -a "$OLD/tools/elpis-claude" "$NEW/tools/"
while IFS= read -r -d '' file; do
    case "$file" in *.test.mjs|*-e2e.mjs|*/probe.mjs|*/install-local.sh|*/elpis-wrapper|*/.gitignore) continue ;; esac
    mkdir -p "$(dirname "$NEW/$file")"
    cp -a "$R/$file" "$NEW/$file"
done < <(git -C "$R" ls-files -z tools/elpis-claude)
# The live launcher is the template: the bundle's own copy can be older (21 Oct: it lacked the
# pinned TUI frontend and the shared bridge). Only its engine and bridge paths move to the new bundle.
grep -qF "$OLD/" "$HOME/.local/bin/elpis" || { printf 'the live launcher does not use %s\n' "$OLD" >&2; exit 1; }
# Literal replacement also supports paths containing sed delimiters or ampersands.
node - "$HOME/.local/bin/elpis" "$NEW/elpis-wrapper" "$OLD" "$NEW" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[3], fs.readFileSync(process.argv[2], 'utf8').split(process.argv[4]).join(process.argv[5]), { mode: 0o755 });
NODE
cp "$HOME/.local/bin/elpis" "$NEW/previous-wrapper"
git -C "$R" diff HEAD -- codex-rs tools/elpis-claude > "$NEW/source.patch"
PATCH_SHA=$(sha256sum "$NEW/source.patch"); PATCH_SHA=${PATCH_SHA%% *}
node - "$NEW/source.json" "$HEADC" "$PATCH_SHA" "$SHA" "$OLD" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ source_head: process.argv[3], source_patch_sha256: process.argv[4], runtime_sha256: process.argv[5], previous_bundle: process.argv[6] }) + '\n');
NODE
{
    # The generated rollback expands HOME when it runs.
    # shellcheck disable=SC2016
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    # shellcheck disable=SC2016
    printf 'cp %q "$HOME/.local/bin/elpis.new"\n' "$NEW/previous-wrapper"
    # shellcheck disable=SC2016
    printf 'mv "$HOME/.local/bin/elpis.new" "$HOME/.local/bin/elpis"\n'
    # shellcheck disable=SC2016
    printf 'ln -sfn %q "$HOME/.local/bin/elpis-next"\n' "$OLD/elpis-next"
    # shellcheck disable=SC2016
    printf 'readlink "$HOME/.local/bin/elpis-next"\n'
} > "$NEW/rollback.sh"
chmod 755 "$NEW/rollback.sh"
# Preserve rollback files if either launcher selection fails during activation.
activated=true
cp "$NEW/elpis-wrapper" "$HOME/.local/bin/elpis.new"
mv "$HOME/.local/bin/elpis.new" "$HOME/.local/bin/elpis"
ln -sfn "$NEW/elpis-next" "$HOME/.local/bin/elpis-next"
printf 'installed %s (rollback: bash %s/rollback.sh)\n' "$NEW" "$NEW"
