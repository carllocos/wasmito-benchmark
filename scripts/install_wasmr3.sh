#!/bin/sh

# Creates wasmr3_modules/: the modules of wasm-benchmarks/wasm-r3-bench
# listed in wasmr3_modules_to_keep.txt (one per line, # starts a comment)

set -e
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"
SRC_DIR=$ROOT_DIR/wasm-benchmarks/wasm-r3-bench
DEST_DIR=$WASMR3_MODULES_DIR
MODULES_FILE=$ROOT_DIR/wasmr3_modules_to_keep.txt

echo "> Copying modules listed in $MODULES_FILE to $DEST_DIR"
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d' "$MODULES_FILE" | while IFS= read -r module; do
  cp "$SRC_DIR/$module" "$DEST_DIR/"
done
