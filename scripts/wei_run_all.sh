#!/bin/sh
#
# Usage: wei_run_all.sh [--modules <wasm-module-or-dir>] [--output <dir>] [--runs <n>]
#                       [--timeout <seconds>] [--target x86-64|jvm]
#                       [--mode optimise|no-optimise]
#                       [--monitors <dir>] [--no-analysis | --only-analysis]
#
# Benchmarks the --modules with the Wizard engine (wizeng): first a baseline
# run with no monitor attached at all (recorded as "none" in the analysis
# column), then a run with every whamm analysis monitor in --monitors.
# With --no-analysis, only the baseline is run; with --only-analysis, only
# the monitors are.
#
# monitors/cache_sim.wasm and monitors/loop_tracer.wasm depend on user
# libraries (as wei_compile_all.sh compiled them with --user-libs), so the
# matching lib from whamm/tests/libs is appended to wizeng's --monitors
# list after whamm_core.wasm.
#
# --mode toggles every optimisation wizeng exposes.
# Defaults to optimise.
#
#   x86-64, optimise:    --mode=jit (pre-compile everything with the SPC
#                        JIT, falling back to the interpreter), plus
#                        every compiler tuning flag explicitly set to true:
#                          --fast-functions --inline-global-access
#                          --intrinsify-count-probes --intrinsify-operand-probes
#                          --intrinsify-whamm-probes --intrinsify-memory-probes
#                          --compile-whamm-modules --inline-whamm-probes
#   x86-64, no-optimise: --mode=int (fast interpreter only) and every flag
#                        above set to false. --compile-whamm-modules must be
#                        turned off explicitly: it defaults to true and
#                        would otherwise JIT-compile the whamm monitor
#                        modules even in --mode=int.
#   jvm:                 the jvm build has no JIT tiers and does not accept
#                        the compiler tuning flags, so the only toggle is
#                        --fast-functions=true/false; both modes run the
#                        v3 interpreter.
#
# wizeng, whamm_core.wasm, the monitors and the modules all come from
# env.sh, so the script can be run from any directory.
#
# Options (all optional, in any order; --flag value or --flag=value):
#   --modules <wasm-module-or-dir>
#       a single Wasm module or a directory of them (non-recursive).
#       Defaults to $WASMR3_MODULES_DIR (wasmr3_modules/, created by
#       install_wasm-r3.sh).
#   --output <dir>
#       base directory for the results. Defaults to $OUTPUT_DIR
#       (output/execution_time/ in the root of wasmito-benchmark). Results go to the subdirectory
#       <wei|wizeng>-<optimised|not-optimised>-<x86-64|jvm>: wei by default,
#       wizeng with --no-analysis (e.g. wei-optimised-jvm).
#   --runs <n>
#       how many times each (module, analysis) combination is run.
#       Defaults to 35.
#   --timeout <seconds>
#       how long a single run may take before it is killed. Defaults to 600
#       (10 minutes).
#   --target x86-64|jvm
#       which wizeng build to use. Defaults to x86-64.
#   --mode optimise|no-optimise
#       see above. Defaults to optimise.
#   --monitors <dir>
#       a directory of compiled wei monitors (*.wasm, non-recursive).
#       Defaults to $MONITORS_DIR (monitors/, compiled by wei_compile_all.sh).
#       Monitors named cache_sim.wasm or loop_tracer.wasm get their user lib
#       attached, as described above.
#   --no-analysis
#       only run the baseline: wizeng without any monitor. Takes no value
#       and cannot be combined with --monitors or --only-analysis.
#   --only-analysis
#       only run the monitors, skipping the baseline. Takes no value and
#       cannot be combined with --no-analysis.
#
# If a run times out or fails (wizeng exits with a non-zero status), the
# remaining runs for that (module, analysis) combination are skipped, but
# the script continues on to the next module and analysis rather than
# stopping.
#
# Results are named after each Wasm module's basename (e.g. fib.wasm ->
# fib.*), and each run is labelled with the analysis and module it belongs
# to (e.g. "=== run 2 - call_graph factorial.wasm ==="):
#   <results>/fib.<analysis>.output  the wizeng output of every run
#   <results>/fib.<analysis>.all     same, with each run's execution time
#                                    (or timeout/error notice) appended
#   <results>/benchmark.csv          one row per run (all modules and
#                                    analyses): analysis,wasm_module,time_ms
#                                    ("analysis" is "none" for the baseline,
#                                    or the monitor's basename; "time_ms" is
#                                    TIMEOUT or ERROR when the run timed out
#                                    or wizeng exited with a non-zero status)

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

MODULE_ARG=$WASMR3_MODULES_DIR
OUTPUT_BASE=$OUTPUT_DIR
NUM_RUNS=35
TIMEOUT_SECS=600
TARGET=x86-64
OPT_MODE=optimise
NO_ANALYSIS=
ONLY_ANALYSIS=
MONITORS_ARG=

usage() {
    echo "Usage: $(basename "$0") [--modules <wasm-module-or-dir>] [--output <dir>] [--runs <n>] [--timeout <seconds>] [--target x86-64|jvm] [--mode optimise|no-optimise] [--monitors <dir>] [--no-analysis | --only-analysis]"
}

fail_usage() {
    echo "error: $1" >&2
    usage >&2
    exit 1
}

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        --no-analysis)
            NO_ANALYSIS=1
            shift
            continue
            ;;
        --only-analysis)
            ONLY_ANALYSIS=1
            shift
            continue
            ;;
        --*=*)
            FLAG=${1%%=*}
            VALUE=${1#*=}
            shift
            ;;
        --modules|--output|--runs|--timeout|--target|--mode|--monitors)
            FLAG=$1
            [ $# -ge 2 ] || fail_usage "$FLAG needs a value"
            VALUE=$2
            shift 2
            ;;
        --*)
            fail_usage "unknown option '$1'"
            ;;
        *)
            fail_usage "unexpected argument '$1'"
            ;;
    esac
    case "$FLAG" in
        --modules) MODULE_ARG=$VALUE ;;
        --output) OUTPUT_BASE=$VALUE ;;
        --runs) NUM_RUNS=$VALUE ;;
        --timeout) TIMEOUT_SECS=$VALUE ;;
        --target) TARGET=$VALUE ;;
        --mode) OPT_MODE=$VALUE ;;
        --monitors) MONITORS_ARG=$VALUE ;;
        *) fail_usage "unknown option '$FLAG'" ;;
    esac
done

if [ -n "$NO_ANALYSIS" ] && [ -n "$MONITORS_ARG" ]; then
    fail_usage "--monitors and --no-analysis cannot be combined"
fi
if [ -n "$NO_ANALYSIS" ] && [ -n "$ONLY_ANALYSIS" ]; then
    fail_usage "--no-analysis and --only-analysis cannot be combined"
fi
if [ -n "$MONITORS_ARG" ]; then
    MONITORS_DIR=$MONITORS_ARG
fi
if [ -n "$NO_ANALYSIS" ]; then
    RUN_NAME=wizeng
else
    RUN_NAME=wei
fi

CORE=$WHAMM_CORE

# Libs required by specific monitors compiled by wei_compile_all.sh, keyed
# by the monitor's basename (without .wasm).
CACHE_LIB="$WHAMM_DIR/tests/libs/cache/cache.wasm"
LOOP_TRACER_LIB="$WHAMM_DIR/tests/libs/loop_tracer/tracer.wasm"

if [ ! -e "$MODULE_ARG" ]; then
    echo "error: '$MODULE_ARG' does not exist (for wasmr3_modules/, run scripts/install_wasm-r3.sh first)" >&2
    exit 1
fi

case "$TARGET" in
    jvm)
        WIZENG_BIN="wizeng.jvm"
        ;;
    x86-64)
        WIZENG_BIN="wizeng.x86-64-linux"
        ;;
    *)
        echo "Unknown target '$TARGET': expected 'x86-64' or 'jvm'" >&2
        exit 1
        ;;
esac

if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN=timeout
elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN=gtimeout
else
    echo "error: 'timeout' command not found (install GNU coreutils)" >&2
    exit 1
fi

# Compiler tuning flags only exist in the x86-64 build (the jvm build
# rejects them), so they are only passed there.
X86_COMPILER_OPTS="inline-global-access intrinsify-count-probes intrinsify-operand-probes intrinsify-whamm-probes intrinsify-memory-probes compile-whamm-modules inline-whamm-probes"

case "$OPT_MODE" in
    optimise)
        OPT_VALUE=true
        X86_MODE_FLAG="--mode=jit"
        OUT_DIR="$OUTPUT_BASE/$RUN_NAME-optimised-$TARGET"
        ;;
    no-optimise)
        OPT_VALUE=false
        X86_MODE_FLAG="--mode=int"
        OUT_DIR="$OUTPUT_BASE/$RUN_NAME-not-optimised-$TARGET"
        ;;
    *)
        echo "Unknown option '$OPT_MODE': expected 'optimise' or 'no-optimise'" >&2
        exit 1
        ;;
esac

FAST_FUNCTIONS_FLAG="--fast-functions=$OPT_VALUE"
X86_OPT_FLAGS="$X86_MODE_FLAG $FAST_FUNCTIONS_FLAG"
for OPT in $X86_COMPILER_OPTS; do
    X86_OPT_FLAGS="$X86_OPT_FLAGS --$OPT=$OPT_VALUE"
done

if [ "$TARGET" = "x86-64" ]; then
    echo "wizeng optimisation flags ($OPT_MODE): $X86_OPT_FLAGS"
else
    echo "wizeng optimisation flags ($OPT_MODE): --mode=v3-int $FAST_FUNCTIONS_FLAG"
fi

case "$NUM_RUNS" in
    ''|*[!0-9]*)
        echo "Invalid num-runs '$NUM_RUNS': expected a positive integer" >&2
        exit 1
        ;;
esac
if [ "$NUM_RUNS" -lt 1 ]; then
    echo "Invalid num-runs '$NUM_RUNS': expected a positive integer" >&2
    exit 1
fi

case "$TIMEOUT_SECS" in
    ''|*[!0-9]*)
        echo "Invalid timeout-seconds '$TIMEOUT_SECS': expected a positive integer" >&2
        exit 1
        ;;
esac
if [ "$TIMEOUT_SECS" -lt 1 ]; then
    echo "Invalid timeout-seconds '$TIMEOUT_SECS': expected a positive integer" >&2
    exit 1
fi

if [ -z "$NO_ANALYSIS" ]; then
    if [ ! -f "$CORE" ]; then
        echo "error: '$CORE' does not exist (run scripts/install_whamm.sh first)" >&2
        exit 1
    fi

    if [ ! -d "$MONITORS_DIR" ]; then
        echo "error: monitors directory '$MONITORS_DIR' does not exist (run wei_compile_all.sh first)" >&2
        exit 1
    fi
    FOUND_ANY_WHAMM=0
    for WHAMM_CHECK in "$MONITORS_DIR"/*.wasm; do
        [ -f "$WHAMM_CHECK" ] && FOUND_ANY_WHAMM=1 && break
    done
    if [ "$FOUND_ANY_WHAMM" -eq 0 ]; then
        echo "No *.wasm files found in monitors directory '$MONITORS_DIR' (run wei_compile_all.sh first)" >&2
        exit 1
    fi
    if [ -f "$MONITORS_DIR/cache_sim.wasm" ] && [ ! -f "$CACHE_LIB" ]; then
        echo "error: lib '$CACHE_LIB' does not exist (required by $MONITORS_DIR/cache_sim.wasm)" >&2
        exit 1
    fi
    if [ -f "$MONITORS_DIR/loop_tracer.wasm" ] && [ ! -f "$LOOP_TRACER_LIB" ]; then
        echo "error: lib '$LOOP_TRACER_LIB' does not exist (required by $MONITORS_DIR/loop_tracer.wasm)" >&2
        exit 1
    fi
fi

mkdir -p "$OUT_DIR"

run_module() {
    MODULE=$1

    BASENAME=$(basename "$MODULE" .wasm)
    OUT_STEM="$BASENAME.$ANALYSIS_TAG"
    OUTPUT_FILE="$OUT_DIR/$OUT_STEM.output"
    ALL_FILE="$OUT_DIR/$OUT_STEM.all"
    CSV_FILE="$OUT_DIR/benchmark.csv"
    RUN_TMP=$(mktemp)
    STATUS_TMP=$(mktemp)
    : > "$OUTPUT_FILE"
    : > "$ALL_FILE"

    I=1
    while [ "$I" -le "$NUM_RUNS" ]; do
        RUN_TAG="run $I - $ANALYSIS_TAG $(basename "$MODULE")"
        echo "=== $RUN_TAG ==="

        START_MS=$(python3 -c 'import time; print(int(time.time() * 1000))')

        # Stream stdout/stderr to the terminal as the command runs while also
        # capturing it in $RUN_TMP. A plain pipe would hide the command's exit
        # status (no pipefail in POSIX sh), so it is saved via $STATUS_TMP.
        if [ "$TARGET" = "x86-64" ]; then
            if [ -n "$WHAMM_FILE" ]; then
                {
                    "$TIMEOUT_BIN" "$TIMEOUT_SECS" "$WIZENG_BIN" --env=TO_CONSOLE=true --expose=wizeng $X86_OPT_FLAGS --monitors="$WHAMM_FILE+$CORE$LIBS_MONITORS" "$MODULE" 2>&1
                    echo $? > "$STATUS_TMP"
                } | tee "$RUN_TMP"
            else
                {
                    "$TIMEOUT_BIN" "$TIMEOUT_SECS" "$WIZENG_BIN" $X86_OPT_FLAGS "$MODULE" 2>&1
                    echo $? > "$STATUS_TMP"
                } | tee "$RUN_TMP"
            fi
        else
            if [ -n "$WHAMM_FILE" ]; then
                {
                    "$TIMEOUT_BIN" "$TIMEOUT_SECS" "$WIZENG_BIN" --env=TO_CONSOLE=true --expose=wizeng $FAST_FUNCTIONS_FLAG --monitors="$WHAMM_FILE+$CORE$LIBS_MONITORS" "$MODULE" 2>&1
                    echo $? > "$STATUS_TMP"
                } | tee "$RUN_TMP"
            else
                {
                    "$TIMEOUT_BIN" "$TIMEOUT_SECS" "$WIZENG_BIN" --mode=v3-int $FAST_FUNCTIONS_FLAG "$MODULE" 2>&1
                    echo $? > "$STATUS_TMP"
                } | tee "$RUN_TMP"
            fi
        fi
        RUN_STATUS=$(cat "$STATUS_TMP")

        END_MS=$(python3 -c 'import time; print(int(time.time() * 1000))')
        ELAPSED_MS=$((END_MS - START_MS))

        {
            echo "=== $RUN_TAG ==="
            cat "$RUN_TMP"
        } >> "$OUTPUT_FILE"

        if [ "$RUN_STATUS" -eq 124 ]; then
            echo "wizeng execution timed out after ${TIMEOUT_SECS}s" >&2
            {
                echo "=== $RUN_TAG ==="
                cat "$RUN_TMP"
                echo "wizeng execution timed out after ${TIMEOUT_SECS}s"
            } >> "$ALL_FILE"
            TIME_VALUE="TIMEOUT"
        elif [ "$RUN_STATUS" -ne 0 ]; then
            echo "wizeng execution failed with exit status $RUN_STATUS" >&2
            {
                echo "=== $RUN_TAG ==="
                cat "$RUN_TMP"
                echo "wizeng execution failed with exit status $RUN_STATUS"
            } >> "$ALL_FILE"
            TIME_VALUE="ERROR"
        else
            echo "wizeng execution time: $ELAPSED_MS ms"
            {
                echo "=== $RUN_TAG ==="
                cat "$RUN_TMP"
                echo "wizeng execution time: $ELAPSED_MS ms"
            } >> "$ALL_FILE"
            TIME_VALUE="$ELAPSED_MS"
        fi

        if [ ! -f "$CSV_FILE" ]; then
            echo "analysis,wasm_module,time_ms" > "$CSV_FILE"
        fi
        echo "$ANALYSIS_TAG,$(basename "$MODULE"),$TIME_VALUE" >> "$CSV_FILE"

        if [ "$RUN_STATUS" -ne 0 ]; then
            # The run timed out or errored: skip the remaining runs for this
            # (module, analysis) combination, but let the caller continue on
            # to the next module/analysis.
            break
        fi

        I=$((I + 1))
    done

    rm -f "$RUN_TMP" "$STATUS_TMP"
}

run_all_modules() {
    if [ -d "$MODULE_ARG" ]; then
        FOUND_ANY=0
        for MODULE_FILE in "$MODULE_ARG"/*.wasm; do
            [ -f "$MODULE_FILE" ] || continue
            FOUND_ANY=1
            run_module "$MODULE_FILE"
        done
        if [ "$FOUND_ANY" -eq 0 ]; then
            echo "No *.wasm files found in directory '$MODULE_ARG'" >&2
            exit 1
        fi
    else
        run_module "$MODULE_ARG"
    fi
}

if [ -z "$ONLY_ANALYSIS" ]; then
    # Baseline: run wizard without any whamm analysis attached.
    WHAMM_FILE=""
    ANALYSIS_TAG="none"
    LIBS_MONITORS=""
    run_all_modules
fi

if [ -n "$NO_ANALYSIS" ]; then
    exit 0
fi

for WHAMM_FILE in "$MONITORS_DIR"/*.wasm; do
    [ -f "$WHAMM_FILE" ] || continue
    ANALYSIS_TAG=$(basename "$WHAMM_FILE" .wasm)
    case "$ANALYSIS_TAG" in
        cache_sim)
            LIBS_MONITORS="+$CACHE_LIB"
            ;;
        loop_tracer)
            LIBS_MONITORS="+$LOOP_TRACER_LIB"
            ;;
        *)
            LIBS_MONITORS=""
            ;;
    esac
    run_all_modules
done
