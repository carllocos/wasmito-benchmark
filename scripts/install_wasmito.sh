#!/bin/sh
#
# Usage: install_wasmito.sh
#
# Installs Wasmito (wasmito/scripts/install.sh, which also builds the Wasmito
# CLI) and then builds the MCU example programs in
# bench_input_data/mcu_modules/, one directory per example:
#   - an AssemblyScript example (a directory with a package.json) is built
#     with `npm install && npm run build`, which writes its modules to
#     <example>/wasm/;
#   - a WAT example (a directory with *.wat files) is compiled with the
#     Wasmito CLI's `wat` command, writing <example>/wasm/<name>.wasm for
#     every <name>.wat.

set -e
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

CLI="$WASMITO_DIR/dist/cjs/cli/cli.cjs"
MCU_MODULES_DIR="$ROOT_DIR/bench_input_data/mcu_modules"

echo "> Installing Wasmito"
cd "$WASMITO_DIR"
/bin/sh ./scripts/install.sh

for EXAMPLE in "$MCU_MODULES_DIR"/*/; do
    EXAMPLE=${EXAMPLE%/}
    NAME=$(basename "$EXAMPLE")
    if [ -f "$EXAMPLE/package.json" ]; then
        echo "> Building AssemblyScript example $NAME"
        (cd "$EXAMPLE" && npm install && npm run build)
    else
        FOUND_WAT=0
        for WAT in "$EXAMPLE"/*.wat; do
            [ -f "$WAT" ] || continue
            FOUND_WAT=1
            mkdir -p "$EXAMPLE/wasm"
            WASM="$EXAMPLE/wasm/$(basename "$WAT" .wat).wasm"
            echo "> Compiling WAT example $NAME: $(basename "$WAT")"
            node "$CLI" wat "$WAT" "$WASM"
        done
        if [ "$FOUND_WAT" -eq 0 ]; then
            echo "warning: skipping '$EXAMPLE': no package.json or *.wat file" >&2
        fi
    fi
done
