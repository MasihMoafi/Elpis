#!/bin/bash
# managed-worker.sh <workdir>: runs managed-worker.mjs inside bubblewrap. The agent's tools see the system read-only,
# <workdir> and its git metadata read-write, the desktop app's node_modules, Playwright and Chrome read-only, and a
# private empty home; nothing else of Masih's home. The environment is cleared except for the environment key.
# The key file (~/.config/elpis/anthropic-environment.env, mode 600) holds ANTHROPIC_ENVIRONMENT_KEY and _ID.
set -euo pipefail
WORKDIR=$(readlink -f "${1:?usage: managed-worker.sh <workdir>}")
HERE=$(dirname "$(readlink -f "$0")")
KEYS=${ELPIS_MANAGED_KEYS:-$HOME/.config/elpis/anthropic-environment.env}
[ -r "$KEYS" ] || { echo "managed-worker: no key file $KEYS" >&2; exit 2; }
KEY=$(sed -n 's/^ANTHROPIC_ENVIRONMENT_KEY=//p' "$KEYS"); ENV_ID=$(sed -n 's/^ANTHROPIC_ENVIRONMENT_ID=//p' "$KEYS")
GIT_COMMON=$(git -C "$WORKDIR" rev-parse --path-format=absolute --git-common-dir)
NODE_MODULES=$(readlink -f "$WORKDIR/apps/elpis-desktop/node_modules" 2>/dev/null || true)
PLAYWRIGHT=$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright
# --check runs a probe of what the sandbox can see instead of the worker: your home's secrets and anything beside the workdir
# must be hidden. The probe gets your real home as $0 and the workdir as $1.
CHECK=(); CHECK_ARGS=(); [ "${2:-}" = --check ] && { CHECK=(/bin/bash); CHECK_ARGS=(-c 'H=$0 W=$1; for p in "$W" "$H/.ssh" "$H/.claude" "$H/.elpis-next" "$H/.config/elpis"; do [ -e "$p" ] && echo "visible $p" || echo "hidden $p"; done; [ -w "$W" ] && echo "workdir writable"; echo "beside the workdir: $(ls -A "$(dirname "$W")" | tr "\n" " ")"; env | cut -d= -f1 | sort | tr "\n" " "' "$HOME"); }
SANDBOX_HOME=$HOME/.cache/elpis-managed-home; mkdir -p "$SANDBOX_HOME"
ro() { [ -e "$1" ] && printf '%s\0%s\0%s\0' --ro-bind "$1" "$1"; return 0; }
mapfile -d '' OPTIONAL < <(ro /opt; ro /run/systemd/resolve; ro "$(readlink -f "$HERE/node_modules")"; ro "$NODE_MODULES"; ro "$PLAYWRIGHT"; ro "$HOME/.cache/ms-playwright")
exec env -i PATH=/usr/local/node/bin:/usr/local/bin:/usr/bin:/bin HOME="$SANDBOX_HOME" LANG=C.UTF-8 \
  ANTHROPIC_ENVIRONMENT_KEY="$KEY" ANTHROPIC_ENVIRONMENT_ID="$ENV_ID" \
  ELPIS_PLAYWRIGHT_PACKAGE="$PLAYWRIGHT" ELPIS_CHROMIUM=/usr/bin/google-chrome \
  ${HTTPS_PROXY:+HTTPS_PROXY=$HTTPS_PROXY HTTP_PROXY=${HTTP_PROXY:-$HTTPS_PROXY} NO_PROXY=${NO_PROXY:-localhost,127.0.0.1,::1} NODE_USE_ENV_PROXY=1} \
  bwrap --die-with-parent --new-session --unshare-all --share-net \
    --ro-bind /usr /usr --ro-bind /etc /etc --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
    --symlink usr/sbin /sbin --proc /proc --dev /dev --tmpfs /tmp \
    "${OPTIONAL[@]}" \
    --ro-bind "$HERE" "$HERE" \
    --bind "$GIT_COMMON" "$GIT_COMMON" --bind "$WORKDIR" "$WORKDIR" --bind "$SANDBOX_HOME" "$SANDBOX_HOME" \
    --chdir "$WORKDIR" \
    "${CHECK[@]:-/usr/local/node/bin/node}" "${CHECK_ARGS[@]:-$HERE/managed-worker.mjs}" ${CHECK:+} "$WORKDIR"
