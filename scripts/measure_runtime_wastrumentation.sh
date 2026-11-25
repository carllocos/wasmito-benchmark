#!/bin/sh
#
# Usage: measure_runtime_wastrumentation.sh [--skip-build] [--instrumented <dir>]
#                                           [--output <dir>] [--runs <n>]
#                                           [--timeout <seconds>]
#                                           [--target x86-64|jvm]
#                                           [--analyses "<a> <b> ..."]
#                                           [--no-baseline]
#
# Benchmarks the execution time of the Wasm-R3 modules
# (bench_input_data/wasmr3_modules/) instrumented by Wastrumentation on the
# optimised Wizard engine (wizeng), like measure_runtime_wei.sh does for
# Whamm's wei monitors: first a baseline run of every original module
# (recorded as "none" in the analysis column), then a run of every module
# instrumented by every Wastrumentation analysis.
#
#   1. Instruments the Wasm-R3 modules with every analysis of
#      bench_config/wastrumentation_analyses.csv, with Wastrumentation's
#      default build, into bench_output/modules_overhead/wastrumentation/
#      (build_portable_modules_wastrumentation.sh). Skipped with --skip-build.
#   2. Runs wizeng on the original and the instrumented modules.
#
# Left out:
#   - the concurrency bug analyses (data_race_violation, order_violation,
#     variable_violation), which target the MCU modules;
#   - the MCU modules of the concurrency bug evaluation (only the modules of
#     bench_input_data/wasmr3_modules/ are run, even if --instrumented also
#     holds instrumented MCU modules): they import WARDuino's primitives,
#     which Wizard does not provide.
#
# wizeng runs with the same optimisations as measure_runtime_wei.sh --mode
# optimise:
#   x86-64: --mode=jit --fast-functions=true and every compiler tuning flag
#           set to true (they only affect Whamm probes, but keep the two
#           runtime experiments on the same engine configuration)
#   jvm:    --fast-functions=true (the jvm build has no JIT), only to test on
#           a machine that is not Linux
#
# Options (--flag value or --flag=value):
#   --skip-build          skip step 1 (use the modules already in --instrumented)
#   --instrumented <dir>  the instrumented modules, one subdirectory per
#                         analysis (<analysis>/<module>.wasm). Defaults to
#                         bench_output/modules_overhead/wastrumentation; with
#                         step 1, it must be that default.
#   --output <dir>        base directory for the results. Defaults to
#                         bench_output/execution_time; the results go to
#                         <dir>/wastrumentation-optimised-<target>.
#   --runs <n>            runs per (module, analysis). Defaults to 35, as
#                         measure_runtime_wei.sh.
#   --timeout <seconds>   timeout per run. Defaults to 600 (10 minutes), as
#                         measure_runtime_wei.sh.
#   --target x86-64|jvm   the wizeng build. Defaults to x86-64.
#   --analyses "<a> ..."  only these analyses (names of the subdirectories of
#                         --instrumented). Defaults to all of them, except the
#                         concurrency bug analyses.
#   --no-baseline         skip the runs of the original modules.
#
# If a run times out or fails (non-zero exit status), the remaining runs of
# that (module, analysis) are skipped and the script continues with the next.
# A module that was not instrumented by an analysis is reported and skipped.
#
# Results, in the format of measure_runtime_wei.sh:
#   <results>/<module>.<analysis>.output  the wizeng output of every run
#   <results>/<module>.<analysis>.all     same, with each run's execution time
#                                         (or timeout/error notice) appended
#   <results>/benchmark.csv               one row per run:
#                                         analysis,wasm_module,time_ms
#                                         ("none" for the baseline; time_ms is
#                                         TIMEOUT or ERROR for a failed run)

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

CONCURRENCY_ANALYSES="data_race_violation order_violation variable_violation"
DEFAULT_INSTRUMENTED="$MODULES_OVERHEAD_DIR/wastrumentation"

BUILD=1
MODULES=$WASMR3_MODULES_DIR
INSTRUMENTED=$DEFAULT_INSTRUMENTED
OUTPUT_BASE=$OUTPUT_DIR
NUM_RUNS=35
TIMEOUT_SECS=600
TARGET=x86-64
ANALYSES=""
NO_BASELINE=""

usage() {
    echo "Usage: $(basename "$0") [--skip-build] [--instrumented <dir>] [--output <dir>] [--runs <n>] [--timeout <seconds>] [--target x86-64|jvm] [--analyses \"<a> ...\"] [--no-baseline]"
}

fail_usage() {
    echo "error: $1" >&2
    usage >&2
    exit 1
}

fail() {
    echo "error: $1" >&2
    exit 1
}

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --skip-build) BUILD=0; shift; continue ;;
        --no-baseline) NO_BASELINE=1; shift; continue ;;
        --*=*) FLAG=${1%%=*}; VALUE=${1#*=}; shift ;;
        --instrumented|--output|--runs|--timeout|--target|--analyses)
            FLAG=$1
            [ $# -ge 2 ] || fail_usage "$FLAG needs a value"
            VALUE=$2
            shift 2
            ;;
        *) fail_usage "unknown argument '$1'" ;;
    esac
    case "$FLAG" in
        --instrumented) INSTRUMENTED=$VALUE ;;
        --output) OUTPUT_BASE=$VALUE ;;
        --runs) NUM_RUNS=$VALUE ;;
        --timeout) TIMEOUT_SECS=$VALUE ;;
        --target) TARGET=$VALUE ;;
        --analyses) ANALYSES=$VALUE ;;
        *) fail_usage "unknown option '$FLAG'" ;;
    esac
done

case "$NUM_RUNS" in ''|*[!0-9]*|0) fail "invalid --runs '$NUM_RUNS': expected a positive integer" ;; esac
case "$TIMEOUT_SECS" in ''|*[!0-9]*|0) fail "invalid --timeout '$TIMEOUT_SECS': expected a positive integer" ;; esac

case "$TARGET" in
    x86-64)
        WIZENG_BIN="wizeng.x86-64-linux"
        OPT_FLAGS="--mode=jit --fast-functions=true"
        for OPT in inline-global-access intrinsify-count-probes intrinsify-operand-probes intrinsify-whamm-probes intrinsify-memory-probes compile-whamm-modules inline-whamm-probes; do
            OPT_FLAGS="$OPT_FLAGS --$OPT=true"
        done
        ;;
    jvm)
        WIZENG_BIN="wizeng.jvm"
        OPT_FLAGS="--fast-functions=true"
        ;;
    *) fail "unknown --target '$TARGET': expected x86-64 or jvm" ;;
esac

if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN=timeout
elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN=gtimeout
else
    fail "'timeout' command not found (install GNU coreutils)"
fi

[ -d "$MODULES" ] ||
    fail "modules '$MODULES' do not exist (run scripts/install_wasmr3.sh first)"

if [ "$BUILD" = 1 ]; then
    [ "$INSTRUMENTED" = "$DEFAULT_INSTRUMENTED" ] ||
        fail "--instrumented can only be changed together with --skip-build"
    echo "> Instrumenting the Wasm-R3 modules with Wastrumentation"
    "$ROOT_DIR/scripts/build_portable_modules_wastrumentation.sh" \
        --analyses "$ROOT_DIR/bench_config/wastrumentation_analyses.csv" \
        --modules "$MODULES" --output "$MODULES_OVERHEAD_DIR" ||
        echo "warning: some modules could not be instrumented (they are skipped)" >&2
fi

[ -d "$INSTRUMENTED" ] ||
    fail "instrumented modules '$INSTRUMENTED' do not exist (run without --skip-build or pass --instrumented)"

# The analyses to run: --analyses, or every subdirectory of --instrumented,
# without the concurrency bug analyses.
if [ -z "$ANALYSES" ]; then
    for DIR in "$INSTRUMENTED"/*/; do
        [ -d "$DIR" ] && ANALYSES="$ANALYSES $(basename "$DIR")"
    done
fi
SELECTED=""
for A in $ANALYSES; do
    case " $CONCURRENCY_ANALYSES " in
        *" $A "*) echo "Skipping the concurrency bug analysis $A" ;;
        *) SELECTED="$SELECTED $A" ;;
    esac
done
[ -n "$SELECTED" ] || fail "no analyses to run in '$INSTRUMENTED'"

OUT_DIR="$OUTPUT_BASE/wastrumentation-optimised-$TARGET"
CSV_FILE="$OUT_DIR/benchmark.csv"
mkdir -p "$OUT_DIR"
[ -f "$CSV_FILE" ] || echo "analysis,wasm_module,time_ms" > "$CSV_FILE"

echo "wizeng optimisation flags: $OPT_FLAGS"
echo "Analyses:$SELECTED"
echo "Results in $OUT_DIR"

now_ms() {
    python3 -c 'import time; print(int(time.time() * 1000))'
}

# Runs the module $1 (recorded as module $2 and analysis $ANALYSIS_TAG)
# $NUM_RUNS times, as run_module of measure_runtime_wei.sh.
run_module() {
    MODULE=$1
    NAME=$2
    OUT_STEM="$(basename "$NAME" .wasm).$ANALYSIS_TAG"
    OUTPUT_FILE="$OUT_DIR/$OUT_STEM.output"
    ALL_FILE="$OUT_DIR/$OUT_STEM.all"
    RUN_TMP=$(mktemp)
    STATUS_TMP=$(mktemp)
    : > "$OUTPUT_FILE"
    : > "$ALL_FILE"

    I=1
    while [ "$I" -le "$NUM_RUNS" ]; do
        RUN_TAG="run $I - $ANALYSIS_TAG $NAME"
        echo "=== $RUN_TAG ==="

        START_MS=$(now_ms)
        # Streams the output while capturing it; the exit status is saved via
        # $STATUS_TMP since POSIX sh has no pipefail.
        {
            "$TIMEOUT_BIN" "$TIMEOUT_SECS" "$WIZENG_BIN" $OPT_FLAGS "$MODULE" 2>&1
            echo $? > "$STATUS_TMP"
        } | tee "$RUN_TMP"
        RUN_STATUS=$(cat "$STATUS_TMP")
        ELAPSED_MS=$(($(now_ms) - START_MS))

        {
            echo "=== $RUN_TAG ==="
            cat "$RUN_TMP"
        } >> "$OUTPUT_FILE"

        if [ "$RUN_STATUS" -eq 124 ]; then
            NOTICE="wizeng execution timed out after ${TIMEOUT_SECS}s"
            TIME_VALUE=TIMEOUT
        elif [ "$RUN_STATUS" -ne 0 ]; then
            NOTICE="wizeng execution failed with exit status $RUN_STATUS"
            TIME_VALUE=ERROR
        else
            NOTICE="wizeng execution time: $ELAPSED_MS ms"
            TIME_VALUE=$ELAPSED_MS
        fi
        echo "$NOTICE"
        {
            echo "=== $RUN_TAG ==="
            cat "$RUN_TMP"
            echo "$NOTICE"
        } >> "$ALL_FILE"
        echo "$ANALYSIS_TAG,$NAME,$TIME_VALUE" >> "$CSV_FILE"

        # A timeout or error skips the remaining runs of this combination.
        [ "$RUN_STATUS" -eq 0 ] || break
        I=$((I + 1))
    done

    rm -f "$RUN_TMP" "$STATUS_TMP"
}

if [ -z "$NO_BASELINE" ]; then
    ANALYSIS_TAG=none
    for MODULE in "$MODULES"/*.wasm; do
        [ -f "$MODULE" ] || continue
        run_module "$MODULE" "$(basename "$MODULE")"
    done
fi

for ANALYSIS_TAG in $SELECTED; do
    for ORIGINAL in "$MODULES"/*.wasm; do
        [ -f "$ORIGINAL" ] || continue
        NAME=$(basename "$ORIGINAL")
        MODULE="$INSTRUMENTED/$ANALYSIS_TAG/$NAME"
        if [ ! -f "$MODULE" ]; then
            echo "warning: no $MODULE (not instrumented), skipped" >&2
            continue
        fi
        run_module "$MODULE" "$NAME"
    done
done
