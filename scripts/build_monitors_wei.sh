#!/bin/sh
#
# Usage: wei_compile_all.sh
#
# Compiles the fixed set of whamm paper-eval analyses (see the list below)
# to wei monitors, writing every compiled .wasm to $MONITORS_DIR.
#
# The whamm binary, the whamm repo and the output directory all come from
# env.sh, so the script can be run from any directory.
#
# A failing compile does not stop the rest; at the end, every script that
# failed to compile is listed and the script exits non-zero.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

SCRIPTS="$WHAMM_DIR/tests/scripts/paper_eval"
LIBS="$WHAMM_DIR/tests/libs"

compile() {
    # $1=whamm-script $2=output-file $3=libs (optional, <name>=<path>[,...])
    if [ -n "$3" ]; then
        whamm instr --script "$1" --wei --user-libs "$3" -o "$2"
    else
        whamm instr --script "$1" --wei -o "$2"
    fi
}

if ! command -v whamm >/dev/null 2>&1; then
    echo "error: whamm not found (run scripts/install_whamm.sh first)" >&2
    exit 1
fi

mkdir -p "$MONITORS_DIR"

STATUS=0
FAILED=""

run() {
    if ! compile "$1" "$2" "$3"; then
        STATUS=1
        FAILED="$FAILED$1
"
    fi
}

run "$SCRIPTS/branches/branches-subset.mm" "$MONITORS_DIR/branches.wasm"
run "$SCRIPTS/ins_count/ins_count-hw.mm" "$MONITORS_DIR/icount.wasm"
run "$SCRIPTS/ins_coverage/coverage.mm" "$MONITORS_DIR/instr_coverage.wasm"
run "$SCRIPTS/hotness/hotness-hw.mm" "$MONITORS_DIR/hotness.wasm"
run "$SCRIPTS/cache_sim/cache_sim-hw.mm" "$MONITORS_DIR/cache_sim.wasm" "cache=$LIBS/cache/cache.wasm"
run "$SCRIPTS/mem_access_tracing/mem_access.mm" "$MONITORS_DIR/mem_access.wasm"
run "$SCRIPTS/loop_tracer/loop_tracer.mm" "$MONITORS_DIR/loop_tracer.wasm" "tracer=$LIBS/loop_tracer/tracer.wasm"
run "$SCRIPTS/basic_block_profiling/basic-blocks.mm" "$MONITORS_DIR/basic_blocks.wasm"
run "$SCRIPTS/call_graph/call_graph.mm" "$MONITORS_DIR/call_graph.wasm"
run "$SCRIPTS/categories/category-hw.mm" "$MONITORS_DIR/imix.wasm"

if [ -n "$FAILED" ]; then
    echo "" >&2
    echo "Compilation failed for the following files:" >&2
    printf '%s' "$FAILED" | sed 's/^/  /' >&2
fi

exit "$STATUS"
