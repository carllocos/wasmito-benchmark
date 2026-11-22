#!/bin/sh
#
# Usage: mcu_analyses_memory_table.sh [--skip-build] [--output <dir>]
#
# Writes the CSV with the static and dynamic memory needs of every analysis
# of Wastrumentation, Whamm and Wasmito (the concurrency analyses and the
# general ones) on the four MCU modules of the concurrency bug evaluation,
# against the RAM of an M5StickC running WARDuino, with the smallest stacks
# that do not change how the modules behave:
#
#   1. Instruments the MCU modules with every Wastrumentation analysis of
#      bench_config/wastrumentation_analyses.csv for every stack size
#      (build_mcu_modules_wastrumentation_stack_sizes.sh), with every Whamm
#      script of bench_config/whamm_scripts.csv into whamm_mcu_modules/ and
#      with the Whamm scripts of whamm-concurrency/ into
#      bench_output/whamm_concurrency/ (build_mcu_modules_whamm.sh), and
#      builds whamm_core (build_whamm_core_stack_sizes.sh) and the user
#      libraries of cache_sim and loop_tracer (build_whamm_user_libs_small.sh)
#      with every stack (or heap) size.
#   2. Finds the smallest sizes (src/find_min_stacks_mcu.js) into
#      <output>/min_stacks.csv.
#   3. Measures the sizes of the instrumented modules (src/mcu_module_sizes.js)
#      into <output>/module_sizes.csv.
#   4. Measures the static and dynamic memory needs
#      (src/mcu_analyses_memory_table.js) into <output>/mcu_analyses_memory.csv.
#
# Options (--flag value or --flag=value):
#   --skip-build    skip step 1 (reuse the instrumented modules and libraries)
#   --output <dir>  Defaults to bench_output/mcu_analyses_memory/.
#
# Needs Wasmito's heap measurements in bench_output/heap_usage/heap.csv.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)

usage() {
    echo "Usage: $0 [--skip-build] [--output <dir>]" >&2
    exit 1
}

BUILD=1
OUT_DIR="$ROOT_DIR/bench_output/mcu_analyses_memory"
while [ $# -gt 0 ]; do
    case "$1" in
        --skip-build) BUILD=0; shift ;;
        --output=*) OUT_DIR=${1#*=}; shift ;;
        --output) [ $# -ge 2 ] || usage; OUT_DIR=$2; shift 2 ;;
        *) echo "Unknown option '$1'" >&2; usage ;;
    esac
done

fail() {
    echo "error: $1" >&2
    exit 1
}

if [ "$BUILD" = 1 ]; then
    echo "> Instrumenting the MCU modules with Wastrumentation"
    "$ROOT_DIR/scripts/build_mcu_modules_wastrumentation_stack_sizes.sh" \
        --sizes "default 65536 16384 8192 4096 2048 1024 512 256 128" >/dev/null ||
        fail "instrumenting with Wastrumentation failed"

    echo "> Instrumenting the MCU modules with Whamm"
    "$ROOT_DIR/scripts/build_mcu_modules_whamm.sh" \
        --analyses "branches icount instr_coverage hotness cache_sim mem_access loop_tracer basic_blocks call_graph imix" \
        >/dev/null || fail "instrumenting with Whamm failed"
    "$ROOT_DIR/scripts/build_mcu_modules_whamm.sh" \
        --output "$ROOT_DIR/bench_output/whamm_concurrency" \
        --script-dir "$ROOT_DIR/whamm-concurrency" \
        --analyses "data_race_violation order_violation variable_violation" \
        >/dev/null || fail "instrumenting with the Whamm concurrency scripts failed"

    echo "> Building whamm_core and the user libraries"
    "$ROOT_DIR/scripts/build_whamm_core_stack_sizes.sh" \
        --output "$ROOT_DIR/bench_output/whamm_core_stack/mcu" \
        --sizes "default 65536 16384 8192 4096 2048 1024 512 256" >/dev/null ||
        fail "building whamm_core failed"
    "$ROOT_DIR/scripts/build_whamm_user_libs_small.sh" >/dev/null ||
        fail "building the user libraries failed"
fi

echo "> Finding the smallest stacks"
node "$ROOT_DIR/src/find_min_stacks_mcu.js" --output "$OUT_DIR/min_stacks.csv" ||
    fail "finding the smallest stacks failed"

echo "> Measuring the sizes of the instrumented modules"
node "$ROOT_DIR/src/mcu_module_sizes.js" --stacks "$OUT_DIR/min_stacks.csv" \
    --output "$OUT_DIR/module_sizes.csv" || fail "measuring the module sizes failed"

echo "> Measuring the static and dynamic memory needs"
exec node "$ROOT_DIR/src/mcu_analyses_memory_table.js" \
    --stacks "$OUT_DIR/min_stacks.csv" \
    --heap "$ROOT_DIR/bench_output/heap_usage/heap.csv" \
    --output "$OUT_DIR/mcu_analyses_memory.csv" --max-seconds 120
