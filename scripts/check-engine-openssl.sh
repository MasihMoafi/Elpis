#!/usr/bin/env bash
# check-engine-openssl.sh DIR: the shipped engine carries its own OpenSSL and still speaks TLS.
#   DIR holds elpis (or codex), codex-code-mode-host and bwrap, as the release build leaves them.
# 1. No shipped binary may need a system libssl or libcrypto: Arch moved to OpenSSL 4, dropped libssl.so.3,
#    and v0.5.1 and v0.5.2 did not start there (12 Nov).
# 2. One HTTPS request from the engine to api.openai.com with a made-up key must end in an HTTP answer (401),
#    on this machine and in an archlinux:latest container: the built-in OpenSSL must find the system's
#    certificates. A control with no certificates must fail, so the check can fail.
#   check-engine-openssl.sh --tls ENGINE   only part 2, on this machine (the container runs this)
#   ELPIS_TLS_ARCH=0                       skip the Arch container (no Docker)
set -euo pipefail

answer='401|Unauthorized|invalid_api_key|Incorrect API key'
tls_request() { # tls_request ENGINE [VAR=value...]: the engine's output for one model request
  local engine=$1 home; shift; home=$(mktemp -d)
  env -i PATH=/usr/bin:/bin HOME="$home" ELPIS_HOME="$home/.elpis-next" CODEX_API_KEY=sk-elpis-tls-check-not-a-key "$@" \
    timeout 60 "$engine" exec --skip-git-repo-check -C "$home" 'Reply with OK.' </dev/null 2>&1 || true
}
tls_check() { # tls_check ENGINE LABEL
  local out control
  out=$(tls_request "$1")
  echo "$2: $(grep -Eo "$answer|[^ ]*(certificate|handshake)[^.]*" <<<"$out" | head -n 2 | tr '\n' ' ')"
  grep -Eq "$answer" <<<"$out" || { echo "FAIL: no HTTP answer on $2" >&2; tail -n 20 <<<"$out" >&2; return 1; }
  # openssl-probe ignores a path that does not exist and finds the system's certificates anyway, so the
  # control names an empty file and an empty folder that do exist.
  local none; none=$(mktemp -d); : > "$none/none.pem"; mkdir "$none/certs"
  control=$(tls_request "$1" SSL_CERT_FILE="$none/none.pem" SSL_CERT_DIR="$none/certs")
  if grep -Eq "$answer" <<<"$control"; then
    echo "FAIL: on $2 the request was answered with no certificates, so this check proves nothing" >&2
    tail -n 20 <<<"$control" >&2; return 1
  fi
  echo "$2 control with no certificates: $(grep -Ei 'certificate|handshake|verify' <<<"$control" | head -n 1 | cut -c1-240)"
}

if [[ ${1:-} == --tls ]]; then tls_check "$2" "$3"; exit; fi

dir=$(cd "$1" && pwd)
engine=$dir/elpis; [[ -x $engine ]] || engine=$dir/codex
bwrap=$dir/bwrap; [[ -x $bwrap ]] || bwrap=$dir/codex-resources/bwrap
failed=0
for file in "$engine" "$dir/codex-code-mode-host" "$bwrap"; do
  needed=$(objdump -p "$file" | awk '/NEEDED/ {print $2}' | tr '\n' ' ')
  echo "$(basename "$file") needs: $needed"
  if grep -Eq '(^| )lib(ssl|crypto)\.' <<<"$needed"; then echo "FAIL: $file needs a system OpenSSL" >&2; failed=1; fi
done
((failed == 0)) || exit 1

tls_check "$engine" "$(. /etc/os-release && echo "$PRETTY_NAME")"
if [[ ${ELPIS_TLS_ARCH:-1} != 0 ]]; then
  script=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
  docker run --rm -v "$dir:/e:ro" -v "$script:/check.sh:ro" archlinux:latest \
    bash -c "pacman -Syu --noconfirm --needed openssl >/dev/null && pacman -Q openssl && ! ls /usr/lib/libssl.so.3 2>/dev/null \
      && /e/$(basename "$engine") --version && bash /check.sh --tls /e/$(basename "$engine") 'Arch'"
fi
echo "OK: no shipped binary needs a system OpenSSL, and TLS answers"
