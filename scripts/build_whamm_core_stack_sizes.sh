#!/bin/sh
#
# Usage: build_whamm_core_stack_sizes.sh [--output <dir>] [--sizes "<size> ..."]
#
# Builds whamm_core.wasm, the core library that whamm-instrumented modules
# import from, with different stack sizes, to see how small its linear
# memory can be made.
#
# Rust reserves a 1 MiB stack (16 pages of 64 KiB) for Wasm by default, so
# the default whamm_core.wasm declares 17 pages. Each build passes
#   -C link-arg=-zstack-size=<size>
# to the linker instead; the size "default" builds without it, for
# comparison. Every build has its own cargo target directory, so the
# whamm_core.wasm that whamm embeds (whamm/embedded/) is left untouched.
#
# Options (--flag value or --flag=value):
#   --output <dir>
#       where to write the results. Defaults to
#       bench_output/whamm_core_stack/ in the root of wasmito-benchmark.
#   --sizes "<size> ..."
#       the stack sizes in bytes, separated by spaces.
#       Defaults to "default 65536 16384 8192 4096".
#
# Results:
#   whamm_core_<size>.wasm  the library built with that stack size
#   pages.csv               size,bytes,pages: the size of every build and the
#                           pages its linear memory declares
#
# Test the builds with test_whamm_core_stack_sizes.sh.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

usage() {
    echo "Usage: $0 [--output <dir>] [--sizes \"<size> ...\"]" >&2
    exit 1
}

OUT_DIR="$ROOT_DIR/bench_output/whamm_core_stack"
SIZES="default 65536 16384 8192 4096"
while [ $# -gt 0 ]; do
    case "$1" in
        --output=*) OUT_DIR=${1#*=}; shift ;;
        --output) [ $# -ge 2 ] || usage; OUT_DIR=$2; shift 2 ;;
        --sizes=*) SIZES=${1#*=}; shift ;;
        --sizes) [ $# -ge 2 ] || usage; SIZES=$2; shift 2 ;;
        *) echo "Unknown option '$1'" >&2; usage ;;
    esac
done

case "$OUT_DIR" in
    /*) ;;
    *) OUT_DIR="$(pwd)/$OUT_DIR" ;;
esac

for TOOL in cargo wasm-tools; do
    if ! command -v "$TOOL" >/dev/null 2>&1; then
        echo "error: $TOOL not found" >&2
        exit 1
    fi
done
if [ ! -f "$WHAMM_DIR/Cargo.toml" ]; then
    echo "error: whamm repo '$WHAMM_DIR' not found (run scripts/install_all.sh first)" >&2
    exit 1
fi

# The toolchain install_whamm.sh installed (with the wasm32-wasip1 target).
export RUSTUP_TOOLCHAIN=$WHAMM_RUST_VERSION

mkdir -p "$OUT_DIR"
echo "size,bytes,pages" > "$OUT_DIR/pages.csv"
STATUS=0

for SIZE in $SIZES; do
    if [ "$SIZE" = default ]; then
        FLAGS=""
    else
        FLAGS="-C link-arg=-zstack-size=$SIZE"
    fi
    TARGET_DIR="$OUT_DIR/target_$SIZE"
    OUTPUT="$OUT_DIR/whamm_core_$SIZE.wasm"

    echo "> Building whamm_core with stack size $SIZE"
    if ! (cd "$WHAMM_DIR" && CARGO_TARGET_DIR="$TARGET_DIR" \
        CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="$FLAGS" \
        cargo build -p whamm_core --target wasm32-wasip1 --release); then
        echo "error: building whamm_core with stack size $SIZE failed" >&2
        STATUS=1
        continue
    fi
    cp "$TARGET_DIR/wasm32-wasip1/release/whamm_core.wasm" "$OUTPUT"

    BYTES=$(wc -c < "$OUTPUT" | tr -d ' ')
    PAGES=$(wasm-tools print --skeleton "$OUTPUT" |
        sed -nE 's/^[[:space:]]*\(memory( \$[^ ]+)? \(;[0-9]+;\) ([0-9]+).*/\2/p' | head -n 1)
    echo "$SIZE,$BYTES,$PAGES" >> "$OUT_DIR/pages.csv"
    echo "  $OUTPUT: $BYTES bytes, $PAGES pages"
done

exit "$STATUS"
