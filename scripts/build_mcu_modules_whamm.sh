#!/bin/sh
#
# Usage: build_mcu_modules_whamm.sh [--output <dir>] [--analyses "<name> ..."]
#          [--script-dir <dir>]
#
# Instruments the MCU modules of the concurrency bug evaluation
# (bench_input_data/mcu_modules/<program>/wasm/*.wasm) with the whamm
# scripts of bench_config/whamm_scripts.csv named in $ANALYSES (call_graph,
# basic_blocks and mem_access), by running whamm from its repo with
#   cargo run --release -- instr --app <module> --script <whamm-script> -o <output>
# as build_portable_modules_whamm.sh does for the Wasm-R3 modules.
#
# Options (--flag value or --flag=value):
#   --output <dir>
#       where to write the results. Defaults to whamm_mcu_modules/ in the
#       root of wasmito-benchmark.
#   --analyses "<name> ..."
#       the whamm scripts to instrument with, separated by spaces.
#       Defaults to "call_graph basic_blocks mem_access".
#   --script-dir <dir>
#       take the script of <name> from <dir>/<name>.mm instead of from
#       bench_config/whamm_scripts.csv, e.g. whamm-concurrency.
#
# Results, in a subdirectory per whamm script named after its name column:
#   <name>/<module>.wasm  the instrumented module
#   <name>/<module>.log   the output of the cargo run command
#
# The instrumented modules import from whamm_core.wasm (except loop_tracer),
# which must be loaded next to them; see build_whamm_core_stack_sizes.sh.
# A failing instrumentation does not stop the rest; at the end, every
# (whamm script, module) that failed is listed and the script exits non-zero.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

# The whamm scripts to instrument with, by their name in whamm_scripts.csv.
ANALYSES="call_graph basic_blocks mem_access"
MCU_MODULES_DIR="$ROOT_DIR/bench_input_data/mcu_modules"

usage() {
    echo "Usage: $0 [--output <dir>] [--analyses \"<name> ...\"] [--script-dir <dir>]" >&2
    exit 1
}

OUT_BASE="$ROOT_DIR/whamm_mcu_modules"
SCRIPT_DIR=""
while [ $# -gt 0 ]; do
    case "$1" in
        --output=*)
            OUT_BASE=${1#*=}
            shift
            ;;
        --output)
            [ $# -ge 2 ] || usage
            OUT_BASE=$2
            shift 2
            ;;
        --analyses=*)
            ANALYSES=${1#*=}
            shift
            ;;
        --analyses)
            [ $# -ge 2 ] || usage
            ANALYSES=$2
            shift 2
            ;;
        --script-dir=*)
            SCRIPT_DIR=${1#*=}
            shift
            ;;
        --script-dir)
            [ $# -ge 2 ] || usage
            SCRIPT_DIR=$2
            shift 2
            ;;
        *)
            echo "Unknown option '$1'" >&2
            usage
            ;;
    esac
done

# cargo runs from $WHAMM_DIR, so every path passed to it must be absolute.
case "$OUT_BASE" in
    /*) ;;
    *) OUT_BASE="$(pwd)/$OUT_BASE" ;;
esac
case "$SCRIPT_DIR" in
    ""|/*) ;;
    *) SCRIPT_DIR="$(pwd)/$SCRIPT_DIR" ;;
esac

if ! command -v cargo >/dev/null 2>&1; then
    echo "error: cargo not found (install Rust with rustup)" >&2
    exit 1
fi
if [ ! -f "$WHAMM_DIR/Cargo.toml" ]; then
    echo "error: whamm repo '$WHAMM_DIR' not found (run scripts/install_all.sh first)" >&2
    exit 1
fi

# The MCU modules; their node_modules hold no modules of ours.
MODULES=$(find "$MCU_MODULES_DIR" -path '*/node_modules' -prune -o \
    -path '*/wasm/*.wasm' -type f -print | sort)
if [ -z "$MODULES" ]; then
    echo "error: no MCU modules found in '$MCU_MODULES_DIR'" >&2
    exit 1
fi

# The toolchain install_whamm.sh installed, without changing the default one.
export RUSTUP_TOOLCHAIN=$WHAMM_RUST_VERSION

echo "> Building whamm"
if ! (cd "$WHAMM_DIR" && cargo build --release); then
    echo "error: building whamm failed" >&2
    exit 1
fi

STATUS=0
FAILED=""

for NAME in $ANALYSES; do
    # The whamm script of $NAME, relative to the root of wasmito-benchmark.
    if [ -n "$SCRIPT_DIR" ]; then
        SCRIPT_PATH="$SCRIPT_DIR/$NAME.mm"
        if [ ! -f "$SCRIPT_PATH" ]; then
            echo "error: '$SCRIPT_PATH' not found" >&2
            STATUS=1
            FAILED="$FAILED$NAME (no $SCRIPT_PATH)
"
            continue
        fi
    else
        SCRIPT=$(awk -F, -v name="$NAME" 'NR > 1 && $2 == name { print $1 }' "$WHAMM_SCRIPTS_CSV")
        SCRIPT_PATH=${SCRIPT:+$ROOT_DIR/$SCRIPT}
    fi
    if [ -z "$SCRIPT_PATH" ]; then
        echo "error: '$NAME' is not in $WHAMM_SCRIPTS_CSV" >&2
        STATUS=1
        FAILED="$FAILED$NAME (not in $WHAMM_SCRIPTS_CSV)
"
        continue
    fi
    mkdir -p "$OUT_BASE/$NAME"
    for MODULE in $MODULES; do
        MODULE_NAME=$(basename "$MODULE" .wasm)
        OUTPUT="$OUT_BASE/$NAME/$MODULE_NAME.wasm"
        LOG="$OUT_BASE/$NAME/$MODULE_NAME.log"
        echo "=== $NAME $MODULE_NAME ==="
        # cache_sim and loop_tracer also need their user library (see
        # whamm_user_libs in env.sh).
        LIBS=$(whamm_user_libs "$NAME")
        if ! (cd "$WHAMM_DIR" && cargo run --release -- instr \
            --app "$MODULE" --script "$SCRIPT_PATH" ${LIBS:+--user-libs "$LIBS"} \
            -o "$OUTPUT") >"$LOG" 2>&1; then
            echo "whamm instr failed, see $LOG" >&2
            STATUS=1
            FAILED="$FAILED$NAME $MODULE_NAME
"
        fi
    done
done

if [ -n "$FAILED" ]; then
    echo "" >&2
    echo "Instrumentation failed for the following (whamm script, module):" >&2
    printf '%s' "$FAILED" | sed 's/^/  /' >&2
fi

exit "$STATUS"
