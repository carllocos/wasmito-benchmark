#!/bin/sh
#
# Usage: build_mcu_modules_wastrumentation_stack_sizes.sh [--output <dir>]
#          [--sizes "<size> ..."] [--analyses <csv>]
#
# Instruments the MCU modules of the concurrency bug evaluation
# (bench_input_data/mcu_modules/<program>/wasm/*.wasm) with every analysis of
# bench_config/wastrumentation_analyses.csv, once per stack size, with
# build_portable_modules_wastrumentation.sh.
#
# Wastrumentation compiles every analysis from Rust, which reserves a 1 MiB
# stack (16 pages of 64 KiB) for Wasm by default, so the linear memory it
# adds for the analysis declares at least 16 pages. Each build passes
#   -C link-arg=-zstack-size=<size>
# to the linker through CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS and
# CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS, which the cargo that
# wastrumentation-cli runs inherits; the size "default" builds without it.
#
# Options (--flag value or --flag=value):
#   --output <dir>
#       where to write the results. Defaults to
#       bench_output/wastrumentation_stack/ in the root of wasmito-benchmark.
#   --sizes "<size> ..."
#       the stack sizes in bytes, separated by spaces.
#       Defaults to "default 65536 16384 8192 4096".
#   --analyses <csv>
#       the analyses, in the format of bench_config/wastrumentation_analyses.csv
#       (the default).
#
# Results: <output>/<size>/wastrumentation/<analysis>/<module>.wasm (and
# .log), as build_portable_modules_wastrumentation.sh writes them.
# A failing build does not stop the rest; the script then exits non-zero.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

usage() {
    echo "Usage: $0 [--output <dir>] [--sizes \"<size> ...\"] [--analyses <csv>]" >&2
    exit 1
}

OUT_DIR="$ROOT_DIR/bench_output/wastrumentation_stack"
SIZES="default 65536 16384 8192 4096"
ANALYSES_CSV="$ROOT_DIR/bench_config/wastrumentation_analyses.csv"
while [ $# -gt 0 ]; do
    case "$1" in
        --output=*) OUT_DIR=${1#*=}; shift ;;
        --output) [ $# -ge 2 ] || usage; OUT_DIR=$2; shift 2 ;;
        --sizes=*) SIZES=${1#*=}; shift ;;
        --sizes) [ $# -ge 2 ] || usage; SIZES=$2; shift 2 ;;
        --analyses=*) ANALYSES_CSV=${1#*=}; shift ;;
        --analyses) [ $# -ge 2 ] || usage; ANALYSES_CSV=$2; shift 2 ;;
        *) echo "Unknown option '$1'" >&2; usage ;;
    esac
done

case "$OUT_DIR" in
    /*) ;;
    *) OUT_DIR="$(pwd)/$OUT_DIR" ;;
esac
case "$ANALYSES_CSV" in
    /*) ;;
    *) ANALYSES_CSV="$(pwd)/$ANALYSES_CSV" ;;
esac

# build_portable_modules_wastrumentation.sh takes a directory of modules
# (non-recursive), so the MCU modules are first copied into one.
MODULES=$(mktemp -d)
trap 'rm -rf "$MODULES"' EXIT
find "$ROOT_DIR/bench_input_data/mcu_modules" -path '*/node_modules' -prune -o \
    -path '*/wasm/*.wasm' -type f -exec cp {} "$MODULES" \;

STATUS=0
for SIZE in $SIZES; do
    if [ "$SIZE" = default ]; then
        FLAGS=""
    else
        FLAGS="-C link-arg=-zstack-size=$SIZE"
    fi
    echo "> Instrumenting the MCU modules with stack size $SIZE"
    if ! CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS="$FLAGS" \
        CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="$FLAGS" \
        "$ROOT_DIR/scripts/build_portable_modules_wastrumentation.sh" \
        --analyses "$ANALYSES_CSV" \
        --modules "$MODULES" --output "$OUT_DIR/$SIZE" >/dev/null; then
        echo "error: instrumenting with stack size $SIZE failed (see the .log files in $OUT_DIR/$SIZE)" >&2
        STATUS=1
    fi
done

exit "$STATUS"
