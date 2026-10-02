#!/bin/sh
#
# Usage: measure_sizes_all.sh
#
# Measures how much instrumentation grows the benchmark modules, for every
# framework (results in bench_output/modules_overhead):
#   1. measure_sizes_whamm.sh: instruments the wasm-r3 modules with whamm,
#      writing module_sizes_whamm.csv and aggregated_metrics_whamm.csv
#   2. measure_sizes_wastrumentation.sh: instruments the wasm-r3 and the MCU
#      modules with Wastrumentation, writing module_sizes_wastrumentation.csv
#      and aggregated_metrics_wastrumentation.csv
#
# Expects everything to be installed (install_all.sh). A failing script does
# not stop the next one; the script exits non-zero if any of them failed.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SCRIPTS_DIR=$ROOT_DIR/scripts

STATUS=0

for FRAMEWORK in whamm wastrumentation; do
    echo "> Running measure_sizes_$FRAMEWORK.sh"
    if ! "$SCRIPTS_DIR/measure_sizes_$FRAMEWORK.sh"; then
        echo "error: measure_sizes_$FRAMEWORK.sh failed" >&2
        STATUS=1
    fi
done

exit "$STATUS"
