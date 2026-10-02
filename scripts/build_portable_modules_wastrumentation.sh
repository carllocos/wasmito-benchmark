#!/bin/sh
#
# Usage: build_portable_modules_wastrumentation.sh
#          --analyses <csv> --modules <wasm-module-or-dir> --output <dir>
#
# Instruments every Wasm module in --modules with every Wastrumentation
# analysis listed in the --analyses CSV, by running
#   wastrumentation-cli --hooks <hooks> --input-program-path <module>
#     --rust-analysis-toml-path <analysis Cargo.toml> --output-path <output>
#
# The wastrumentation repo comes from env.sh, so the script can be run from
# any directory. Relative --analyses, --modules and --output paths are
# resolved against the current directory.
#
# Options (--flag value or --flag=value):
#   --analyses <csv>   (required)
#       the analyses to compile, with header analysis,name,hooks: analysis is
#       the path of the analysis' Cargo.toml relative to the root of
#       wasmito-benchmark, name is the analysis name (the name of its output
#       directory), and hooks is the space-separated list passed to --hooks.
#       E.g. bench_config/wastrumentation_analyses.csv (used by
#       measure_sizes_all.sh): the rules of the Makefile in Wastrumentation's
#       local checkout and the ports of Wasmito's concurrency analyses in
#       wastrumentation-concurrency/.
#   --modules <wasm-module-or-dir>   (required)
#       a single .wasm file or a directory of them (non-recursive), e.g.
#       bench_input_data/wasmr3_modules (created by install_wasmr3.sh).
#   --output <dir>   (required)
#       base directory for the results, e.g. bench_output/modules_overhead
#       (measure_sizes_all.sh).
#
# Results are written to <output>/wastrumentation, in a subdirectory per
# analysis, named after its name column:
#   <name>/<module>.wasm  the instrumented module
#   <name>/<module>.log   the output of wastrumentation-cli
#
# wastrumentation-cli is built once in release mode with
# `cargo build --release` (with the nightly toolchain of the submodule's
# rust-toolchain.toml, installed through rustup if missing) before the
# modules are instrumented. A failing instrumentation does not stop the rest;
# at the end, every (analysis, module) that failed is listed and the script
# exits non-zero.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

usage() {
    echo "Usage: $0 --analyses <csv> --modules <wasm-module-or-dir> --output <dir>" >&2
    exit 1
}

ANALYSES_CSV=""
MODULES=""
OUTPUT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --analyses=*)
            ANALYSES_CSV=${1#*=}
            shift
            ;;
        --modules=*)
            MODULES=${1#*=}
            shift
            ;;
        --output=*)
            OUTPUT=${1#*=}
            shift
            ;;
        --analyses|--modules|--output)
            [ $# -ge 2 ] || usage
            case "$1" in
                --analyses) ANALYSES_CSV=$2 ;;
                --modules) MODULES=$2 ;;
                --output) OUTPUT=$2 ;;
            esac
            shift 2
            ;;
        *)
            echo "Unknown option '$1'" >&2
            usage
            ;;
    esac
done

for REQUIRED in "--analyses:$ANALYSES_CSV" "--modules:$MODULES" "--output:$OUTPUT"; do
    if [ -z "${REQUIRED#*:}" ]; then
        echo "error: ${REQUIRED%%:*} is required" >&2
        usage
    fi
done

# The analyses are compiled from $WASTRUMENTATION_DIR, so every path passed
# to wastrumentation-cli must be absolute.
case "$ANALYSES_CSV" in
    /*) ;;
    *) ANALYSES_CSV="$(pwd)/$ANALYSES_CSV" ;;
esac
case "$MODULES" in
    /*) ;;
    *) MODULES="$(pwd)/$MODULES" ;;
esac
case "$OUTPUT" in
    /*) ;;
    *) OUTPUT="$(pwd)/$OUTPUT" ;;
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
    echo "error: modules '$MODULES' does not exist" >&2
    exit 1
fi

if ! command -v rustup >/dev/null 2>&1; then
    echo "error: rustup not found (install Rust with rustup)" >&2
    exit 1
fi
if [ ! -f "$WASTRUMENTATION_DIR/Cargo.toml" ]; then
    echo "error: wastrumentation repo '$WASTRUMENTATION_DIR' not found (run git submodule update --init wastrumentation)" >&2
    exit 1
fi
if [ ! -f "$ANALYSES_CSV" ]; then
    echo "error: analyses list '$ANALYSES_CSV' does not exist" >&2
    exit 1
fi

echo "> Installing the toolchain of $WASTRUMENTATION_DIR/rust-toolchain.toml"
if ! (cd "$WASTRUMENTATION_DIR" && rustup toolchain install); then
    echo "error: installing the wastrumentation toolchain failed" >&2
    exit 1
fi

echo "> Building wastrumentation-cli"
if ! (cd "$WASTRUMENTATION_DIR" && cargo build --release --bin wastrumentation-cli); then
    echo "error: building wastrumentation-cli failed" >&2
    exit 1
fi
CLI="$WASTRUMENTATION_DIR/target/release/wastrumentation-cli"

OUT_BASE="$OUTPUT/wastrumentation"

STATUS=0
FAILED=""

# Instruments the module $4 with the analysis whose Cargo.toml is $1, named
# $2, with the space-separated hooks $3.
instrument() {
    OUT_DIR="$OUT_BASE/$2"
    MODULE_NAME=$(basename "$4" .wasm)
    OUT_FILE="$OUT_DIR/$MODULE_NAME.wasm"
    LOG="$OUT_DIR/$MODULE_NAME.log"
    STATUS_TMP=$(mktemp)

    echo "=== $2 $(basename "$4") ==="
    # Stream the output to the terminal while also writing it to $LOG. A
    # plain pipe would hide the exit status (no pipefail in POSIX sh), so it
    # is saved via $STATUS_TMP. $3 is left unquoted so that every hook is a
    # separate argument.
    {
        # shellcheck disable=SC2086
        (cd "$WASTRUMENTATION_DIR" && "$CLI" --hooks $3 --input-program-path "$4" --rust-analysis-toml-path "$1" --output-path "$OUT_FILE") 2>&1
        echo $? > "$STATUS_TMP"
    } | tee "$LOG"
    RUN_STATUS=$(cat "$STATUS_TMP")
    rm -f "$STATUS_TMP"

    if [ "$RUN_STATUS" -ne 0 ]; then
        echo "wastrumentation-cli failed with exit status $RUN_STATUS" >&2
        STATUS=1
        FAILED="$FAILED$2 $(basename "$4")
"
    fi
}

# Instruments every module with the analysis $1, named $2, with hooks $3.
instrument_all_modules() {
    mkdir -p "$OUT_BASE/$2"
    if [ -d "$MODULES" ]; then
        for MODULE in "$MODULES"/*.wasm; do
            [ -f "$MODULE" ] || continue
            instrument "$1" "$2" "$3" "$MODULE"
        done
    else
        instrument "$1" "$2" "$3" "$MODULES"
    fi
}

# The rows are read from a temporary file rather than a pipe so that
# instrument_all_modules runs in the current shell and can update STATUS.
ROWS=$(mktemp)
tail -n +2 "$ANALYSES_CSV" | tr -d '\r' > "$ROWS"
while IFS=, read -r ANALYSIS NAME HOOKS || [ -n "$ANALYSIS" ]; do
    [ -n "$ANALYSIS" ] || continue
    instrument_all_modules "$ROOT_DIR/$ANALYSIS" "$NAME" "$HOOKS" < /dev/null
done < "$ROWS"
rm -f "$ROWS"

if [ -n "$FAILED" ]; then
    echo "" >&2
    echo "Instrumentation failed for the following (analysis, module):" >&2
    printf '%s' "$FAILED" | sed 's/^/  /' >&2
fi

exit "$STATUS"
