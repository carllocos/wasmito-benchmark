#!/bin/sh
#
# Usage: measure_memory_growth_mcu.sh [--output <csv-file>] [--iterations <n>]
#
# Measures how the linear memories of the instrumented MCU modules grow
# while they run, with src/measure_memory_growth.js: every iteration of the
# main loop of an MCU module (one call to chip_delay) also fires its
# interrupt handler once, and the pages of every linear memory are recorded
# after 0, 1, 2, 5, 10, 20, 50, ... iterations.
#
# The modules, with the variant column of the CSV:
#   original         bench_input_data/mcu_modules/*/wasm/*.wasm (variant -)
#   wastrumentation  bench_output/wastrumentation_stack/<size>/wastrumentation/
#                    <analysis>/<module>.wasm, from
#                    build_mcu_modules_wastrumentation_stack_sizes.sh
#                    (variant: the stack size of the analysis, or "default")
#   whamm            whamm_mcu_modules/<analysis>/<module>.wasm, from
#                    build_mcu_modules_whamm.sh, linked with every
#                    bench_output/whamm_core_stack/whamm_core_<size>.wasm, from
#                    build_whamm_core_stack_sizes.sh (variant: the stack size
#                    of whamm_core)
#
# Options (--flag value or --flag=value):
#   --output <csv-file>
#       Defaults to bench_output/memory_growth/memory_growth.csv in the root of
#       wasmito-benchmark.
#   --iterations <n>
#       iterations of the main loop per module. Defaults to 10000; the MCU
#       modules wait 1 s per iteration on the MCU, so 10000 iterations
#       correspond to almost 3 hours.
#
# The CSV has the columns
#   framework,variant,analysis,module,iteration,total_pages,total_kib,pages_per_memory,status
# A run that fails (e.g. traps) does not stop the rest; the script then exits
# non-zero.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

usage() {
    echo "Usage: $0 [--output <csv-file>] [--iterations <n>]" >&2
    exit 1
}

OUTPUT="$ROOT_DIR/bench_output/memory_growth/memory_growth.csv"
ITERATIONS=10000
while [ $# -gt 0 ]; do
    case "$1" in
        --output=*) OUTPUT=${1#*=}; shift ;;
        --output) [ $# -ge 2 ] || usage; OUTPUT=$2; shift 2 ;;
        --iterations=*) ITERATIONS=${1#*=}; shift ;;
        --iterations) [ $# -ge 2 ] || usage; ITERATIONS=$2; shift 2 ;;
        *) echo "Unknown option '$1'" >&2; usage ;;
    esac
done

for TOOL in node wasm-tools; do
    if ! command -v "$TOOL" >/dev/null 2>&1; then
        echo "error: $TOOL not found" >&2
        exit 1
    fi
done

RUNNER="$ROOT_DIR/src/measure_memory_growth.js"
MCU_MODULES=$(find "$ROOT_DIR/bench_input_data/mcu_modules" -path '*/node_modules' -prune -o \
    -path '*/wasm/*.wasm' -type f -print | sort)
WASTRUMENTATION_STACK_DIR="$ROOT_DIR/bench_output/wastrumentation_stack"
WHAMM_CORE_STACK_DIR="$ROOT_DIR/bench_output/whamm_core_stack"

if [ ! -d "$WASTRUMENTATION_STACK_DIR" ]; then
    echo "warning: '$WASTRUMENTATION_STACK_DIR' not found (run build_mcu_modules_wastrumentation_stack_sizes.sh)" >&2
fi
if [ ! -d "$WHAMM_CORE_STACK_DIR" ]; then
    echo "warning: '$WHAMM_CORE_STACK_DIR' not found (run build_whamm_core_stack_sizes.sh)" >&2
fi

mkdir -p "$(dirname "$OUTPUT")"
echo "framework,variant,analysis,module,iteration,total_pages,total_kib,pages_per_memory,status" > "$OUTPUT"
STATUS=0

# Runs the module $4 as framework $1, variant $2 and analysis $3, with any
# further arguments passed to the runner.
measure() {
    FRAMEWORK=$1
    VARIANT=$2
    ANALYSIS=$3
    MODULE=$4
    shift 4
    echo "=== $FRAMEWORK $VARIANT $ANALYSIS $(basename "$MODULE" .wasm) ==="
    if ! node --no-warnings "$RUNNER" --iterations "$ITERATIONS" \
        --framework "$FRAMEWORK" --variant "$VARIANT" --analysis "$ANALYSIS" \
        "$@" "$MODULE" >> "$OUTPUT"; then
        echo "  failed" >&2
        STATUS=1
    fi
}

for MODULE in $MCU_MODULES; do
    NAME=$(basename "$MODULE" .wasm)
    measure original - none "$MODULE"

    for SIZE_DIR in "$WASTRUMENTATION_STACK_DIR"/*/; do
        [ -d "$SIZE_DIR" ] || continue
        SIZE=$(basename "$SIZE_DIR")
        for INSTRUMENTED in "$SIZE_DIR"wastrumentation/*/"$NAME".wasm; do
            [ -f "$INSTRUMENTED" ] || continue
            measure wastrumentation "$SIZE" "$(basename "$(dirname "$INSTRUMENTED")")" "$INSTRUMENTED"
        done
    done

    for INSTRUMENTED in "$ROOT_DIR"/whamm_mcu_modules/*/"$NAME".wasm; do
        [ -f "$INSTRUMENTED" ] || continue
        ANALYSIS=$(basename "$(dirname "$INSTRUMENTED")")
        for CORE in "$WHAMM_CORE_STACK_DIR"/whamm_core_*.wasm; do
            [ -f "$CORE" ] || continue
            SIZE=$(basename "$CORE" .wasm)
            measure whamm "${SIZE#whamm_core_}" "$ANALYSIS" "$INSTRUMENTED" --whamm-core "$CORE"
        done
    done
done

echo "> Wrote $OUTPUT"
exit "$STATUS"
