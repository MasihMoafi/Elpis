#!/usr/bin/env bash
# check-glibc.sh MAX PATH...: prints the highest glibc (and libstdc++) symbol version each ELF file needs, and fails
# when any needs a glibc newer than MAX. A PATH may be a folder, a file, a .deb or an AppImage (both unpacked first).
# v0.5.3's AppImage, built on this laptop, needed glibc 2.42 (node-pty) and 2.39 (the engine): it did not start on
# Ubuntu 22.04 or 24.04, Debian 12 or 13 or Fedora 42 (AppImage catalog test, 14 Nov). The desktop packages
# workflow (.github/workflows/desktop-packages.yml) runs this on every file it ships, with MAX 2.35 (Ubuntu 22.04).
set -euo pipefail
max=${1:?usage: check-glibc.sh MAX PATH...}; shift
(($#)) || { echo "usage: check-glibc.sh MAX PATH..." >&2; exit 2; }
scratch=$(mktemp -d); trap 'rm -rf "$scratch"' EXIT
newer() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" == "$1" ]]; }
failed=0 count=0 top=0
for input in "$@"; do
  root=$input
  case "$input" in
    *.deb) root=$scratch/$(basename "$input"); mkdir -p "$root"; dpkg-deb -x "$input" "$root" ;;
    *.AppImage) image=$(realpath "$input"); root=$scratch/$(basename "$input"); mkdir -p "$root"
      (cd "$root" && "$image" --appimage-extract >/dev/null); root=$root/squashfs-root ;;
  esac
  while IFS= read -r -d '' file; do
    [[ "$(head -c 4 "$file" | od -An -c | tr -d ' ')" == '177ELF' ]] || continue
    symbols=$(objdump -T "$file" 2>/dev/null || true)
    glibc=$(grep -Eo 'GLIBC_[0-9]+(\.[0-9]+)+' <<<"$symbols" | sed 's/GLIBC_//' | sort -uV | tail -n 1 || true)
    cxx=$(grep -Eo 'GLIBCXX_[0-9.]+' <<<"$symbols" | sort -uV | tail -n 1 || true)
    count=$((count + 1))
    printf '%-6s %-16s %s\n' "${glibc:--}" "${cxx:-}" "${file#"$root"/}"
    if [[ -n "$glibc" ]]; then
      newer "$glibc" "$top" && top=$glibc
      if newer "$glibc" "$max"; then echo "FAIL: ${file#"$root"/} needs glibc $glibc, newer than $max" >&2; failed=1; fi
    fi
  done < <(find "$root" -type f -print0 | sort -z)
done
((count > 0)) || { echo "FAIL: no ELF file found in $*" >&2; exit 1; }
echo "$count ELF files; the highest glibc any needs: $top (limit $max)"
exit "$failed"
