#!/bin/sh
#
# Usage: all.sh
#
# Installs everything and runs all benchmarks:
#   1. install_all.sh: installs Wasmito, Virgil, Wizard, Whamm and the
#      benchmark modules
#   2. wei_compile_all.sh: compiles the whamm monitors used by wei_run_all.sh
#   3. wei_run_all.sh --target x86-64, once with --mode optimise and once
#      with --mode no-optimise: the Wizard engine without monitors and with
#      every whamm monitor (results in
#      output/execution_time/wei-optimised-x86-64 and
#      output/execution_time/wei-not-optimised-x86-64)
#   4. wasmito_run_all.sh: every Wasmito analysis (results in
#      output/execution_time/wasmito)
#
# If the installation or the monitor compilation fails, nothing is run.
# A failing benchmark script does not stop the next one; the script exits
# non-zero if any of them failed.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SCRIPTS_DIR=$ROOT_DIR/scripts

set -e
echo "> Running install_all.sh"
"$SCRIPTS_DIR/install_all.sh"

echo "> Running wei_compile_all.sh"
"$SCRIPTS_DIR/wei_compile_all.sh"
set +e

STATUS=0

for MODE in optimise no-optimise; do
    echo "> Running wei_run_all.sh --target x86-64 --mode $MODE"
    if ! "$SCRIPTS_DIR/wei_run_all.sh" --target x86-64 --mode "$MODE"; then
        echo "error: wei_run_all.sh --mode $MODE failed" >&2
        STATUS=1
    fi
done

echo "> Running wasmito_run_all.sh"
if ! "$SCRIPTS_DIR/wasmito_run_all.sh"; then
    echo "error: wasmito_run_all.sh failed" >&2
    STATUS=1
fi

exit "$STATUS"
