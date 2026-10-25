#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_root="${BUILD_ROOT:-$root/build}"
if [[ "$build_root" != /* ]]; then
  build_root="$root/$build_root"
fi
artifacts="$build_root/jspi-pthread"
dist="$root/dist"

for artifact in openFPGALoader.mjs openFPGALoader.wasm; do
  if [[ ! -s "$artifacts/$artifact" ]]; then
    printf 'Missing required C-profile artifact: %s\n' "$artifacts/$artifact" >&2
    exit 1
  fi
done

if [[ ! -f "$root/web/index.html" || ! -f "$root/web/serve.py" ]]; then
  printf 'Missing web application sources under %s/web\n' "$root" >&2
  exit 1
fi

rm -rf -- "$dist"
mkdir -p "$dist"
cp -R "$root/web/." "$dist/"
cp "$artifacts/openFPGALoader.mjs" "$dist/openFPGALoader.mjs"
cp "$artifacts/openFPGALoader.wasm" "$dist/openFPGALoader.wasm"

printf 'Assembled web app in %s from %s\n' "$dist" "$artifacts"
