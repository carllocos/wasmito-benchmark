#!/bin/sh
#
# Usage: build_portable_modules_whamm.sh [--modules <wasm-module-or-dir>]
#
# Instruments every Wasm module in --modules with every whamm script listed
# in bench_config/whamm_scripts.csv (the same scripts build_monitors_wei.sh
# compiles), by running whamm from its repo with
#   cargo run --release -- instr --app <module> --script <whamm-script> -o <output>
# cache_sim and loop_tracer also get their user library through --user-libs
# (see whamm_user_libs in env.sh), as in build_monitors_wei.sh.
#
# The whamm repo, the modules and the output directory come from env.sh, so
# the script can be run from any directory. A relative --modules path is
# resolved against the current directory.
#
# Options (--flag value or --flag=value):
#   --modules <wasm-module-or-dir>
#       a single .wasm file or a directory of them (non-recursive).
#       Defaults to $WASMR3_MODULES_DIR
#       (bench_input_data/wasmr3_modules/, created by install_wasmr3.sh).
#
# Results are written to $MODULES_OVERHEAD_DIR/whamm
# (bench_output/modules_overhead/whamm/ in the root of wasmito-benchmark), in a
# subdirectory per whamm script, named after its name column:
#   <name>/<module>.wasm  the instrumented module
#   <name>/<module>.log   the output of the cargo run command
#
# whamm is built once in release mode with `cargo build --release` (with
# Rust $WHAMM_RUST_VERSION, as install_whamm.sh does) before the modules are
# instrumented. A failing instrumentation does not stop the rest; at the end,
# every (whamm script, module) that failed is listed and the script exits
# non-zero.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

usage() {
    echo "Usage: $0 [--modules <wasm-module-or-dir>]" >&2
    exit 1
}

MODULES="$WASMR3_MODULES_DIR"
while [ $# -gt 0 ]; do
    case "$1" in
        --modules=*)
            MODULES=${1#*=}
            shift
            ;;
        --modules)
            [ $# -ge 2 ] || usage
            MODULES=$2
            shift 2
            ;;
        *)
            echo "Unknown option '$1'" >&2
            usage
            ;;
    esac
done

# cargo runs from $WHAMM_DIR, so every path passed to it must be absolute.
case "$MODULES" in
    /*) ;;
    *) MODULES="$(pwd)/$MODULES" ;;
esac

if [ -d "$MODULES" ]; then
    FOUND_ANY=0
    for MODULE in "$MODULES"/*.wasm; do
        [ -f "$MODULE" ] && FOUND_ANY=1 && break
    done
    if [ "$FOUND_ANY" -eq 0 ]; then
        echo "No *.wasm files found in directory '$MODULES'" >&2
        exit 1
    fi
elif [ ! -f "$MODULES" ]; then
    echo "error: modules '$MODULES' does not exist (run scripts/install_wasmr3.sh first, or pass --modules)" >&2
    exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
    echo "error: cargo not found (install Rust with rustup)" >&2
    exit 1
fi
if [ ! -f "$WHAMM_DIR/Cargo.toml" ]; then
    echo "error: whamm repo '$WHAMM_DIR' not found (run scripts/install_all.sh first)" >&2
    exit 1
fi

# The toolchain install_whamm.sh installed, without changing the default one.
export RUSTUP_TOOLCHAIN=$WHAMM_RUST_VERSION

echo "> Building whamm"
if ! (cd "$WHAMM_DIR" && cargo build --release); then
    echo "error: building whamm failed" >&2
    exit 1
fi

OUT_BASE="$MODULES_OVERHEAD_DIR/whamm"

STATUS=0
FAILED=""

# Instruments the module $3 with the whamm script $1, named $2.
instrument() {
    OUT_DIR="$OUT_BASE/$2"
    MODULE_NAME=$(basename "$3" .wasm)
    OUTPUT="$OUT_DIR/$MODULE_NAME.wasm"
    LOG="$OUT_DIR/$MODULE_NAME.log"
    LIBS=$(whamm_user_libs "$2")
    STATUS_TMP=$(mktemp)

    echo "=== $2 $(basename "$3") ==="
    # Stream the output to the terminal while also writing it to $LOG. A
    # plain pipe would hide cargo's exit status (no pipefail in POSIX sh),
    # so it is saved via $STATUS_TMP.
    {
        if [ -n "$LIBS" ]; then
            (cd "$WHAMM_DIR" && cargo run --release -- instr --app "$3" --script "$1" --user-libs "$LIBS" -o "$OUTPUT") 2>&1
        else
            (cd "$WHAMM_DIR" && cargo run --release -- instr --app "$3" --script "$1" -o "$OUTPUT") 2>&1
        fi
        echo $? > "$STATUS_TMP"
    } | tee "$LOG"
    RUN_STATUS=$(cat "$STATUS_TMP")
    rm -f "$STATUS_TMP"

    if [ "$RUN_STATUS" -ne 0 ]; then
        echo "whamm instr failed with exit status $RUN_STATUS" >&2
        STATUS=1
        FAILED="$FAILED$2 $(basename "$3")
"
    fi
}

# Instruments every module with the whamm script $1, named $2.
instrument_all_modules() {
    mkdir -p "$OUT_BASE/$2"
    if [ -d "$MODULES" ]; then
        for MODULE in "$MODULES"/*.wasm; do
            [ -f "$MODULE" ] || continue
            instrument "$1" "$2" "$MODULE"
        done
    else
        instrument "$1" "$2" "$MODULES"
    fi
}

for_each_whamm_script instrument_all_modules || exit 1

if [ -n "$FAILED" ]; then
    echo "" >&2
    echo "Instrumentation failed for the following (whamm script, module):" >&2
    printf '%s' "$FAILED" | sed 's/^/  /' >&2
fi

exit "$STATUS"
