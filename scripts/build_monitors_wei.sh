#!/bin/sh
#
# Usage: build_monitors_wei.sh
#
# Compiles every whamm script listed in bench_config/whamm_scripts.csv to a
# wei monitor, writing it to $MONITORS_DIR/<name>.wasm, where <name> is the
# script's name column. Add a row to bench_config/whamm_scripts.csv to compile
# another script. cache_sim and loop_tracer are compiled with their user
# library (see whamm_user_libs in env.sh).
#
# The whamm binary, the whamm repo and the output directory all come from
# env.sh, so the script can be run from any directory.
#
# A failing compile does not stop the rest; at the end, every script that
# failed to compile is listed and the script exits non-zero.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

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
    # $1=whamm-script $2=name
    if ! compile "$1" "$MONITORS_DIR/$2.wasm" "$(whamm_user_libs "$2")"; then
        STATUS=1
        FAILED="$FAILED$1
"
    fi
}

for_each_whamm_script run || exit 1

if [ -n "$FAILED" ]; then
    echo "" >&2
    echo "Compilation failed for the following files:" >&2
    printf '%s' "$FAILED" | sed 's/^/  /' >&2
fi

exit "$STATUS"
