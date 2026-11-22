#!/bin/sh
#
# Usage: measure_memory_use_wei.sh [--skip-build] [--output <csv>] [--runs <n>]
#                                  [--timeout <seconds>] [--target x86-64|jvm]
#                                  [--analyses "<a> <b> ..."] [--no-baseline]
#
# Measures the memory (maximum resident set size, with /usr/bin/time) that
# the Wizard engine uses to run every Wasm-R3 module
# (bench_input_data/wasmr3_modules/), without monitors and with the
# wei monitor of every Whamm analysis (src/measure_memory_use.js):
#
#   1. Builds the inputs (skipped with --skip-build):
#      - whamm_core.wasm with every stack size, into
#        bench_output/whamm_core_stack/mcu/ (build_whamm_core_stack_sizes.sh)
#      - the user libraries of cache_sim and loop_tracer with every stack (or
#        heap) size, into bench_output/whamm_user_libs/
#        (build_whamm_user_libs_small.sh)
#      - the wei monitors of every Whamm script of bench_config/whamm_scripts.csv
#        and whamm-concurrency/ for the Wasm-R3 modules, into
#        bench_output/modules_overhead/whamm-wei/
#        (build_wei_modules_whamm.sh --wasmr3-only)
#   2. Runs src/measure_memory_use.js on every Wasm-R3 module, which
#      uses, per analysis, the smallest whamm_core.wasm that does not trap.
#
# Options (--flag value or --flag=value):
#   --skip-build          skip step 1 (reuse the built cores, libraries and
#                         monitors)
#   --output <csv>        Defaults to
#                         bench_output/memory_use/wizard_memory_use.csv.
#   --runs <n>            runs per module and analysis (default 1)
#   --timeout <seconds>   timeout per run (default 600)
#   --target x86-64|jvm   the Wizard build (default x86-64, with --mode=jit;
#                         jvm only to test on a machine that is not Linux)
#   --analyses "<a> ..."  only these analyses (default: all of them)
#   --no-baseline         skip the runs of Wizard without monitors
#
# The MCU modules of the concurrency bug evaluation are skipped: they import
# WARDuino's primitives (module env), which Wizard does not provide.
#
# Needs a Linux machine with GNU time (/usr/bin/time) and GNU timeout, and
# everything installed (install_all.sh). Exits non-zero if a step failed.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

usage() {
    echo "Usage: $0 [--skip-build] [--output <csv>] [--runs <n>] [--timeout <seconds>] [--target x86-64|jvm] [--analyses \"<a> ...\"] [--no-baseline]" >&2
    exit 1
}

BUILD=1
MODULES="$WASMR3_MODULES_DIR"
OUTPUT="$ROOT_DIR/bench_output/memory_use/wizard_memory_use.csv"
RUNS=1
TIMEOUT=600
TARGET=x86-64
ANALYSES=""
NO_BASELINE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --skip-build) BUILD=0; shift ;;
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

[ -e "$MODULES" ] ||
    fail "modules '$MODULES' do not exist (run scripts/install_wasmr3.sh first)"
if [ "$TARGET" = x86-64 ] && [ "$(uname -s)" != Linux ]; then
    fail "the x86-64 build of Wizard only runs on Linux (use --target jvm to test elsewhere)"
fi

if [ "$BUILD" = 1 ]; then
    echo "> Building whamm_core.wasm with every stack size"
    "$ROOT_DIR/scripts/build_whamm_core_stack_sizes.sh" \
        --output "$ROOT_DIR/bench_output/whamm_core_stack/mcu" \
        --sizes "default 65536 16384 8192 4096 2048 1024 512 256" >/dev/null ||
        fail "building whamm_core failed"

    echo "> Building the user libraries"
    "$ROOT_DIR/scripts/build_whamm_user_libs_small.sh" >/dev/null ||
        fail "building the user libraries failed"

    echo "> Compiling the wei monitors"
    "$ROOT_DIR/scripts/build_wei_modules_whamm.sh" --wasmr3-only >/dev/null ||
        fail "compiling the wei monitors failed"
fi

echo "> Measuring the memory use of Wizard on the Wasm-R3 modules in $MODULES"
set -- --target "$TARGET" --modules "$MODULES" --output "$OUTPUT" \
    --runs "$RUNS" --timeout "$TIMEOUT"
[ -n "$ANALYSES" ] && set -- "$@" --analyses "$ANALYSES"
[ -n "$NO_BASELINE" ] && set -- "$@" "$NO_BASELINE"
exec node "$ROOT_DIR/src/measure_memory_use.js" "$@"
