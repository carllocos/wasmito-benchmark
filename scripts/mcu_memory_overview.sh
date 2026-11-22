#!/bin/sh
#
# Usage: mcu_memory_overview.sh [--output <dir>]
#
# Builds the overview of the memory that every analysis of Whamm,
# Wastrumentation and Wasmito needs on the four MCU modules of the
# concurrency bug evaluation, and how much RAM of an M5StickC running
# WARDuino remains (src/mcu_memory_overview.js), from:
#   bench_output/wastrumentation_stack/  build_mcu_modules_wastrumentation_stack_sizes.sh
#   whamm_mcu_modules/                   build_mcu_modules_whamm.sh
#   bench_output/whamm_core_stack/       build_whamm_core_stack_sizes.sh
#   bench_output/memory_growth/          measure_memory_growth_mcu.sh
#   bench_output/heap_usage/heap.csv     Wasmito's heap measurements
# Run those first (in this order); this script only combines their results.
#
# Options (--flag value or --flag=value):
#   --output <dir>
#       Defaults to bench_output/mcu_memory_overview/ in the root of
#       wasmito-benchmark.
#
# Writes mcu_memory_overview.csv (one row per framework, stack size,
# analysis and module) and mcu_memory_overview.md (ranges over the modules).

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)

usage() {
    echo "Usage: $0 [--output <dir>]" >&2
    exit 1
}

OUTPUT="$ROOT_DIR/bench_output/mcu_memory_overview"
while [ $# -gt 0 ]; do
    case "$1" in
        --output=*) OUTPUT=${1#*=}; shift ;;
        --output) [ $# -ge 2 ] || usage; OUTPUT=$2; shift 2 ;;
        *) echo "Unknown option '$1'" >&2; usage ;;
    esac
done

exec node "$ROOT_DIR/src/mcu_memory_overview.js" \
    --growth "$ROOT_DIR/bench_output/memory_growth/memory_growth.csv" \
    --heap "$ROOT_DIR/bench_output/heap_usage/heap.csv" \
    --output "$OUTPUT"
