#!/bin/sh
#
# Usage: plot_runtime.sh [<plot option>...]
#
# Plots the execution-time results of measure_runtime_all.sh with the plot
# tool in src/ (node src/cli.js plot), comparing Wasmito with whamm on the
# optimised and, if it was measured, the non-optimised Wizard engine:
#   bench_output/execution_time/wasmito/benchmark.csv              (required)
#   bench_output/execution_time/wei-optimised-x86-64/benchmark.csv (required)
#   bench_output/execution_time/wei-not-optimised-x86-64/benchmark.csv
#                                                                 (optional)
# The plots are written to bench_output/plots/runtime: the plots of every
# analysis together in analysis/analysis_{absolute,relative}.{pdf,png,jpg}, and
# one plot per analysis in analysis/analysis_{absolute,relative}/<analysis>.*.
# When the non-optimised Wizard engine was measured, the same plots are also
# written without it (Wasmito + WARDuino vs wei + wizard opt only) to
# bench_output/plots/runtime_wizard_opt.
#
# Any arguments are passed on to the plot command, e.g.
#   plot_runtime.sh --no-spawn --aggregate
# (see node src/cli.js plot --help).
#
# The dependencies of src/ are installed with npm the first time.

set -e
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SRC_DIR=$ROOT_DIR/src
RESULTS_DIR=$ROOT_DIR/bench_output/execution_time
PLOT_DIR=$ROOT_DIR/bench_output/plots/runtime
PLOT_OPT_DIR=$ROOT_DIR/bench_output/plots/runtime_wizard_opt

WASMITO_CSV=$RESULTS_DIR/wasmito/benchmark.csv
WHAMM_CSV=$RESULTS_DIR/wei-not-optimised-x86-64/benchmark.csv
WHAMM_OPT_CSV=$RESULTS_DIR/wei-optimised-x86-64/benchmark.csv

MISSING=0
for CSV in "$WASMITO_CSV" "$WHAMM_OPT_CSV"; do
    if [ ! -f "$CSV" ]; then
        echo "error: '$CSV' does not exist" >&2
        MISSING=1
    fi
done
if [ "$MISSING" -ne 0 ]; then
    echo "error: cannot plot without the results above (run scripts/measure_runtime_all.sh first)" >&2
    exit 1
fi
if [ ! -f "$WHAMM_CSV" ]; then
    echo "warning: '$WHAMM_CSV' does not exist, plotting without the non-optimised Wizard engine" >&2
fi

if [ ! -d "$SRC_DIR/node_modules" ]; then
    echo "> Installing the dependencies of src/"
    (cd "$SRC_DIR" && npm install)
fi

mkdir -p "$PLOT_DIR"
if [ -f "$WHAMM_CSV" ]; then
    node "$SRC_DIR/cli.js" plot "$@" \
        --whamm-optimised "$WHAMM_OPT_CSV" \
        "$WASMITO_CSV" "$WHAMM_CSV" "$PLOT_DIR"
    # The same plots with only Wasmito + WARDuino and wei + wizard opt.
    mkdir -p "$PLOT_OPT_DIR"
    node "$SRC_DIR/cli.js" plot "$@" \
        --whamm-optimised "$WHAMM_OPT_CSV" \
        "$WASMITO_CSV" "$PLOT_OPT_DIR"
else
    node "$SRC_DIR/cli.js" plot "$@" \
        --whamm-optimised "$WHAMM_OPT_CSV" \
        "$WASMITO_CSV" "$PLOT_DIR"
fi
