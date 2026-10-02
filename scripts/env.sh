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
export WASTRUMENTATION_DIR="$ROOT_DIR/wastrumentation"

# Virgil: compiler scripts (v3c, v3i) and dev tools (aeneas)
export VIRGIL_LOC="$VIRGIL_DIR"
# Wizard: wizeng.x86-64-linux, wizeng.jvm
# Whamm: the whamm binary, and WHAMM_HOME as required by its README
export WHAMM_HOME="$WHAMM_DIR"
export WHAMM_CORE="$WHAMM_DIR/target/wasm32-wasip1/release/whamm_core.wasm"
# Rust toolchain whamm is built with (the dependencies locked in whamm v1.2.1
# need rustc >= 1.94), installed by install_whamm.sh
export WHAMM_RUST_VERSION=1.94.0

# Wasm modules to benchmark, copied by install_wasmr3.sh from the list in
# bench_config/wasmr3_modules_to_keep.txt
export WASMR3_MODULES_DIR="$ROOT_DIR/bench_input_data/wasmr3_modules"
# Wei monitors compiled by build_monitors_wei.sh
export MONITORS_DIR="$ROOT_DIR/wei-monitors"
# Results of the benchmark scripts. measure_runtime_wei.sh uses one subdirectory
# per mode and target:
# bench_output/execution_time/wei-* with monitors, bench_output/execution_time/wizeng-*
# with --no-analysis (e.g. bench_output/execution_time/wei-optimised-jvm), and
# bench_output/execution_time/wasmito for measure_runtime_wasmito.sh
export OUTPUT_DIR="$ROOT_DIR/bench_output/execution_time"
# Wasm modules instrumented by build_portable_modules_whamm.sh, one
# subdirectory per whamm script (e.g.
# bench_output/modules_overhead/whamm/call_graph)
export MODULES_OVERHEAD_DIR="$ROOT_DIR/bench_output/modules_overhead"

# The whamm scripts compiled by build_monitors_wei.sh and
# build_portable_modules_whamm.sh, with header whamm_script,name:
# whamm_script is the path of the script relative to ROOT_DIR, name is the
# analysis name (the name of the compiled monitor, which
# measure_runtime_wei.sh writes in the analysis column of its benchmark.csv)
export WHAMM_SCRIPTS_CSV="$ROOT_DIR/bench_config/whamm_scripts.csv"

# Prints the --user-libs value (<name>=<path>[,...]) that the whamm script
# named $1 (its name in $WHAMM_SCRIPTS_CSV) is compiled with, or nothing if it
# uses no user library.
whamm_user_libs() {
  case "$1" in
    cache_sim) echo "cache=$WHAMM_DIR/tests/libs/cache/cache.wasm" ;;
    loop_tracer) echo "tracer=$WHAMM_DIR/tests/libs/loop_tracer/tracer.wasm" ;;
  esac
}

# Calls `$1 <absolute-path-of-whamm-script> <name>` for every row of
# $WHAMM_SCRIPTS_CSV, in order; blank lines are skipped. The rows are read
# from a temporary file rather than a pipe so that $1 runs in the current
# shell and can update its variables.
for_each_whamm_script() {
  if [ ! -f "$WHAMM_SCRIPTS_CSV" ]; then
    echo "error: whamm scripts list '$WHAMM_SCRIPTS_CSV' does not exist" >&2
    return 1
  fi
  _ROWS=$(mktemp)
  tail -n +2 "$WHAMM_SCRIPTS_CSV" | tr -d '\r' > "$_ROWS"
  while IFS=, read -r _SCRIPT _NAME || [ -n "$_SCRIPT" ]; do
    [ -n "$_SCRIPT" ] || continue
    "$1" "$ROOT_DIR/$_SCRIPT" "$_NAME" < /dev/null
  done < "$_ROWS"
  rm -f "$_ROWS"
}

export PATH="$VIRGIL_DIR/bin:$VIRGIL_DIR/bin/dev:$WIZARD_DIR/bin:$WHAMM_DIR/target/release:$PATH"
