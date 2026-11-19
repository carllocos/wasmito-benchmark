#!/bin/sh
#
# Usage: measure_memory_use_wastrumentation.sh [--skip-build] [--instrumented <dir>]
#                                              [--output <csv>]
#                                              [--runs <n>] [--timeout <seconds>]
#                                              [--target x86-64|jvm]
#                                              [--analyses "<a> <b> ..."]
#                                              [--no-baseline]
#
# Measures the memory (maximum resident set size, with /usr/bin/time) that
# the Wizard engine uses to run every Wasm-R3 module
# (bench_input_data/wasmr3_modules/), without instrumentation and once
# instrumented by every Wastrumentation analysis
# (src/measure_memory_use_wastrumentation.js), as measure_memory_use_wei.sh
# does for Whamm's wei monitors.
#
#   1. Instruments the Wasm-R3 modules with every analysis of
#      bench_config/wastrumentation_analyses.csv, each with the stack size
#      that gives the fewest memory pages with which the analysis still works,
#      into bench_output/modules_overhead/wastrumentation_min_pages/ and the
#      stack sizes into bench_output/modules_overhead/wastrumentation_min_pages.csv
#      (src/build_min_pages_wastrumentation_wasmr3.js, which needs the MCU
#      builds of build_mcu_modules_wastrumentation_stack_sizes.sh for the
#      pages per stack size). Skipped with --skip-build, e.g. to use modules
#      built on another machine and copied there.
#   2. Runs src/measure_memory_use_wastrumentation.js on the instrumented
#      modules in --instrumented, with the stack size of every analysis and
#      module from <instrumented>.csv.
#
# Options (--flag value or --flag=value):
#   --skip-build          skip step 1 (use the modules already in --instrumented)
#   --instrumented <dir>  the instrumented modules, one subdirectory per
#                         analysis (default
#                         bench_output/modules_overhead/wastrumentation_min_pages;
#                         with step 1, it must be that default)
#   --output <csv>        Defaults to
#                         bench_output/memory_use/wizard_memory_use_wastrumentation.csv.
#   --runs <n>            runs per module and analysis (default 1)
#   --timeout <seconds>   timeout per run (default 600)
#   --target x86-64|jvm   the Wizard build (default x86-64, with --mode=jit;
#                         jvm only to test on a machine that is not Linux)
#   --analyses "<a> ..."  only these analyses (default: all of them)
#   --no-baseline         skip the runs of Wizard on the original modules
#
# The MCU modules of the concurrency bug evaluation are skipped: they import
# WARDuino's primitives (module env), which Wizard does not provide.
#
# Needs a Linux machine with GNU time (/usr/bin/time) and GNU timeout, and
# everything installed (install_all.sh). Exits non-zero if a step failed.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

usage() {
    echo "Usage: $0 [--skip-build] [--instrumented <dir>] [--output <csv>] [--runs <n>] [--timeout <seconds>] [--target x86-64|jvm] [--analyses \"<a> ...\"] [--no-baseline]" >&2
    exit 1
}

BUILD=1
MODULES="$WASMR3_MODULES_DIR"
INSTRUMENTED="$MODULES_OVERHEAD_DIR/wastrumentation_min_pages"
OUTPUT="$ROOT_DIR/bench_output/memory_use/wizard_memory_use_wastrumentation.csv"
RUNS=1
TIMEOUT=600
TARGET=x86-64
ANALYSES=""
NO_BASELINE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --skip-build) BUILD=0; shift ;;
        --instrumented=*) INSTRUMENTED=${1#*=}; shift ;;
        --instrumented) [ $# -ge 2 ] || usage; INSTRUMENTED=$2; shift 2 ;;
        --no-baseline) NO_BASELINE=--no-baseline; shift ;;
        --output=*) OUTPUT=${1#*=}; shift ;;
        --output) [ $# -ge 2 ] || usage; OUTPUT=$2; shift 2 ;;
        --runs=*) RUNS=${1#*=}; shift ;;
        --runs) [ $# -ge 2 ] || usage; RUNS=$2; shift 2 ;;
        --timeout=*) TIMEOUT=${1#*=}; shift ;;
        --timeout) [ $# -ge 2 ] || usage; TIMEOUT=$2; shift 2 ;;
        --target=*) TARGET=${1#*=}; shift ;;
        --target) [ $# -ge 2 ] || usage; TARGET=$2; shift 2 ;;
        --analyses=*) ANALYSES=${1#*=}; shift ;;
        --analyses) [ $# -ge 2 ] || usage; ANALYSES=$2; shift 2 ;;
        *) echo "Unknown option '$1'" >&2; usage ;;
    esac
done

fail() {
    echo "error: $1" >&2
    exit 1
}

[ -d "$MODULES" ] ||
    fail "modules '$MODULES' do not exist (run scripts/install_wasmr3.sh first)"
if [ "$TARGET" = x86-64 ] && [ "$(uname -s)" != Linux ]; then
    fail "the x86-64 build of Wizard only runs on Linux (use --target jvm to test elsewhere)"
fi

if [ "$BUILD" = 1 ]; then
    [ "$INSTRUMENTED" = "$MODULES_OVERHEAD_DIR/wastrumentation_min_pages" ] ||
        fail "--instrumented can only be changed together with --skip-build"
    echo "> Instrumenting the Wasm-R3 modules with Wastrumentation (fewest memory pages)"
    node "$ROOT_DIR/src/build_min_pages_wastrumentation_wasmr3.js" --timeout "$TIMEOUT" >/dev/null ||
        fail "instrumenting with Wastrumentation failed"
    grep -q ',failed$' "$INSTRUMENTED.csv" &&
        echo "warning: some modules could not be instrumented (they are recorded as missing)" >&2
fi

[ -d "$INSTRUMENTED" ] ||
    fail "instrumented modules '$INSTRUMENTED' do not exist (copy them there or pass --instrumented)"
[ -f "$INSTRUMENTED.csv" ] ||
    echo "warning: '$INSTRUMENTED.csv' does not exist: the stack column stays empty" >&2

echo "> Measuring the memory use of Wizard on the Wasm-R3 modules in $MODULES"
set -- --target "$TARGET" --modules "$MODULES" \
    --instrumented "$INSTRUMENTED" --output "$OUTPUT" \
    --runs "$RUNS" --timeout "$TIMEOUT"
[ -n "$ANALYSES" ] && set -- "$@" --analyses "$ANALYSES"
[ -n "$NO_BASELINE" ] && set -- "$@" "$NO_BASELINE"
exec node "$ROOT_DIR/src/measure_memory_use_wastrumentation.js" "$@"
