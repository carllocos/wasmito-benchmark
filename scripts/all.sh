#!/bin/sh
#
# Usage: all.sh
#
# Installs everything and runs all benchmarks:
#   1. install_all.sh: installs Wasmito, Virgil, Wizard, Whamm and the
#      benchmark modules
#   2. measure_runtime_all.sh: the execution-time benchmarks of Wasmito
#      (measure_runtime_wasmito.sh), then of the optimised and the non-optimised
#      Wizard engine with the whamm monitors (build_monitors_wei.sh,
#      measure_runtime_wei.sh), see measure_runtime_all.sh
#   3. measure_sizes_all.sh: instruments the modules with whamm
#      (measure_sizes_whamm.sh) and Wastrumentation
#      (measure_sizes_wastrumentation.sh), see measure_sizes_all.sh
#
# If the installation fails, nothing is run. A failing benchmark script does
# not stop the next one; the script exits non-zero if any of them failed.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SCRIPTS_DIR=$ROOT_DIR/scripts

echo "> Running install_all.sh"
if ! "$SCRIPTS_DIR/install_all.sh"; then
    echo "error: install_all.sh failed" >&2
    exit 1
fi

STATUS=0

echo "> Running measure_runtime_all.sh"
if ! "$SCRIPTS_DIR/measure_runtime_all.sh"; then
    echo "error: measure_runtime_all.sh failed" >&2
    STATUS=1
fi

echo "> Running measure_sizes_all.sh"
if ! "$SCRIPTS_DIR/measure_sizes_all.sh"; then
    echo "error: measure_sizes_all.sh failed" >&2
    STATUS=1
fi

exit "$STATUS"
