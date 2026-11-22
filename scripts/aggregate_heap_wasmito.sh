#!/bin/sh
#
# Usage: aggregate_heap_wasmito.sh [<heap.csv>]
#
# Aggregates the heap that deploying the hooks of each Wasmito analysis
# consumes in the WARDuino VM, in the same format as the module size
# overhead of whamm and Wastrumentation (measure_sizes_whamm.sh,
# measure_sizes_wastrumentation.sh), so the three can be compared:
#   1. per (analysis, Wasm module) of <heap.csv> (default
#      bench_output/heap_usage/heap.csv), the size of the Wasm module and
#      the "instrumented size" module_size + deploy_delta, i.e. the module
#      plus the heap its hooks take, in
#      bench_output/modules_overhead/module_sizes_wasmito.csv
#      (framework,analysis,module,module_size,instrumented_size,overhead,
#      with overhead = instrumented_size / module_size). The module sizes
#      are those of the .wasm files in HEAP_MODULES_DIR (default
#      bench_input_data/wasmr3_modules) or, for modules not found there, of
#      the MCU example programs built by install_wasmito.sh
#      (bench_input_data/mcu_modules/<example>/wasm/*.wasm), e.g. the
#      concurrency bug modules.
#   2. src/aggregate_module_sizes.js: per analysis, the sums of the module
#      sizes and instrumented sizes, aggregate (their ratio) and statistics
#      of the per-module overhead (mean, geometric mean, median, min, max,
#      standard deviation), in
#      bench_output/modules_overhead/aggregated_metrics_wasmito.csv
#   3. a LaTeX table with one column per analysis (names written
#      vertically) and, as rows, the aggregate and the geometric mean,
#      median, min and max of the per-module overhead, in
#      bench_output/modules_overhead/aggregated_metrics_wasmito.tex
#
# Input <heap.csv>:
#   analysis,wasm,heap_used_before_deploy,heap_used_after_deploy,deploy_delta
# with all heap values in bytes.
#
# The no-analysis baseline deploys no hooks, so it is left out. Rows whose
# deploy_delta is not a number, and modules whose .wasm file is missing,
# are skipped with a warning.
#
# Optional environment variables:
#   HEAP_MODULES_DIR  directory with the .wasm files (see above)
#   HEAP_FLOAT        table* (default, full width) or table (single column)
#   HEAP_LABEL        label of the table (default tbl:heap-aggregated-wasmito)
#
# The table requires the graphicx LaTeX package (\rotatebox).

set -e
# Force a "." decimal separator regardless of the user locale.
LC_ALL=C
export LC_ALL
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
IN_CSV=${1:-$ROOT_DIR/bench_output/heap_usage/heap.csv}
MODULES_DIR=${HEAP_MODULES_DIR:-$ROOT_DIR/bench_input_data/wasmr3_modules}
MCU_MODULES_DIR=$ROOT_DIR/bench_input_data/mcu_modules
OVERHEAD_DIR=$ROOT_DIR/bench_output/modules_overhead
SIZES_CSV=$OVERHEAD_DIR/module_sizes_wasmito.csv
AGGREGATED_CSV=$OVERHEAD_DIR/aggregated_metrics_wasmito.csv
OUT_TEX=$OVERHEAD_DIR/aggregated_metrics_wasmito.tex

if [ ! -f "$IN_CSV" ]; then
    echo "error: '$IN_CSV' does not exist" >&2
    exit 1
fi
if [ ! -d "$MODULES_DIR" ]; then
    echo "error: '$MODULES_DIR' does not exist (run scripts/install_wasmr3.sh first)" >&2
    exit 1
fi
mkdir -p "$OVERHEAD_DIR"

# Sizes in bytes of the Wasm modules in the CSV, as "module=bytes,...".
SIZES=""
for WASM in $(awk -F, 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == "wasm") c = i; next }
                       c && NF > 1 { print $c }' "$IN_CSV" | sort -u); do
    FOUND=""
    for CANDIDATE in "$MODULES_DIR/$WASM" "$MCU_MODULES_DIR"/*/wasm/"$WASM"; do
        if [ -f "$CANDIDATE" ]; then
            FOUND=$CANDIDATE
            break
        fi
    done
    if [ -n "$FOUND" ]; then
        SIZES="$SIZES$WASM=$(wc -c < "$FOUND" | tr -d ' '),"
    else
        echo "warning: '$WASM' is neither in '$MODULES_DIR' nor in '$MCU_MODULES_DIR/*/wasm', skipping its rows" >&2
    fi
done

echo "> Writing the per-module heap overhead of Wasmito"
awk -F, -v sizes="$SIZES" '
NR == 1 {
    for (i = 1; i <= NF; i++) col[$i] = i
    if (!("analysis" in col) || !("wasm" in col) || !("deploy_delta" in col)) {
        print "error: heap CSV needs the columns analysis, wasm and deploy_delta" > "/dev/stderr"
        exit 1
    }
    ns = split(sizes, pairs, ",")
    for (k = 1; k <= ns; k++) if (pairs[k] != "") {
        eq = index(pairs[k], "="); size[substr(pairs[k], 1, eq - 1)] = substr(pairs[k], eq + 1)
    }
    print "framework,analysis,module,module_size,instrumented_size,overhead"
    next
}
NF > 1 {
    a = $col["analysis"]; w = $col["wasm"]; d = $col["deploy_delta"]
    if (a == "no-analysis") next
    if (!(w in size)) next
    if (d !~ /^[0-9]+$/) {
        print "warning: line " NR ": deploy_delta \"" d "\" of " a " on " w " is not a number, skipping it" > "/dev/stderr"
        next
    }
    m = w; sub(/\.wasm$/, "", m)
    printf "wasmito,%s,%s,%d,%d,%.17g\n", a, m, size[w], size[w] + d, (size[w] + d) / size[w]
}
' "$IN_CSV" > "$SIZES_CSV"
echo "> Wrote $SIZES_CSV"

echo "> Aggregating the heap overhead of Wasmito"
node "$ROOT_DIR/src/aggregate_module_sizes.js" "$SIZES_CSV" "$AGGREGATED_CSV"

echo "> Writing the LaTeX table"
awk -F, -v float="${HEAP_FLOAT:-table*}" \
    -v label="${HEAP_LABEL:-tbl:heap-aggregated-wasmito}" '
# Overhead ratio, e.g. "8.30": two decimals below 10, one below 100, whole
# above.
function ratio(x) {
    if (x < 10) return sprintf("%.2f", x)
    if (x < 100) return sprintf("%.1f", x)
    return sprintf("%.0f", x)
}
function tex(s) { gsub(/[_&%#$]/, "\\\\&", s); return s }
NR == 1 {
    for (i = 1; i <= NF; i++) col[$i] = i
    next
}
NF > 1 {
    n++
    name[n] = $col["analysis"]
    val["aggregate", n] = $col["aggregate"]
    val["overhead_geomean", n] = $col["overhead_geomean"]
    val["overhead_median", n] = $col["overhead_median"]
    val["overhead_min", n] = $col["overhead_min"]
    val["overhead_max", n] = $col["overhead_max"]
}
END {
    if (n == 0) { print "error: no analyses to put in the table" > "/dev/stderr"; exit 1 }
    # One row per metric: CSV column and row label.
    nm = split("aggregate,overhead_geomean,overhead_median,overhead_min,overhead_max", metric, ",")
    split("Aggregate,Geo.\\ mean,Median,Min,Max", metric_label, ",")
    print "% Generated by scripts/aggregate_heap_wasmito.sh -- do not edit by hand."
    print "% Per Wasmito analysis (columns), the overhead of the heap taken by deploying"
    print "% its hooks in the WARDuino VM: (module size + deploy_delta) / module size."
    print "% Aggregate is the sum over all Wasm modules of module size + deploy_delta"
    print "% divided by the sum of the module sizes; the other rows are statistics of"
    print "% the per-module overhead."
    print "\\begin{" float "}[h]"
    print "  \\centering"
    print "  \\setlength{\\tabcolsep}{3pt}"
    spec = "l"; for (j = 1; j <= n; j++) spec = spec "r"
    print "  \\begin{tabular}{" spec "}"
    print "    \\hline"
    line = "    Metric"
    for (j = 1; j <= n; j++)
        line = line " & \\rotatebox{90}{" tex(name[j]) "\\hspace{3pt}}"  # space above the name
    print line " \\\\"
    print "    \\hline"
    for (i = 1; i <= nm; i++) {
        line = "    " metric_label[i]
        for (j = 1; j <= n; j++) line = line " & " ratio(val[metric[i], j])
        print line " \\\\"
    }
    print "    \\hline"
    print "  \\end{tabular}"
    print "  \\caption{}"
    print "  \\label{" label "}"
    print "\\end{" float "}"
}
' "$AGGREGATED_CSV" > "$OUT_TEX"
echo "> Wrote $OUT_TEX"
