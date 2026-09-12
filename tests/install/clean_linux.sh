#!/usr/bin/env bash
set -euo pipefail

artifacts=$(realpath "${1:?usage: clean_linux.sh DIRECTORY_WITH_ELPIS_AND_BWRAP}")
installer=$(realpath scripts/install-elpis-binary.sh)
test -x "$artifacts/elpis"
test -x "$artifacts/bwrap"

# Docker must permit the nested namespaces that Elpis itself constructs.
docker run --rm --network none --cap-add SYS_ADMIN \
    --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
    -v "$artifacts:/artifacts:ro" -v "$installer:/install.sh:ro" \
    -i ubuntu:24.04 bash -s <<'CONTAINER'
set -euo pipefail
test ! -e /root/.elpis
test ! -e /root/.codex
ELPIS_INSTALL_DIR=/usr/local/bin bash /install.sh /artifacts/elpis /artifacts/bwrap
elpis --version
test -x /usr/local/bin/codex-resources/bwrap
mkdir -p /tmp/project
profile='{"type":"managed","network":"restricted","file_system":{"type":"restricted","entries":[{"path":{"type":"path","path":"/"},"access":"read"},{"path":{"type":"path","path":"/tmp/project"},"access":"write"}]}}'
bash -c 'exec -a codex-linux-sandbox /usr/local/bin/elpis "$@"' sandbox \
    --sandbox-policy-cwd /tmp/project --permission-profile "$profile" -- \
    /bin/sh -c 'set -e; printf allowed > /tmp/project/allowed; if touch /tmp/blocked 2>/dev/null; then exit 1; fi; printf "sandbox enforced\n"'
test "$(cat /tmp/project/allowed)" = allowed
test ! -e /tmp/blocked
printf 'PASS clean offline Linux installation and sandbox enforcement\n'
CONTAINER
