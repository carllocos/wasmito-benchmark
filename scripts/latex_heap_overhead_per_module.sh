#!/bin/sh
#
# Usage: latex_heap_overhead_per_module.sh [<heap.csv> [<output.tex>]]
#
# Writes a LaTeX table with, for every analysis and Wasm module, how many
# times the heap consumed by deploying the hooks (deploy_delta) is larger
# than the Wasm module (default output
# bench_output/heap_usage/heap_per_module.tex). See
# latex_heap_table.sh for the layout and the HEAP_* variables.

set -e
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
IN_CSV=${1:-$ROOT_DIR/bench_output/heap_usage/heap.csv}
OUT_TEX=${2:-$ROOT_DIR/bench_output/heap_usage/heap_per_module.tex}

HEAP_VALUES=overhead \
HEAP_LABEL=${HEAP_LABEL:-tbl:heap-all} \
    "$ROOT_DIR/scripts/latex_heap_table.sh" "$IN_CSV" "$OUT_TEX"
