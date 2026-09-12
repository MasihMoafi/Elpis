#!/usr/bin/env bash
set -euo pipefail
script="$PWD/scripts/install-elpis.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/elpis-installer-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT
failures=0

release="$work/release"
mkdir -p "$release"
for asset in elpis-linux-x86_64 elpis-macos-arm64 elpis-bwrap-linux-x86_64; do
  printf 'payload-for-%s\n' "$asset" > "$release/$asset"
  (cd "$release" && sha256sum "$asset" > "$asset.sha256")
done

make_shims() {
  # $1 shim dir, $2 uname -s, $3 uname -m, $4 "gnu" | "bsd"
  local dir=$1 sysname=$2 machine=$3 flavor=$4
  mkdir -p "$dir"
  cat > "$dir/uname" <<EOF
#!/usr/bin/env bash
case "\$1" in
  -s) echo "$sysname" ;;
  -m) echo "$machine" ;;
  *) echo "$sysname" ;;
esac
EOF
  cat > "$dir/curl" <<EOF
#!/usr/bin/env bash
dest=""; url=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    --output) dest=\$2; shift 2 ;;
    http*) url=\$1; shift ;;
    *) shift ;;
  esac
done
echo "CURL \$url" >> "$work/curl.log"
name=\${url##*/}
test -f "$release/\$name" || { echo "fake curl: 404 \$name" >&2; exit 22; }
cp "$release/\$name" "\$dest"
EOF
  chmod +x "$dir/uname" "$dir/curl"
  # The "bsd" flavor omits sha256sum so the macOS `shasum` fallback runs.
  local tools=(bash sh mktemp mkdir install mv rm cp sed)
  if [ "$flavor" = gnu ]; then
    tools+=(sha256sum shasum)
  else
    tools+=(shasum)
  fi
  for tool in "${tools[@]}"; do
    ln -sf "$(command -v "$tool")" "$dir/$tool"
  done
}

check() {
  # $1 label, $2 uname -s, $3 uname -m, $4 flavor, $5 expected asset
  local label=$1 sysname=$2 machine=$3 flavor=$4 expected=$5
  local dir="$work/case-$label"
  make_shims "$dir/bin" "$sysname" "$machine" "$flavor"
  : > "$work/curl.log"
  if env -i HOME="$dir" PATH="$dir/bin" TMPDIR="$dir" \
      ELPIS_SKIP_RTK=1 ELPIS_INSTALL_DIR="$dir/install" \
      bash "$script" > "$dir/out" 2> "$dir/err"; then
    if [ "$(cat "$dir/install/elpis")" != "payload-for-$expected" ]; then
      printf 'FAIL %-14s installed the wrong asset\n' "$label"
      failures=$((failures + 1))
    elif ! grep -q "/$expected\$" "$work/curl.log"; then
      printf 'FAIL %-14s did not fetch %s\n' "$label" "$expected"
      failures=$((failures + 1))
    elif [ ! -x "$dir/install/elpis" ]; then
      printf 'FAIL %-14s installed file is not executable\n' "$label"
      failures=$((failures + 1))
    elif [ "$sysname" = Linux ] && { [ ! -x "$dir/install/codex-resources/bwrap" ] || [ "$(cat "$dir/install/codex-resources/bwrap")" != "payload-for-elpis-bwrap-linux-x86_64" ]; }; then
      printf 'FAIL %-14s missing or incorrect sandbox\n' "$label"
      failures=$((failures + 1))
    else
      printf 'PASS %-14s %s-%s -> %s\n' "$label" "$sysname" "$machine" "$expected"
    fi
  else
    printf 'FAIL %-14s installer exited non-zero\n' "$label"
    sed 's/^/       /' "$dir/err"
    failures=$((failures + 1))
  fi
}

reject() {
  # $1 label, $2 uname -s, $3 uname -m, $4 flavor
  local label=$1
  local dir="$work/case-$label"
  make_shims "$dir/bin" "$2" "$3" "$4"
  : > "$work/curl.log"
  if env -i HOME="$dir" PATH="$dir/bin" TMPDIR="$dir" \
      ELPIS_SKIP_RTK=1 ELPIS_INSTALL_DIR="$dir/install" \
      bash "$script" > "$dir/out" 2> "$dir/err"; then
    printf 'FAIL %-14s %s-%s was accepted but must be rejected\n' "$label" "$2" "$3"
    failures=$((failures + 1))
  elif [ -s "$work/curl.log" ]; then
    printf 'FAIL %-14s rejected platform still hit the network\n' "$label"
    failures=$((failures + 1))
  else
    printf 'PASS %-14s %s-%s rejected: %s\n' "$label" "$2" "$3" "$(head -1 "$dir/err")"
  fi
}

check linux-x86_64 Linux x86_64 gnu elpis-linux-x86_64
check darwin-arm64 Darwin arm64 bsd elpis-macos-arm64
reject darwin-x86_64 Darwin x86_64 bsd
reject linux-aarch64 Linux aarch64 gnu

test "$failures" -eq 0

# A corrupt companion must not replace an existing working installation.
dir="$work/case-linux-x86_64"
printf 'old elpis\n' > "$dir/install/elpis"
printf 'old sandbox\n' > "$dir/install/codex-resources/bwrap"
printf 'corrupt sandbox\n' > "$release/elpis-bwrap-linux-x86_64"
if env -i HOME="$dir" PATH="$dir/bin" TMPDIR="$dir" \
    ELPIS_SKIP_RTK=1 ELPIS_INSTALL_DIR="$dir/install" \
    bash "$script" > "$dir/out" 2> "$dir/err"; then
  printf 'FAIL corrupt sandbox was accepted\n' >&2
  exit 1
fi
test "$(cat "$dir/install/elpis")" = 'old elpis'
test "$(cat "$dir/install/codex-resources/bwrap")" = 'old sandbox'
printf 'PASS corrupt sandbox preserves the installed files\n'
