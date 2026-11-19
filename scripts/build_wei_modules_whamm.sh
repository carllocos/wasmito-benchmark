#!/bin/sh
#
# Usage: build_wei_modules_whamm.sh [--output <dir>]
#
# Compiles, for Wizard's Whamm Engine Interface (wei), every whamm script of
# bench_config/whamm_scripts.csv and of whamm-concurrency/ against every
# Wasm-R3 module ($WASMR3_MODULES_DIR) and every MCU module of the
# concurrency bug evaluation (bench_input_data/mcu_modules/*/wasm/), with
#   whamm instr --wei --app <module> --script <whamm-script> -o <output>
# cache_sim and loop_tracer also get their user library through --user-libs
# (see whamm_user_libs in env.sh), as in build_monitors_wei.sh.
#
# Note: with --wei, whamm emits a monitor module (mon.wasm) that Wizard loads
# next to the unchanged application (wizeng --monitors=<output> <module>); the
# application is not rewritten, so the monitor does not depend on --app.
#
# Results are written to <dir> (default bench_output/modules_overhead/whamm-wei), in a
# subdirectory per whamm script:
#   <name>/<module>.wasm  the wei monitor
#   <name>/<module>.log   the output of whamm
#
# A failing compile does not stop the rest; at the end, every
# (whamm script, module) that failed is listed and the script exits non-zero.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

usage() {
    echo "Usage: $0 [--output <dir>]" >&2
    exit 1
}

OUT_DIR="$MODULES_OVERHEAD_DIR/whamm-wei"
while [ $# -gt 0 ]; do
    case "$1" in
        --output=*) OUT_DIR=${1#*=}; shift ;;
        --output) [ $# -ge 2 ] || usage; OUT_DIR=$2; shift 2 ;;
        *) echo "Unknown option '$1'" >&2; usage ;;
    esac
done

if ! command -v whamm >/dev/null 2>&1; then
    echo "error: whamm not found (run scripts/install_whamm.sh first)" >&2
    exit 1
fi

MODULES=$(ls "$WASMR3_MODULES_DIR"/*.wasm "$ROOT_DIR"/bench_input_data/mcu_modules/*/wasm/*.wasm 2>/dev/null)
if [ -z "$MODULES" ]; then
    echo "error: no modules found (run scripts/install_wasmr3.sh first)" >&2
    exit 1
fi

STATUS=0
FAILED=""
COUNT=0

compile_all() {
    # $1=whamm-script $2=name
    LIBS=$(whamm_user_libs "$2")
    mkdir -p "$OUT_DIR/$2"
    for MODULE in $MODULES; do
        BASE=$(basename "$MODULE" .wasm)
        OUT="$OUT_DIR/$2/$BASE.wasm"
        if [ -n "$LIBS" ]; then
            whamm instr --wei --app "$MODULE" --script "$1" --user-libs "$LIBS" -o "$OUT" \
                >"$OUT_DIR/$2/$BASE.log" 2>&1
        else
            whamm instr --wei --app "$MODULE" --script "$1" -o "$OUT" \
                >"$OUT_DIR/$2/$BASE.log" 2>&1
        fi
        if [ $? -eq 0 ] && [ -f "$OUT" ]; then
            COUNT=$((COUNT + 1))
        else
            STATUS=1
            FAILED="$FAILED$2 $BASE
"
        fi
    done
    echo "$2: done"
}

for_each_whamm_script compile_all || exit 1
for SCRIPT in "$ROOT_DIR"/whamm-concurrency/*.mm; do
    compile_all "$SCRIPT" "$(basename "$SCRIPT" .mm)"
done

echo "Compiled $COUNT wei monitors into $OUT_DIR"
if [ -n "$FAILED" ]; then
    echo "" >&2
    echo "Compilation failed for the following (whamm script, module):" >&2
    printf '%s' "$FAILED" | sed 's/^/  /' >&2
fi

exit "$STATUS"
