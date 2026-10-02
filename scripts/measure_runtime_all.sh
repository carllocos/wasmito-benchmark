#!/bin/sh
#
# Usage: measure_runtime_all.sh
#
# Runs the execution-time benchmarks, in this order:
#   1. measure_runtime_wasmito.sh: the Wasmito analyses listed in
#      bench_config/wasmito_runtime_overhead_analyses.txt on
#      bench_input_data/wasmr3_modules (results in
#      bench_output/execution_time/wasmito)
#   2. build_monitors_wei.sh: compiles the whamm monitors used by
#      measure_runtime_wei.sh
#   3. measure_runtime_wei.sh --target x86-64 --mode optimise: the optimised
#      Wizard engine without monitors and with every whamm monitor (results
#      in bench_output/execution_time/wei-optimised-x86-64)
#   4. measure_runtime_wei.sh --target x86-64 --mode no-optimise: the same on
#      the non-optimised Wizard engine (results in
#      bench_output/execution_time/wei-not-optimised-x86-64)
#   5. plot_runtime.sh: plots the results of the steps above (plots in
#      bench_output/plots/runtime)
#
# Expects everything to be installed (install_all.sh). If the monitor
# compilation fails, the whamm runs are skipped. A failing step does not stop
# the next one, and the plots are always attempted (plot_runtime.sh reports
# which results are missing); the script exits non-zero if any step failed.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SCRIPTS_DIR=$ROOT_DIR/scripts

STATUS=0

echo "> Running measure_runtime_wasmito.sh"
if ! "$SCRIPTS_DIR/measure_runtime_wasmito.sh" \
    --modules "$ROOT_DIR/bench_input_data/wasmr3_modules" \
    --output "$ROOT_DIR/bench_output/execution_time/wasmito" \
    --analysis "$ROOT_DIR/bench_config/wasmito_runtime_overhead_analyses.txt"; then
    echo "error: measure_runtime_wasmito.sh failed" >&2
    STATUS=1
fi

echo "> Running build_monitors_wei.sh"
if "$SCRIPTS_DIR/build_monitors_wei.sh"; then
    for MODE in optimise no-optimise; do
        echo "> Running measure_runtime_wei.sh --target x86-64 --mode $MODE"
        if ! "$SCRIPTS_DIR/measure_runtime_wei.sh" --target x86-64 --mode "$MODE"; then
            echo "error: measure_runtime_wei.sh --mode $MODE failed" >&2
            STATUS=1
        fi
    done
else
    echo "error: build_monitors_wei.sh failed, skipping the whamm runs" >&2
    STATUS=1
fi

echo "> Running plot_runtime.sh"
if ! "$SCRIPTS_DIR/plot_runtime.sh"; then
    echo "error: plot_runtime.sh failed" >&2
    STATUS=1
fi

exit "$STATUS"
