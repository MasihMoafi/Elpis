#!/usr/bin/env bash
# Local engine bundles retain bridge dependencies outside the daemon's CLI package.
set -euo pipefail

WITH_FRONTEND=false
# --binaries-from <installed version> --reason <text>: the engine binaries (and the prompts built with them) come
# from that installed version, which is only read; the bridge scripts come from this checkout. Nothing is built.
FROM='' REASON=''
while [ "$#" -gt 1 ]; do
    case "$1" in
        --with-frontend) WITH_FRONTEND=true; shift ;;
        --binaries-from) FROM=$2; shift 2 ;;
        --reason) REASON=$2; shift 2 ;;
        *) break ;;
    esac
done
NAME_RE='^[[:alnum:]][[:alnum:]_.-]*$'
if [ "$#" -ne 1 ] || ! [[ "$1" =~ $NAME_RE ]] || { [ -n "$FROM" ] && ! [[ "$FROM" =~ $NAME_RE ]]; }; then
    printf 'usage: %s [--with-frontend | --binaries-from <installed version> --reason <text>] <bundle-name> (letters, digits, dots, underscores and hyphens)\n' "$0" >&2
    exit 2
fi
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
R=${ELPIS_SOURCE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}
V=$HOME/.local/lib/elpis-next/versions
BIN=${CARGO_TARGET_DIR:-$R/codex-rs/target}/release/codex
PROMPTS=$R/codex-rs/prompts
SRC=
if [ -n "$FROM" ]; then
    # A reused binary is not built from this checkout; the reason it is acceptable is recorded with the install.
    [ -n "$REASON" ] || { printf -- '--binaries-from needs --reason <text>: the install records why the engine is not built from this checkout\n' >&2; exit 2; }
    # The frontend check compares the new engine's source with the pinned one; a reused binary has no new source.
    [ "$WITH_FRONTEND" = false ] || { printf -- '--binaries-from cannot be combined with --with-frontend\n' >&2; exit 2; }
    SRC=$V/$FROM
    { [ -d "$SRC" ] && [ ! -L "$SRC" ]; } || { printf 'no installed version named %s in %s\n' "$FROM" "$V" >&2; exit 1; }
    BIN=$SRC/package/bin/codex
    { [ -f "$BIN" ] && [ ! -L "$BIN" ] && [ -x "$BIN" ]; } || { printf 'the installed version %s has no engine binary (%s)\n' "$FROM" "$BIN" >&2; exit 1; }
    PROMPTS=$SRC/codex-rs/prompts
fi
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
if [ -n "$SRC" ]; then
    HOST=$SRC/package/bin/codex-code-mode-host
    RESOURCES=$SRC/package/codex-resources
    RG=$SRC/package/codex-path/rg
fi
for input in "$BIN" "$HOST" "$RESOURCES/bwrap" "$RG"; do
    if [ ! -x "$input" ] || [ ! -f "$input" ]; then
        printf 'missing executable: %s\n' "$input" >&2
        exit 1
    fi
done
[ -d "$PROMPTS" ] && [ -d "$OLD/tools/elpis-claude" ]
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
if [ -n "$SRC" ]; then
    [ "$NEW" != "$SRC" ] || { printf 'refused: %s is the version being written; choose another bundle name\n' "$SRC" >&2; exit 1; }
    # The binaries' origin is what their version's own record states; a record that does not match its binary is refused.
    RECORD=$(node - "$SRC/source.json" "$SHA" <<'NODE'
const fs = require('node:fs');
let r;
try { r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch { r = null; }
if (!/^[a-f0-9]{40}$/i.test(r?.source_head ?? '') || String(r?.runtime_sha256).toLowerCase() !== process.argv[3]) {
    process.stderr.write(`refused: ${process.argv[2]} does not record a source commit and this binary's checksum\n`);
    process.exit(1);
}
process.stdout.write(`${r.source_head} ${/^[a-f0-9]{64}$/i.test(r.source_patch_sha256 ?? '') ? r.source_patch_sha256 : 'unknown'}`);
NODE
    )
    BIN_HEAD=${RECORD%% *} BIN_PATCH=${RECORD##* }
fi
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
cp -a "$PROMPTS" "$NEW/codex-rs/"
cp -a "$OLD/tools/elpis-claude" "$NEW/tools/"
while IFS= read -r -d '' file; do
    case "$file" in *.test.mjs|*.test.mts|*-e2e.mjs|*-e2e.mts|*/probe.mts|*/install-local.sh|*/elpis-wrapper|*/.gitignore) continue ;; esac
    mkdir -p "$(dirname "$NEW/$file")"
    cp -a "$R/$file" "$NEW/$file"
done < <(git -C "$R" ls-files -z tools/elpis-claude)
mkdir -p "$NEW/tools/elpis-claude/matilda"
cp "$R/apps/elpis-desktop/bridge/matilda-goals.mts" "$NEW/tools/elpis-claude/matilda/"
cp "$R/apps/elpis-desktop/bridge/router/executor/discovery.mts" "$NEW/tools/elpis-claude/matilda/matilda-sessions.mts"
# The live launcher is the template: the bundle's own copy can be older (21 Oct: it lacked the
# pinned TUI frontend and the shared bridge). Frontend changes require the explicit flag below.
grep -qF "$OLD/" "$HOME/.local/bin/elpis" || { printf 'the live launcher does not use %s\n' "$OLD" >&2; exit 1; }
# Literal replacement also supports paths containing sed delimiters or ampersands.
node - "$HOME/.local/bin/elpis" "$NEW/elpis-wrapper" "$OLD" "$NEW" "$R/tools/elpis-claude/elpis-wrapper" "$WITH_FRONTEND" "$R" "$HEADC" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const live = fs.readFileSync(process.argv[2], 'utf8');
let frontendLine;
if (process.argv[7] === 'true') {
    const assignments = live.match(/^FRONTEND=.*$/gm) ?? [];
    if (assignments.length !== 1) throw new Error('The installed frontend has no unique literal path');
    const value = assignments[0].slice('FRONTEND='.length);
    const single = value.match(/^'((?:[^']|'\\'')*)'$/);
    const double = value.match(/^"((?:[^"\\$`]|\\["\\$`])*)"$/);
    const plain = value.match(/^[^\s"'$`\\;|&()<>]+$/);
    const frontend = single?.[1].replace(/'\\''/g, "'") ?? (double && double[1].replace(/\\(["\\$`])/g, '$1')) ?? (plain && value);
    if (!frontend || !path.isAbsolute(frontend) || !fs.statSync(frontend).isFile()) throw new Error('The installed frontend path is unknown');
    fs.accessSync(frontend, fs.constants.X_OK);
    let bundle = path.dirname(fs.realpathSync(frontend));
    while (!fs.existsSync(path.join(bundle, 'source.json')) && !fs.existsSync(path.join(bundle, 'verification.json')) && path.dirname(bundle) !== bundle) bundle = path.dirname(bundle);
    const sourceReceipt = path.join(bundle, 'source.json');
    const legacyReceipt = path.join(bundle, 'verification.json');
    const receipt = JSON.parse(fs.readFileSync(fs.existsSync(sourceReceipt) ? sourceReceipt : legacyReceipt, 'utf8'));
    const source = fs.existsSync(sourceReceipt) ? receipt.source_head : receipt.head;
    if (typeof source !== 'string' || !/^[a-f0-9]{7,40}$/i.test(source)) throw new Error('The installed frontend source commit is unknown');
    try {
        const commit = execFileSync('git', ['-C', process.argv[8], 'rev-parse', '--verify', `${source}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        execFileSync('git', ['-C', process.argv[8], 'merge-base', '--is-ancestor', commit, process.argv[9]], { stdio: 'pipe' });
    } catch {
        throw new Error('The installed frontend source must be a known ancestor of the new source');
    }
    frontendLine = `FRONTEND='${`${process.argv[5]}/elpis-next`.replace(/'/g, "'\\''")}'`;
}
const direct = fs.readFileSync(process.argv[6], 'utf8').match(/^direct\(\) \{[\s\S]*?^\}/m)?.[0];
if (!direct) throw new Error('The launcher permission policy is missing');
const previous = live.split('\n').map(line => line.startsWith('FRONTEND=')
    ? frontendLine ?? line : line.split(process.argv[4]).join(process.argv[5])).join('\n');
const updated = previous.replace(/^direct\(\) \{[^\n]*\}$|^direct\(\) \{\n[\s\S]*?^\}/m, direct);
if (updated === previous && !previous.includes(direct)) throw new Error('The installed launcher has no recognized direct entry point');
fs.writeFileSync(process.argv[3], updated, { mode: 0o755 });
fs.writeFileSync(path.join(process.argv[5], 'previous-wrapper'), live, { mode: 0o755 });
NODE
if [ -z "$SRC" ]; then
    git -C "$R" diff HEAD -- codex-rs tools/elpis-claude > "$NEW/source.patch"
    PATCH_SHA=$(sha256sum "$NEW/source.patch"); PATCH_SHA=${PATCH_SHA%% *}
    node - "$NEW/source.json" "$HEADC" "$PATCH_SHA" "$SHA" "$OLD" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ source_head: process.argv[3], source_patch_sha256: process.argv[4], runtime_sha256: process.argv[5], previous_bundle: process.argv[6] }) + '\n');
NODE
else
    # source_head and source_patch_sha256 describe the engine binary (the runtime reads them as the pair's receipt):
    # they are copied from the binaries' own record. The scripts' commit is scripts_head, never source_head.
    git -C "$R" diff HEAD -- tools/elpis-claude apps/elpis-desktop/bridge/matilda-goals.mts apps/elpis-desktop/bridge/router/executor/discovery.mts > "$NEW/scripts.patch"
    SCRIPTS_PATCH=$(sha256sum "$NEW/scripts.patch"); SCRIPTS_PATCH=${SCRIPTS_PATCH%% *}
    if ! git -C "$R" cat-file -e "$BIN_HEAD^{commit}" 2>/dev/null; then CODEX_RS="unknown: the binaries' source commit is not in this checkout"
    elif git -C "$R" diff --quiet "$BIN_HEAD" -- codex-rs; then CODEX_RS="same as the binaries' source"
    else CODEX_RS="differs from the binaries' source: its codex-rs changes are not installed"; fi
    SKIPPED="building the engine from this checkout ($HEADC); the binaries, code-mode host, rg, bwrap and prompts come from $FROM (source $BIN_HEAD); the checkout's codex-rs is $CODEX_RS"
    node - "$NEW/source.json" "$BIN_HEAD" "$BIN_PATCH" "$SHA" "$OLD" "$FROM" "$SRC" "$HEADC" "$SCRIPTS_PATCH" "$CODEX_RS" "$SKIPPED" "$REASON" <<'NODE'
const fs = require('node:fs');
const [file, head, patch, sha, old, from, src, scripts, scriptsPatch, codexRs, skipped, reason] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({
    source_head: head, source_patch_sha256: patch, runtime_sha256: sha, previous_bundle: old,
    binaries_from: { version: from, path: src, source_head: head, source_patch_sha256: patch },
    scripts_head: scripts, scripts_patch_sha256: scriptsPatch, checkout_codex_rs: codexRs, skipped: [skipped], reason,
}) + '\n');
NODE
    printf 'skipped: %s\nreason: %s\n' "$SKIPPED" "$REASON" >&2
fi
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
cmp -s "$HOME/.local/bin/elpis" "$NEW/previous-wrapper" || { printf 'the live launcher changed during installation\n' >&2; exit 1; }
# Preserve rollback files if either launcher selection fails during activation.
activated=true
cp "$NEW/elpis-wrapper" "$HOME/.local/bin/elpis.new"
mv "$HOME/.local/bin/elpis.new" "$HOME/.local/bin/elpis"
ln -sfn "$NEW/elpis-next" "$HOME/.local/bin/elpis-next"
# Old bundles go to the trash: the newest five stay, with this one, its rollback and any the live launcher names.
node "$HERE/prune-versions.mts" "$V" --keep "$NEW" --keep "$OLD" ${SRC:+--keep "$SRC"} --named-in "$HOME/.local/bin/elpis" ||
    printf 'could not move old engine bundles to the trash\n' >&2
printf 'installed %s (rollback: bash %s/rollback.sh)\n' "$NEW" "$NEW"
