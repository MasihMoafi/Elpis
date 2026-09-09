#!/usr/bin/env bash
set -euo pipefail
export HOME=/tmp/elpis-clean-home
export CODEX_HOME="$HOME/.elpis"
mkdir -p "$CODEX_HOME"
coproc RUNTIME { /opt/elpis-app-server 2>/tmp/elpis-runtime.stderr; }
runtime_pid=$RUNTIME_PID
trap 'kill "$runtime_pid" 2>/dev/null || true' EXIT
send() { printf '%s\n' "$1" >&"${RUNTIME[1]}"; }
response() {
  local id=$1 line
  while IFS= read -r -t 20 line <&"${RUNTIME[0]}"; do
    case "$line" in
      *'"error":'*) printf '%s\n' "$line" >&2; return 1;;
    esac
    if [[ "$line" == *"\"id\":$id,"* || "$line" == *"\"id\":$id}"* ]]; then
      REPLY=$line
      return 0
    fi
  done
  return 1
}
send '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"elpis_release_smoke","version":"0.1.17"},"capabilities":{"experimentalApi":true}}}'
response 1
send '{"method":"initialized"}'
send '{"id":2,"method":"account/read","params":{"refreshToken":false}}'
response 2
[[ "$REPLY" == *'"account":null'* ]]
send '{"id":3,"method":"config/read","params":{"cwd":"/tmp","includeLayers":true}}'
response 3
[[ "$REPLY" == *'"config":'* ]]
printf '%s\n' 'PASS: fresh unprivileged home, no account, no network; initialize and configuration work.'
