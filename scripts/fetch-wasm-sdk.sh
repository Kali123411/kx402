#!/usr/bin/env bash
# Fetch the official rusty-kaspa v2.0.0 nodejs WASM SDK (the ABI kx402 targets).
# npm's `kaspa-wasm` package is a different/stale ABI and will fail with "memory access out of bounds".
set -euo pipefail

VER="v2.0.0"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor"
URL="https://github.com/kaspanet/rusty-kaspa/releases/download/${VER}/kaspa-wasm32-sdk-${VER}.zip"
MODULE="$DEST/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js"

mkdir -p "$DEST"
echo "Downloading $URL"
curl -fSL "$URL" -o "$DEST/kaspa-wasm32-sdk.zip"
echo "Extracting into $DEST"
unzip -oq "$DEST/kaspa-wasm32-sdk.zip" -d "$DEST"
rm -f "$DEST/kaspa-wasm32-sdk.zip"

if [ -f "$MODULE" ]; then
  echo
  echo "✓ WASM SDK ready. Point kx402 at it:"
  echo "    KASPA_X402_KASPA_WASM_MODULE=$MODULE"
else
  echo "✗ expected module not found at $MODULE — inspect $DEST" >&2
  exit 1
fi
