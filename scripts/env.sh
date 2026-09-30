#!/bin/sh

# Environment shared by the install and benchmark scripts.
#
# Source it after setting ROOT_DIR to the root of wasmito-benchmark:
#   ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
#   . "$ROOT_DIR/scripts/env.sh"
#
# All paths are derived from ROOT_DIR, so nothing depends on where the
# repo is cloned.

if [ -z "$ROOT_DIR" ]; then
  echo "env.sh: ROOT_DIR must be set before sourcing" >&2
  exit 1
fi

export WASMITO_DIR="$ROOT_DIR/wasmito"
export VIRGIL_DIR="$ROOT_DIR/virgil"
export WIZARD_DIR="$ROOT_DIR/wizard"
export WHAMM_DIR="$ROOT_DIR/whamm"

# Virgil: compiler scripts (v3c, v3i) and dev tools (aeneas)
export VIRGIL_LOC="$VIRGIL_DIR"
# Wizard: wizeng.x86-64-linux, wizeng.jvm
# Whamm: the whamm binary, and WHAMM_HOME as required by its README
export WHAMM_HOME="$WHAMM_DIR"
export WHAMM_CORE="$WHAMM_DIR/target/wasm32-wasip1/release/whamm_core.wasm"

# Wasm modules to benchmark, copied by install_wasm-r3.sh from the list in
# wasmr3_modules_to_keep.txt
export WASMR3_MODULES_DIR="$ROOT_DIR/wasmr3_modules"
# Wei monitors compiled by wei_compile_all.sh
export MONITORS_DIR="$ROOT_DIR/monitors"
# Results of the benchmark scripts. wei_run_all.sh uses one subdirectory
# per mode and target:
# output/execution_time/wei-* with monitors, output/execution_time/wizeng-*
# with --no-analysis (e.g. output/execution_time/wei-optimised-jvm), and
# output/execution_time/wasmito for wasmito_run_all.sh
export OUTPUT_DIR="$ROOT_DIR/output/execution_time"

export PATH="$VIRGIL_DIR/bin:$VIRGIL_DIR/bin/dev:$WIZARD_DIR/bin:$WHAMM_DIR/target/release:$PATH"
