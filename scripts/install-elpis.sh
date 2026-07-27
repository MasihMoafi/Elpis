#!/usr/bin/env bash
set -euo pipefail

# ELPIS_PLATFORM overrides detection so the branch below can be exercised for a
# platform other than the one running the script. It is not needed for a normal
# install.
platform=${ELPIS_PLATFORM:-"$(uname -s)-$(uname -m)"}
case "$platform" in
  Linux-x86_64) asset=elpis-linux-x86_64 ;;
  Darwin-arm64) asset=elpis-macos-arm64 ;;
  Darwin-x86_64)
    printf 'Elpis publishes an Apple Silicon (arm64) macOS binary only.\n' >&2
    printf 'This shell reports x86_64; if the Mac is Apple Silicon, rerun outside Rosetta.\n' >&2
    exit 1
    ;;
  *)
    printf 'Elpis publishes binaries for Linux x86_64 and macOS arm64 only (detected %s).\n' \
      "$platform" >&2
    exit 1
    ;;
esac

repository=${ELPIS_GITHUB_REPOSITORY:-MasihMoafi/Elpis}
install_dir=${ELPIS_INSTALL_DIR:-"$HOME/.local/bin"}
release_url="https://github.com/$repository/releases/latest/download"
# macOS `mktemp` requires an explicit template, so do not shorten this to `mktemp -d`.
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/elpis-install.XXXXXX")
trap 'rm -rf "$temporary_dir"' EXIT

curl --fail --location --progress-bar \
  "$release_url/$asset" --output "$temporary_dir/$asset"
curl --fail --location --progress-bar \
  "$release_url/$asset.sha256" --output "$temporary_dir/$asset.sha256"

(
  cd "$temporary_dir"
  # macOS ships `shasum`, not GNU `sha256sum`; both read the same checksum format.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check "$asset.sha256"
  else
    shasum -a 256 --check "$asset.sha256"
  fi
)

mkdir -p "$install_dir"
install -m 0755 "$temporary_dir/$asset" "$install_dir/.elpis.installing"
mv -f "$install_dir/.elpis.installing" "$install_dir/elpis"
printf 'Installed Elpis at %s\n' "$install_dir/elpis"

# Layer 1 of Elpis's context pruning rewrites shell commands through RTK, so RTK is part
# of a complete install. Elpis registers its hook on first launch once RTK is on PATH.
# Set ELPIS_SKIP_RTK=1 to install Elpis alone.
if [ "${ELPIS_SKIP_RTK:-0}" = "1" ]; then
  printf 'Skipped RTK; shell-output filtering stays off.\n'
elif command -v rtk >/dev/null 2>&1; then
  printf 'RTK already installed at %s\n' "$(command -v rtk)"
else
  printf 'Installing RTK for shell-output filtering...\n'
  if curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh; then
    printf 'Installed RTK.\n'
  else
    printf 'RTK install failed; Elpis works without it, with shell-output filtering off.\n' >&2
  fi
fi
