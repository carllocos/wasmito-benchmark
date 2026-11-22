#!/bin/sh
#
# Usage: measure_sizes_wastrumentation.sh [--only <name>[,<name>...]]
#
# Measures how much Wastrumentation instrumentation grows the benchmark
# modules:
#   1. collects the wasm-r3 modules (bench_input_data/wasmr3_modules) and the
#      MCU example programs built by install_wasmito.sh
#      (bench_input_data/mcu_modules/<example>/wasm/*.wasm) in
#      bench_output/modules_overhead/wastrumentation_modules
#   2. build_portable_modules_wastrumentation.sh: the Wastrumentation
#      analyses listed in bench_config/wastrumentation_analyses.csv on those
#      modules (results in bench_output/modules_overhead/wastrumentation).
#      These are all the dynamic analyses Wastrumentation supports: the
#      analyses of its benchmark suite (including branches, forward and taint) and the
#      ports of Wasmito's concurrency analyses.
#   3. src/measure_module_sizes.js: the size of every instrumented module
#      compared to the original, in
#      bench_output/modules_overhead/module_sizes_wastrumentation.csv
#      (framework,analysis,module,module_size,instrumented_size,overhead).
#      The CSV is recreated on every run, from every analysis directory in
#      bench_output/modules_overhead/wastrumentation.
#
# Options:
#   --only <name>[,<name>...]
#       only (re)build the analyses with these names (the name column of
#       bench_config/wastrumentation_analyses.csv), e.g. --only branches or
#       --only forward,taint.
#       Steps 3 and 4 still cover every analysis built so far, so the
#       instrumented modules of the other analyses are kept and measured
#       again.
#   4. src/aggregate_module_sizes.js: per analysis, the sums of the module
#      sizes and instrumented sizes, aggregate (their ratio) and statistics
#      of the per-module overhead (mean, geometric mean, median, min, max,
#      standard deviation), in
#      bench_output/modules_overhead/aggregated_metrics_wastrumentation.csv
#
# Expects everything to be installed (install_all.sh). The script exits
# non-zero if any step failed.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SCRIPTS_DIR=$ROOT_DIR/scripts
WASMR3_MODULES=$ROOT_DIR/bench_input_data/wasmr3_modules
MCU_MODULES_DIR=$ROOT_DIR/bench_input_data/mcu_modules
OVERHEAD_DIR=$ROOT_DIR/bench_output/modules_overhead
MODULES=$OVERHEAD_DIR/wastrumentation_modules
SIZES_CSV=$OVERHEAD_DIR/module_sizes_wastrumentation.csv
AGGREGATED_CSV=$OVERHEAD_DIR/aggregated_metrics_wastrumentation.csv
ANALYSES_CSV=$ROOT_DIR/bench_config/wastrumentation_analyses.csv

usage() {
    echo "Usage: $0 [--only <name>[,<name>...]]" >&2
    exit 1
}

ONLY=""
while [ $# -gt 0 ]; do
    case "$1" in
        --only=*)
            ONLY=${1#*=}
            shift
            ;;
        --only)
            [ $# -ge 2 ] || usage
            ONLY=$2
            shift 2
            ;;
        *)
            echo "Unknown option '$1'" >&2
            usage
            ;;
    esac
done

STATUS=0

# With --only, build_portable_modules_wastrumentation.sh gets a copy of the
# analyses list that keeps only the selected rows.
BUILD_CSV=$ANALYSES_CSV
if [ -n "$ONLY" ]; then
    BUILD_CSV=$(mktemp)
    trap 'rm -f "$BUILD_CSV"' EXIT
    if ! awk -F, -v only="$ONLY" '
        BEGIN { n = split(only, names, ","); for (i = 1; i <= n; i++) want[names[i]] = 1 }
        NR == 1 { print; next }
        ($2 in want) { print; found[$2] = 1 }
        END {
            for (name in want) if (!(name in found)) {
                print "error: analysis \"" name "\" is not in " FILENAME > "/dev/stderr"
                bad = 1
            }
            exit bad
        }' "$ANALYSES_CSV" > "$BUILD_CSV"; then
        exit 1
    fi
fi

# Wastrumentation instruments the wasm-r3 and the MCU modules in a single
# run, so they are collected in one directory. Their names must differ, as
# the instrumented modules of both end up in the same directories.
echo "> Collecting the wasm-r3 and MCU modules in $MODULES"
rm -rf "$MODULES"
mkdir -p "$MODULES"
for WASM in "$WASMR3_MODULES"/*.wasm "$MCU_MODULES_DIR"/*/wasm/*.wasm; do
    [ -f "$WASM" ] || continue
    if [ -e "$MODULES/$(basename "$WASM")" ]; then
        echo "error: more than one module named $(basename "$WASM"); skipping '$WASM'" >&2
        STATUS=1
        continue
    fi
    cp "$WASM" "$MODULES/"
done
if ! ls "$MCU_MODULES_DIR"/*/wasm/*.wasm >/dev/null 2>&1; then
    echo "error: no MCU modules found in $MCU_MODULES_DIR/*/wasm (run scripts/install_wasmito.sh first)" >&2
    STATUS=1
fi

echo "> Running build_portable_modules_wastrumentation.sh"
if ! "$SCRIPTS_DIR/build_portable_modules_wastrumentation.sh" \
    --analyses "$BUILD_CSV" \
    --modules "$MODULES" \
    --output "$OVERHEAD_DIR"; then
    echo "error: build_portable_modules_wastrumentation.sh failed" >&2
    STATUS=1
fi

# measure_module_sizes.js appends to an existing CSV, so start from scratch
# to not keep the rows of a previous run.
rm -f "$SIZES_CSV"
echo "> Measuring the module sizes of wastrumentation"
if [ ! -d "$OVERHEAD_DIR/wastrumentation" ]; then
    echo "error: '$OVERHEAD_DIR/wastrumentation' does not exist" >&2
    STATUS=1
elif ! node "$ROOT_DIR/src/measure_module_sizes.js" \
    "$MODULES" "$OVERHEAD_DIR/wastrumentation" "$SIZES_CSV"; then
    echo "error: measuring the module sizes of wastrumentation failed" >&2
    STATUS=1
fi

echo "> Aggregating the module sizes of wastrumentation"
rm -f "$AGGREGATED_CSV"
if [ ! -f "$SIZES_CSV" ]; then
    echo "error: '$SIZES_CSV' does not exist" >&2
    STATUS=1
elif ! node "$ROOT_DIR/src/aggregate_module_sizes.js" "$SIZES_CSV" "$AGGREGATED_CSV"; then
    echo "error: aggregating the module sizes of wastrumentation failed" >&2
    STATUS=1
fi

exit "$STATUS"
