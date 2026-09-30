#!/bin/sh

# Creates modules_to_bench/: the modules of wasm-benchmarks/wasm-r3-bench
# listed in modules_to_bench.txt (one per line, # starts a comment)

set -e
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SRC_DIR=$ROOT_DIR/wasm-benchmarks/wasm-r3-bench
DEST_DIR=$ROOT_DIR/modules_to_bench
MODULES_FILE=$ROOT_DIR/modules_to_bench.txt

echo "> Copying modules listed in $MODULES_FILE to $DEST_DIR"
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d' "$MODULES_FILE" | while IFS= read -r module; do
  cp "$SRC_DIR/$module" "$DEST_DIR/"
done
