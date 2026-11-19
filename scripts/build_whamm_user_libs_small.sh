#!/bin/sh
#
# Usage: build_whamm_user_libs_small.sh [--output <dir>]
#          [--cache-stacks "<size> ..."] [--tracer-heaps "<size> ..."]
#
# Builds the user libraries of the whamm scripts cache_sim and loop_tracer
# (whamm/tests/libs) with a smaller linear memory, as
# build_whamm_core_stack_sizes.sh does for whamm_core:
#   - cache.wasm (Rust) reserves a 1 MiB stack by default (17 pages); it is
#     built with -C link-arg=-zstack-size=<size> (a copy of the crate, as it
#     is not a member of the whamm workspace).
#   - tracer.wasm (Virgil) reserves a fixed heap of 100 MiB by default (1601
#     pages); it is built with -heap-size=<size>, with the command of
#     whamm/tests/libs/loop_tracer/README.md.
#
# Options (--flag value or --flag=value):
#   --output <dir>          Defaults to bench_output/whamm_user_libs/.
#   --cache-stacks "..."    Defaults to "default 16384 4096 1024 256".
#   --tracer-heaps "..."    Defaults to "default 1M 256K 64K 16K".
#
# Results: <output>/cache_<size>.wasm, <output>/tracer_<size>.wasm and
# <output>/pages.csv (library,size,bytes,pages).

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

usage() {
    echo "Usage: $0 [--output <dir>] [--cache-stacks \"<size> ...\"] [--tracer-heaps \"<size> ...\"]" >&2
    exit 1
}

OUT_DIR="$ROOT_DIR/bench_output/whamm_user_libs"
CACHE_STACKS="default 16384 4096 1024 256"
TRACER_HEAPS="default 1M 256K 64K 16K"
while [ $# -gt 0 ]; do
    case "$1" in
        --output=*) OUT_DIR=${1#*=}; shift ;;
        --output) [ $# -ge 2 ] || usage; OUT_DIR=$2; shift 2 ;;
        --cache-stacks=*) CACHE_STACKS=${1#*=}; shift ;;
        --cache-stacks) [ $# -ge 2 ] || usage; CACHE_STACKS=$2; shift 2 ;;
        --tracer-heaps=*) TRACER_HEAPS=${1#*=}; shift ;;
        --tracer-heaps) [ $# -ge 2 ] || usage; TRACER_HEAPS=$2; shift 2 ;;
        *) echo "Unknown option '$1'" >&2; usage ;;
    esac
done
case "$OUT_DIR" in
    /*) ;;
    *) OUT_DIR="$(pwd)/$OUT_DIR" ;;
esac
mkdir -p "$OUT_DIR"

pages() {
    wasm-tools print --skeleton "$1" | grep -E '^\s*\(memory' | head -1 |
        sed -E 's/.*\(;[0-9]+;\) ([0-9]+).*/\1/'
}

STATUS=0
echo "library,size,bytes,pages" >"$OUT_DIR/pages.csv"

# cache.wasm: a copy of the crate outside the whamm workspace.
CRATE="$OUT_DIR/cache_crate"
rm -rf "$CRATE"
mkdir -p "$CRATE"
cp -R "$WHAMM_DIR/tests/libs/cache/Cargo.toml" "$WHAMM_DIR/tests/libs/cache/rust-toolchain.toml" \
    "$WHAMM_DIR/tests/libs/cache/src" "$CRATE/"
printf '\n[workspace]\n' >>"$CRATE/Cargo.toml"
for SIZE in $CACHE_STACKS; do
    FLAGS=""
    [ "$SIZE" = default ] || FLAGS="-C link-arg=-zstack-size=$SIZE"
    echo "> cache.wasm with stack size $SIZE"
    if (cd "$CRATE" && CARGO_TARGET_DIR="$OUT_DIR/cache_target_$SIZE" \
        CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="$FLAGS" \
        cargo build --release --target wasm32-wasip1); then
        cp "$OUT_DIR/cache_target_$SIZE/wasm32-wasip1/release/cache.wasm" "$OUT_DIR/cache_$SIZE.wasm"
        echo "cache,$SIZE,$(wc -c <"$OUT_DIR/cache_$SIZE.wasm" | tr -d ' '),$(pages "$OUT_DIR/cache_$SIZE.wasm")" >>"$OUT_DIR/pages.csv"
    else
        echo "error: building cache.wasm with stack size $SIZE failed" >&2
        STATUS=1
    fi
done

# tracer.wasm
LIB="$WHAMM_DIR/tests/libs/loop_tracer"
for SIZE in $TRACER_HEAPS; do
    OPT=""
    [ "$SIZE" = default ] || OPT="-heap-size=$SIZE"
    echo "> tracer.wasm with heap size $SIZE"
    mkdir -p "$OUT_DIR/tracer_$SIZE"
    # shellcheck disable=SC2086
    if "$VIRGIL_DIR/bin/dev/v3c-wasm-wasi1" $OPT -fun-exprs -simple-bodies \
        -output="$OUT_DIR/tracer_$SIZE" -program-name=tracer \
        "$LIB/LoopTracer.v3" "$LIB"/libs/*.v3 "$VIRGIL_DIR"/lib/util/*.v3 \
        "$WIZARD_DIR/src/util/PrefixTrie.v3" "$WIZARD_DIR/src/util/Palette.v3" \
        "$WIZARD_DIR/src/util/TermColors.v3"; then
        mv "$OUT_DIR/tracer_$SIZE/tracer.wasm" "$OUT_DIR/tracer_$SIZE.wasm"
        rmdir "$OUT_DIR/tracer_$SIZE" 2>/dev/null
        echo "tracer,$SIZE,$(wc -c <"$OUT_DIR/tracer_$SIZE.wasm" | tr -d ' '),$(pages "$OUT_DIR/tracer_$SIZE.wasm")" >>"$OUT_DIR/pages.csv"
    else
        echo "error: building tracer.wasm with heap size $SIZE failed" >&2
        STATUS=1
    fi
done

cat "$OUT_DIR/pages.csv"
exit "$STATUS"
