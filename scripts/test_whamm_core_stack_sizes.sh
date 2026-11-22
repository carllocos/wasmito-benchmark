#!/bin/sh
#
# Usage: test_whamm_core_stack_sizes.sh [--output <dir>] [--timeout <seconds>]
#
# Tests whether whamm-instrumented modules still work with the whamm_core
# builds of build_whamm_core_stack_sizes.sh: runs every whamm-instrumented
# Wasm-R3 module in bench_output/modules_overhead/whamm (except cache_sim and
# loop_tracer, which need user libraries) on wasmtime, once against every
# whamm_core_<size>.wasm, and compares each run with the run against
# whamm_core_default.wasm.
#
# Every run gets an empty working directory with output/whamm_core/, where
# whamm_core writes its report when the module exits.
#
# Options (--flag value or --flag=value):
#   --output <dir>
#       the directory of build_whamm_core_stack_sizes.sh. Defaults to
#       bench_output/whamm_core_stack/ in the root of wasmito-benchmark.
#   --timeout <seconds>
#       the time limit of a run. Defaults to 120.
#
# Results, in the --output directory:
#   runs.csv  size,analysis,module,exit,stdout_sha,report_sha: the exit
#             status of every run (124 when it timed out) and SHA-1 hashes
#             of its stdout and of its report
#   diff.csv  the runs whose exit status, stdout or report differ from the
#             run of the same module against the default build
# The script exits non-zero when diff.csv has any rows.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

usage() {
    echo "Usage: $0 [--output <dir>] [--timeout <seconds>]" >&2
    exit 1
}

OUT_DIR="$ROOT_DIR/bench_output/whamm_core_stack"
TIMEOUT=120
while [ $# -gt 0 ]; do
    case "$1" in
        --output=*) OUT_DIR=${1#*=}; shift ;;
        --output) [ $# -ge 2 ] || usage; OUT_DIR=$2; shift 2 ;;
        --timeout=*) TIMEOUT=${1#*=}; shift ;;
        --timeout) [ $# -ge 2 ] || usage; TIMEOUT=$2; shift 2 ;;
        *) echo "Unknown option '$1'" >&2; usage ;;
    esac
done

for TOOL in wasmtime timeout shasum; do
    if ! command -v "$TOOL" >/dev/null 2>&1; then
        echo "error: $TOOL not found" >&2
        exit 1
    fi
done
if [ ! -f "$OUT_DIR/whamm_core_default.wasm" ]; then
    echo "error: '$OUT_DIR/whamm_core_default.wasm' not found (run build_whamm_core_stack_sizes.sh first)" >&2
    exit 1
fi

MODULES_DIR="$MODULES_OVERHEAD_DIR/whamm"
RUNS="$OUT_DIR/runs.csv"
DIFF="$OUT_DIR/diff.csv"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "size,analysis,module,exit,stdout_sha,report_sha" > "$RUNS"

for CORE in "$OUT_DIR"/whamm_core_*.wasm; do
    SIZE=$(basename "$CORE" .wasm)
    SIZE=${SIZE#whamm_core_}
    echo "> Running the modules against whamm_core_$SIZE.wasm"
    for MODULE in "$MODULES_DIR"/*/*.wasm; do
        ANALYSIS=$(basename "$(dirname "$MODULE")")
        case "$ANALYSIS" in cache_sim | loop_tracer) continue ;; esac
        NAME=$(basename "$MODULE" .wasm)

        rm -rf "$WORK/run"
        mkdir -p "$WORK/run/output/whamm_core"
        timeout "$TIMEOUT" wasmtime run -W multi-memory=y --dir "$WORK/run::." \
            --preload "whamm_core=$CORE" "$MODULE" \
            >"$WORK/run/stdout" 2>"$WORK/run/stderr"
        EXIT=$?
        STDOUT_SHA=$(shasum < "$WORK/run/stdout" | cut -c1-12)
        REPORT_SHA=$(cat "$WORK/run/output/whamm_core/"* 2>/dev/null | shasum | cut -c1-12)
        echo "$SIZE,$ANALYSIS,$NAME,$EXIT,$STDOUT_SHA,$REPORT_SHA" >> "$RUNS"
        echo "  $ANALYSIS $NAME: exit $EXIT"
    done
done

# Every run that differs from the run of the same module against the
# default build.
awk -F, 'NR == 1 { print; next }
    $1 == "default" { ref[$2 "," $3] = $4 "," $5 "," $6; next }
    { rows[NR] = $0; key[NR] = $2 "," $3; val[NR] = $4 "," $5 "," $6 }
    END { for (i in rows) if (ref[key[i]] != val[i]) print rows[i] }' "$RUNS" > "$DIFF"

DIFFERENT=$(($(wc -l < "$DIFF") - 1))
echo "> $DIFFERENT runs differ from the default build (see $DIFF)"
[ "$DIFFERENT" -eq 0 ]
