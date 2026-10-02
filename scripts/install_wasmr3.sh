#!/bin/sh

# Creates bench_input_data/wasmr3_modules/: the modules of
# wasm-benchmarks/wasm-r3-bench listed in
# bench_config/wasmr3_modules_to_keep.txt (one per line, # starts a comment)
#
# bench_input_data/ also holds other committed inputs (e.g. mcu_modules/), so
# only its wasmr3_modules/ subdirectory is replaced; bench_input_data/ is
# created if it does not exist yet and is otherwise left untouched.

set -e
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"
SRC_DIR=$ROOT_DIR/wasm-benchmarks/wasm-r3-bench
DEST_DIR=$WASMR3_MODULES_DIR
MODULES_FILE=$ROOT_DIR/bench_config/wasmr3_modules_to_keep.txt

case "$DEST_DIR" in
  "$ROOT_DIR/bench_input_data/"?*) ;;
  *)
    echo "error: refusing to replace '$DEST_DIR' (expected a subdirectory of $ROOT_DIR/bench_input_data)" >&2
    exit 1
    ;;
esac

echo "> Copying modules listed in $MODULES_FILE to $DEST_DIR"
mkdir -p "$ROOT_DIR/bench_input_data"
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d' "$MODULES_FILE" | while IFS= read -r module; do
  cp "$SRC_DIR/$module" "$DEST_DIR/"
done
