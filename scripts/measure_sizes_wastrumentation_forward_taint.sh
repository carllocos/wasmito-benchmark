#!/bin/sh
#
# Usage: measure_sizes_wastrumentation_forward_taint.sh
#
# Measures the static memory overhead of only the forward and taint analyses
# of Wastrumentation, without rebuilding the other analyses:
#   measure_sizes_wastrumentation.sh --only forward,taint
# The instrumented modules end up in
# bench_output/modules_overhead/wastrumentation/{forward,taint}, and
# module_sizes_wastrumentation.csv and aggregated_metrics_wastrumentation.csv
# are rewritten for every analysis built so far (see
# measure_sizes_wastrumentation.sh).

exec "$(dirname "$0")/measure_sizes_wastrumentation.sh" --only forward,taint
