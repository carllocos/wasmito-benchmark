#!/bin/sh
#
# Usage: latex_heap_table.sh <heap.csv> <output.tex>
#
# Helper of latex_heap_overhead_per_module.sh and
# latex_heap_overhead_selected.sh: writes a LaTeX table with, for every
# (analysis, Wasm module) pair in the WARDuino VM, how many times the heap
# consumed by deploying the hooks (deploy_delta) is larger than the Wasm
# module (e.g. "8.3x": the hooks took 8.3 times the module size).
#
# Input <heap.csv>:
#   analysis,wasm,heap_used_before_deploy,heap_used_after_deploy,deploy_delta
# with all heap values in bytes.
#
# Output <output.tex>: a full-width table (table*), one row per analysis and
# one column per Wasm module (header written vertically). The table is
# turned 90 degrees on a page of its own (HEAP_ROTATE=1, the default),
# since it is wider than the text but not than the text height. Below the
# table is an empty \caption{} with the label HEAP_LABEL; when rotated, the
# caption is turned with the table. The first row gives the size of each
# .wasm file (read from HEAP_MODULES_DIR, default
# bench_input_data/wasmr3_modules; "--" if the file is missing). A missing
# (analysis, module) pair is shown as "--".
#
# Ratios are rounded to two decimals below 1, one decimal below 10, whole
# above. Heap values are in HEAP_UNIT (B, KB or MB; 1 KB = 1000 B,
# 1 MB = 1000 KB), rounded to whole units, or to one decimal below 10, with
# the unit written next to them (e.g. "846 KB"). With the default, KB,
# values of 1 MB or more are given in MB instead (one decimal below 100 MB,
# whole MB above), e.g. "8.8 MB".
#
# Optional environment variables:
#   HEAP_VALUES    overhead (default) prints only the ratio; both prints
#                  deploy_delta with the ratio below it (e.g. "846 KB" over
#                  "2.2x") and adds a "Before deploy" row with the heap
#                  already in use before the deploy
#   HEAP_ANALYSES  comma-separated analyses to show, in that order (ones
#                  missing from the CSV are skipped with a warning)
#   HEAP_MODULES   comma-separated Wasm modules to show, in that order (ones
#                  missing from the CSV are skipped with a warning)
#   HEAP_FLOAT     table* (default, full width) or table (single column)
#   HEAP_ROTATE    1 (default) turns the table 90 degrees, on a float page
#                  of its own ([p]); 0 keeps it upright ([h])
#   HEAP_LABEL     label of the table (default tbl:heap-overhead)
#
# Requires the graphicx LaTeX package (\rotatebox).

set -e
# Force a "." decimal separator regardless of the user locale.
LC_ALL=C
export LC_ALL
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
if [ $# -ne 2 ]; then
    echo "usage: $0 <heap.csv> <output.tex>" >&2
    exit 1
fi
IN_CSV=$1
OUT_TEX=$2
UNIT=${HEAP_UNIT:-KB}
VALUES=${HEAP_VALUES:-overhead}
case "$VALUES" in
    overhead|both) ;;
    *) echo "error: HEAP_VALUES must be overhead or both" >&2; exit 1 ;;
esac
case "$UNIT" in
    B) DIV=1 ;;
    KB) DIV=1000 ;;
    MB) DIV=1000000 ;;
    *) echo "error: HEAP_UNIT must be B, KB or MB" >&2; exit 1 ;;
esac

if [ ! -f "$IN_CSV" ]; then
    echo "error: '$IN_CSV' does not exist" >&2
    exit 1
fi
mkdir -p "$(dirname "$OUT_TEX")"

# Sizes in bytes of the Wasm modules in the CSV, as "module=bytes,...".
MODULES_DIR=${HEAP_MODULES_DIR:-$ROOT_DIR/bench_input_data/wasmr3_modules}
SIZES=""
for WASM in $(awk -F, 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == "wasm") c = i; next }
                       c && NF > 1 { print $c }' "$IN_CSV" | sort -u); do
    if [ -f "$MODULES_DIR/$WASM" ]; then
        SIZES="$SIZES$WASM=$(wc -c < "$MODULES_DIR/$WASM" | tr -d ' '),"
    else
        echo "warning: '$MODULES_DIR/$WASM' does not exist, its size is shown as --" >&2
    fi
done

awk -F, -v div="$DIV" -v unit="$UNIT" -v sizes="$SIZES" \
    -v sel_a="${HEAP_ANALYSES:-}" -v sel_m="${HEAP_MODULES:-}" \
    -v float="${HEAP_FLOAT:-table*}" -v rotate="${HEAP_ROTATE:-1}" \
    -v label="${HEAP_LABEL:-tbl:heap-overhead}" -v values="$VALUES" '
# Overhead ratio, e.g. "8.3$\times$".
function ratio(x) {
    return ((x < 1) ? sprintf("%.2f", x) : num(x, 10)) "$\\times$"
}
# Scale bytes to the unit and write the unit next to the number. In KB,
# values of 1 MB or more are given in MB.
function fmt(x) {
    x += 0  # compare as a number (sizes arrive as strings)
    if (unit == "KB" && x >= 1000000) return num(x / 1000000, 100) "\\,MB"
    return num(x / div, 10) "\\," unit
}
# Round to one decimal below `dec`, to whole units otherwise, and group
# thousands with a thin space.
function num(x, dec,    s, int_part, frac, out) {
    s = (x < dec) ? sprintf("%.1f", x) : sprintf("%.0f", x)
    int_part = s; frac = ""
    if (index(s, ".")) { int_part = substr(s, 1, index(s, ".") - 1); frac = substr(s, index(s, ".")) }
    out = ""
    while (length(int_part) > 3) {
        out = "\\," substr(int_part, length(int_part) - 2) out
        int_part = substr(int_part, 1, length(int_part) - 3)
    }
    return int_part out frac
}
function tex(s) { gsub(/[_&%#$]/, "\\\\&", s); return s }
NR == 1 {
    for (i = 1; i <= NF; i++) col[$i] = i
    if (!("analysis" in col) || !("wasm" in col) || !("deploy_delta" in col) ||
        !("heap_used_before_deploy" in col)) {
        print "error: heap CSV needs the columns analysis, wasm, heap_used_before_deploy and deploy_delta" > "/dev/stderr"
        exit 1
    }
    next
}
NF > 1 {
    a = $col["analysis"]; w = $col["wasm"]
    if (!(a in seen_a)) { seen_a[a] = 1; analyses[++na] = a }
    if (!(w in seen_w)) { seen_w[w] = 1; modules[++nw] = w; before[w] = $col["heap_used_before_deploy"] }
    delta[a, w] = $col["deploy_delta"] + 0
}
END {
    if (na == 0) { print "error: no data rows" > "/dev/stderr"; exit 1 }
    # Restrict to (and reorder by) the selected analyses / modules. Selected
    # analyses or modules missing from the CSV are skipped with a warning.
    if (sel_a != "") {
        ns_a = split(sel_a, sel, ",")
        na = 0; delete analyses
        for (i = 1; i <= ns_a; i++) {
            if (sel[i] in seen_a) analyses[++na] = sel[i]
            else print "warning: analysis \"" sel[i] "\" is not in the CSV, skipping it" > "/dev/stderr"
        }
        if (na == 0) { print "error: none of the selected analyses are in the CSV" > "/dev/stderr"; exit 1 }
    }
    if (sel_m != "") {
        ns_m = split(sel_m, sel, ",")
        nw = 0; delete modules
        for (j = 1; j <= ns_m; j++) {
            if (sel[j] in seen_w) modules[++nw] = sel[j]
            else print "warning: Wasm module \"" sel[j] "\" is not in the CSV, skipping it" > "/dev/stderr"
        }
        if (nw == 0) { print "error: none of the selected Wasm modules are in the CSV" > "/dev/stderr"; exit 1 }
    }
    overhead = (values == "overhead")
    spec = "l"; for (j = 1; j <= nw; j++) spec = spec "r"
    print "% Generated by scripts/latex_heap_table.sh -- do not edit by hand."
    if (overhead) {
        print "% Heap consumed by deploying the hooks (deploy_delta) divided by the size of"
        print "% the Wasm module, per analysis and Wasm module. The first row gives the size"
        print "% of each Wasm module."
    } else {
        print "% Heap consumed by deploying the hooks (deploy_delta) per analysis and Wasm"
        print "% module, with below it how many times that is the size of the Wasm module."
        print "% The first two rows give the size of each Wasm module and the heap already"
        print "% in use before the deploy."
    }
    if (unit == "KB")
        print "% Values are in KB or MB, as written next to each value (1 MB = 1000 KB)."
    else
        print "% Values are in " unit ", as written next to each value."
    rotate = (rotate == "1")
    print "\\begin{" float "}[" (rotate ? "p" : "h") "]"
    print "  \\centering"
    # Rotated: the table and its caption go in a box as wide as the text is
    # high, turned 90 degrees, like a landscape page.
    if (rotate) {
        print "  \\rotatebox{90}{\\begin{minipage}{\\textheight}"
        print "  \\centering"
    }
    print "  \\begin{tabular}{" spec "}"
    print "    \\hline"
    line = "    Analysis"
    for (j = 1; j <= nw; j++) {
        m = modules[j]; sub(/\.wasm$/, "", m)
        line = line " & \\rotatebox{90}{" tex(m) "\\hspace{3pt}}"  # space above the name
    }
    print line " \\\\"
    print "    \\hline"
    ns = split(sizes, pairs, ",")
    for (k = 1; k <= ns; k++) if (pairs[k] != "") {
        eq = index(pairs[k], "="); size[substr(pairs[k], 1, eq - 1)] = substr(pairs[k], eq + 1)
    }
    line = "    Module size"
    for (j = 1; j <= nw; j++)
        line = line " & " ((modules[j] in size) ? fmt(size[modules[j]]) : "--")
    print line " \\\\"
    if (!overhead) {
        line = "    Before deploy"
        for (j = 1; j <= nw; j++) line = line " & " fmt(before[modules[j]])
        print line " \\\\"
    }
    print "    \\hline"
    for (i = 1; i <= na; i++) {
        a = analyses[i]; line = "    " tex(a)
        for (j = 1; j <= nw; j++) {
            m = modules[j]
            if (!((a, m) in delta)) { line = line " & --"; continue }
            has_ratio = (m in size) && size[m] + 0 > 0 && delta[a, m] > 0
            r = has_ratio ? ratio(delta[a, m] / size[m]) : "--"
            if (overhead) line = line " & " r
            else if (has_ratio)  # stacked: delta above, ratio below
                line = line " & \\begin{tabular}[t]{@{}r@{}}" fmt(delta[a, m]) "\\\\" r "\\end{tabular}"
            else line = line " & " fmt(delta[a, m])
        }
        print line " \\\\"
    }
    print "    \\hline"
    print "  \\end{tabular}"
    print "  \\caption{}"
    print "  \\label{" label "}"
    if (rotate) print "  \\end{minipage}}"
    print "\\end{" float "}"
}
' "$IN_CSV" > "$OUT_TEX"

echo "> Wrote $OUT_TEX"
