#!/bin/sh
#
# Usage: latex_heap_overhead_selected.sh [<heap.csv> [<output.tex>]]
#
# Writes a LaTeX table with, for only the interesting analyses and Wasm
# modules, the heap consumed by deploying the hooks (deploy_delta) and below
# it how many times that is the size of the Wasm module (default output
# bench_output/heap_usage/heap_selection.tex). See
# latex_heap_table.sh for the layout and the HEAP_* variables.
#
# Analyses: analyses whose hooks cost the same heap as another one on every
# module are left out (imix and hotness = icount, mem_access = cache_sim,
# variable-violation = order-violation), as are the ones close to another
# (basic-block, loop_tracer ~ branches; instr-coverage, instruction-mix ~
# icount). What is left goes from the lightest to the heaviest analysis:
#   call-graph, branches, data-race-violation, cache_sim,
#   safe-heap, cryptomining, icount, denan
# taint is deliberately left out of the selection.
#
# Modules, ordered by the heap the hooks cost: the cheapest and most
# expensive (game-of-life, ffmpeg), a few in between (factorial, fib,
# jqkungfu, parquet), rtexviewer (largest heap before the deploy, yet a
# moderate cost) and sandspiel (small module where cache_sim,
# data-race-violation and safe-heap cost unusually much). fib stands for
# multiplyDouble and multiplyInt, which cost the same.
#
# It is an upright full-width table* (about 470pt wide at normal font size,
# too wide for one column of a two-column paper).

set -e
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
IN_CSV=${1:-$ROOT_DIR/bench_output/heap_usage/heap.csv}
OUT_TEX=${2:-$ROOT_DIR/bench_output/heap_usage/heap_selection.tex}

HEAP_VALUES=both \
HEAP_ANALYSES=call-graph,branches,data-race-violation,cache_sim,safe-heap,cryptomining,icount,denan \
HEAP_MODULES=game-of-life.wasm,factorial.wasm,fib.wasm,rtexviewer.wasm,jqkungfu.wasm,sandspiel.wasm,parquet.wasm,ffmpeg.wasm \
HEAP_FLOAT=${HEAP_FLOAT:-table*} \
HEAP_ROTATE=${HEAP_ROTATE:-0} \
HEAP_LABEL=${HEAP_LABEL:-tbl:heap-selection} \
    "$ROOT_DIR/scripts/latex_heap_table.sh" "$IN_CSV" "$OUT_TEX"
