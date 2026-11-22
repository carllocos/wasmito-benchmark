#!/bin/sh
#
# Usage: plot_heap_module.sh [<plot option>...]
#
# Plots the heap that deploying the hooks of each analysis consumes in the
# WARDuino VM (deploy_delta of bench_output/heap_usage/heap.csv) against the
# size of the Wasm module (the .wasm files in bench_input_data/wasmr3_modules),
# on log-log axes, with the tool in src/plot_heap_module.js:
#   - one point per (analysis, module) pair,
#   - per module, the median and the min-max range over the analyses,
#   - a least-squares fit of log10(heap) on log10(module size).
# The subtitle gives Spearman's rho over all pairs and its range per analysis.
#
# Writes to bench_output/plots/heap:
#   heap_vs_module_size.{pdf,png}
#   heap_vs_module_size_correlation.csv  per analysis and over all pairs:
#       spearman_rho     rank correlation of module size and heap
#       pearson_r_log10  linear correlation of log10(size) and log10(heap)
#       loglog_slope     slope of the log-log fit (1 = heap proportional to size)
#
# Any arguments are passed on to the plot tool, e.g.
#   plot_heap_module.sh --analyses icount,branches,taint
#   plot_heap_module.sh --formats pdf
#
# The dependencies of src/ are installed with npm the first time.

set -e
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SRC_DIR=$ROOT_DIR/src
HEAP_CSV=$ROOT_DIR/bench_output/heap_usage/heap.csv
MODULES_DIR=${HEAP_MODULES_DIR:-$ROOT_DIR/bench_input_data/wasmr3_modules}
PLOT_DIR=$ROOT_DIR/bench_output/plots/heap

if [ ! -f "$HEAP_CSV" ]; then
    echo "error: '$HEAP_CSV' does not exist" >&2
    exit 1
fi
if [ ! -d "$MODULES_DIR" ]; then
    echo "error: '$MODULES_DIR' does not exist (run scripts/install_wasmr3.sh first)" >&2
    exit 1
fi

if [ ! -d "$SRC_DIR/node_modules" ]; then
    echo "> Installing the dependencies of src/"
    (cd "$SRC_DIR" && npm install)
fi

node "$SRC_DIR/plot_heap_module.js" "$@" "$HEAP_CSV" "$MODULES_DIR" "$PLOT_DIR"
