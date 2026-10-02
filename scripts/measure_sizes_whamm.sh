#!/bin/sh
#
# Usage: measure_sizes_whamm.sh
#
# Measures how much whamm instrumentation grows the benchmark modules:
#   1. build_portable_modules_whamm.sh: the whamm scripts listed in
#      bench_config/whamm_scripts.csv on bench_input_data/wasmr3_modules
#      (results in bench_output/modules_overhead/whamm)
#   2. src/measure_module_sizes.js: the size of every instrumented module
#      compared to the original, in
#      bench_output/modules_overhead/module_sizes_whamm.csv
#      (framework,analysis,module,module_size,instrumented_size,overhead).
#      The CSV is recreated on every run.
#   3. src/aggregate_module_sizes.js: per analysis, the sums of the module
#      sizes and instrumented sizes, aggregate (their ratio) and statistics
#      of the per-module overhead (mean, geometric mean, median, min, max,
#      standard deviation), in
#      bench_output/modules_overhead/aggregated_metrics_whamm.csv
#
# Expects everything to be installed (install_all.sh). The script exits
# non-zero if any step failed.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SCRIPTS_DIR=$ROOT_DIR/scripts
MODULES=$ROOT_DIR/bench_input_data/wasmr3_modules
OVERHEAD_DIR=$ROOT_DIR/bench_output/modules_overhead
SIZES_CSV=$OVERHEAD_DIR/module_sizes_whamm.csv
AGGREGATED_CSV=$OVERHEAD_DIR/aggregated_metrics_whamm.csv

STATUS=0

echo "> Running build_portable_modules_whamm.sh"
if ! "$SCRIPTS_DIR/build_portable_modules_whamm.sh" --modules "$MODULES"; then
    echo "error: build_portable_modules_whamm.sh failed" >&2
    STATUS=1
fi

# measure_module_sizes.js appends to an existing CSV, so start from scratch
# to not keep the rows of a previous run.
rm -f "$SIZES_CSV"
echo "> Measuring the module sizes of whamm"
if [ ! -d "$OVERHEAD_DIR/whamm" ]; then
    echo "error: '$OVERHEAD_DIR/whamm' does not exist" >&2
    STATUS=1
elif ! node "$ROOT_DIR/src/measure_module_sizes.js" \
    "$MODULES" "$OVERHEAD_DIR/whamm" "$SIZES_CSV"; then
    echo "error: measuring the module sizes of whamm failed" >&2
    STATUS=1
fi

echo "> Aggregating the module sizes of whamm"
rm -f "$AGGREGATED_CSV"
if [ ! -f "$SIZES_CSV" ]; then
    echo "error: '$SIZES_CSV' does not exist" >&2
    STATUS=1
elif ! node "$ROOT_DIR/src/aggregate_module_sizes.js" "$SIZES_CSV" "$AGGREGATED_CSV"; then
    echo "error: aggregating the module sizes of whamm failed" >&2
    STATUS=1
fi

exit "$STATUS"
