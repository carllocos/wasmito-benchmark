#!/usr/bin/env bash
#
# Usage: wasmito_run_all.sh [--modules <wasm-module-or-dir>] [--output <dir>]
#                           [--analysis <name[,name...]|all>] [--runs <n>]
#                           [--timeout <seconds>]
#
# Runs Wasmito analyses (through the Wasmito CLI, `cli.cjs analysis`) on
# every Wasm module in --modules, --runs times per (analysis, module).
#
# The analyses are listed in wasmito_analyses.txt in the root of
# wasmito-benchmark, one per line (blank lines are ignored and # starts a
# comment). Add a line there to run a new analysis.
#
# The Wasmito CLI and the modules come from env.sh, so the script can be
# run from any directory. Relative paths given as options are resolved
# against the current directory.
#
# Options (all optional, in any order; --flag value or --flag=value):
#   --modules <wasm-module-or-dir>
#       a single .wasm file or a directory of them (non-recursive).
#       Defaults to $WASMR3_MODULES_DIR (wasmr3_modules/, created by
#       install_wasm-r3.sh).
#   --output <dir>
#       where results are written. Defaults to $OUTPUT_DIR/wasmito
#       (output/execution_time/wasmito/ in the root of wasmito-benchmark).
#   --analysis <name[,name...]|all>
#       the analyses to run, comma-separated (e.g. 'call-graph,imix'), or
#       'all'. Every name must be listed in wasmito_analyses.txt. Defaults
#       to all: every analysis in wasmito_analyses.txt.
#   --runs <n>
#       how many times each analysis is run per module. Defaults to 1.
#   --timeout <seconds>
#       execution timeout per run, passed to the CLI as --te. Defaults to
#       600 (10 minutes).
#
# If a run runs out of heap memory or times out, the remaining runs for
# that (analysis, module) combination are skipped.
#
# Results are written to <output>:
#   <output>/<analysis>/<module>[.run<i>].all     full CLI output of the run
#   <output>/<analysis>/<module>[.run<i>].output  only the plain console.log
#                                                 output
#   <output>/benchmark.csv                        one row per run, written by
#                                                 the CLI (see CSV_HEADER)
# The .run<i> suffix is only added when --runs is greater than 1.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT_DIR/scripts/env.sh"

CLI="$WASMITO_DIR/dist/cjs/cli/cli.cjs"

ANALYSES_FILE="$ROOT_DIR/wasmito_analyses.txt"

if [ ! -f "$ANALYSES_FILE" ]; then
  echo "Error: analyses file '$ANALYSES_FILE' does not exist" >&2
  exit 1
fi
ANALYSES=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"
  line="$(echo "$line" | xargs)"
  [ -n "$line" ] && ANALYSES+=("$line")
done < "$ANALYSES_FILE"
if [ "${#ANALYSES[@]}" -eq 0 ]; then
  echo "Error: no analyses listed in '$ANALYSES_FILE'" >&2
  exit 1
fi

WASM_PATH="$WASMR3_MODULES_DIR"
RESULTS_DIR="$OUTPUT_DIR/wasmito"
ANALYSIS_ARG="all"
REPETITIONS=1
EXECUTION_TIMEOUT_SECONDS=600

usage() {
  echo "Usage: $(basename "$0") [--modules <wasm-module-or-dir>] [--output <dir>] [--analysis <name[,name...]|all>] [--runs <n>] [--timeout <seconds>]"
  echo "  analyses: ${ANALYSES[*]}"
}

fail_usage() {
  echo "Error: $1" >&2
  usage >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --*=*)
      flag="${1%%=*}"
      value="${1#*=}"
      shift
      ;;
    --modules|--output|--analysis|--runs|--timeout)
      flag="$1"
      [ "$#" -ge 2 ] || fail_usage "$flag needs a value"
      value="$2"
      shift 2
      ;;
    --*)
      fail_usage "unknown option '$1'"
      ;;
    *)
      fail_usage "unexpected argument '$1'"
      ;;
  esac
  case "$flag" in
    --modules) WASM_PATH="$value" ;;
    --output) RESULTS_DIR="$value" ;;
    --analysis) ANALYSIS_ARG="$value" ;;
    --runs) REPETITIONS="$value" ;;
    --timeout) EXECUTION_TIMEOUT_SECONDS="$value" ;;
    *) fail_usage "unknown option '$flag'" ;;
  esac
done

# The CLI is run from the wasmito repo root (see below), so make the paths
# given by the caller absolute first.
absolute() {
  case "$1" in
    /*) echo "$1" ;;
    *) echo "$PWD/$1" ;;
  esac
}
WASM_PATH="$(absolute "$WASM_PATH")"
RESULTS_DIR="$(absolute "$RESULTS_DIR")"

if [ ! -f "$CLI" ]; then
  echo "Error: Wasmito CLI '$CLI' does not exist (run scripts/install_all.sh first)" >&2
  exit 1
fi

if [ ! -e "$WASM_PATH" ]; then
  echo "Error: wasm path '$WASM_PATH' does not exist (for wasmr3_modules/, run scripts/install_wasm-r3.sh first)" >&2
  exit 1
fi

if ! [[ "$REPETITIONS" =~ ^[0-9]+$ ]] || [ "$REPETITIONS" -lt 1 ]; then
  fail_usage "runs '$REPETITIONS' must be a positive integer (>= 1)"
fi

if ! [[ "$EXECUTION_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$EXECUTION_TIMEOUT_SECONDS" -lt 1 ]; then
  fail_usage "timeout '$EXECUTION_TIMEOUT_SECONDS' must be a positive integer (>= 1)"
fi

if [ "$ANALYSIS_ARG" != "all" ]; then
  IFS=',' read -r -a REQUESTED_ANALYSES <<< "$ANALYSIS_ARG"
  ANALYSES_TO_RUN=()
  for requested in "${REQUESTED_ANALYSES[@]}"; do
    # Allow whitespace around the commas, e.g. 'call-graph, imix'.
    requested="$(echo "$requested" | xargs)"
    [ -z "$requested" ] && continue
    found=0
    for a in "${ANALYSES[@]}"; do
      if [ "$a" = "$requested" ]; then
        found=1
        break
      fi
    done
    if [ "$found" -eq 0 ]; then
      fail_usage "unknown analysis '$requested' (not listed in $ANALYSES_FILE)"
    fi
    ANALYSES_TO_RUN+=("$requested")
  done
  if [ "${#ANALYSES_TO_RUN[@]}" -eq 0 ]; then
    fail_usage "no analysis given in '$ANALYSIS_ARG'"
  fi
else
  ANALYSES_TO_RUN=("${ANALYSES[@]}")
fi

if [ -d "$WASM_PATH" ]; then
  shopt -s nullglob
  WASM_FILES=("$WASM_PATH"/*.wasm)
  shopt -u nullglob

  if [ "${#WASM_FILES[@]}" -eq 0 ]; then
    echo "Error: no .wasm files found in '$WASM_PATH'" >&2
    exit 1
  fi
elif [ -f "$WASM_PATH" ]; then
  case "$WASM_PATH" in
    *.wasm) ;;
    *)
      echo "Error: '$WASM_PATH' is not a .wasm file" >&2
      exit 1
      ;;
  esac
  WASM_FILES=("$WASM_PATH")
else
  echo "Error: '$WASM_PATH' is neither a directory nor a file" >&2
  exit 1
fi

# Run the CLI from the wasmito repo root, as the original run_analysis.sh
# did.
cd "$WASMITO_DIR"

mkdir -p "$RESULTS_DIR"
csv_file="$RESULTS_DIR/benchmark.csv"

# Must match the header written by writeLastMeasurementToFile in
# wasmito/src/util/benchmark_util.ts.
CSV_HEADER="analysis,wasm,parsing_ms,spawn_ms,register_ms,deploy_ms,run_ms,total_ms"

# Returns success if the node output in the given file shows that node ran
# out of heap memory.
is_out_of_heap() {
  grep -qE 'JavaScript heap out of memory|Reached heap limit' "$1"
}

# Appends an out-of-heap row to the CSV file. Like the CLI, rows are
# prefixed with a newline unless the header still has to be written.
write_out_of_heap_row() {
  local row="$1,$2,out-of-heap,out-of-heap,out-of-heap,out-of-heap,out-of-heap,out-of-heap"
  if [ -s "$csv_file" ] && [ "$(head -n 1 "$csv_file")" = "$CSV_HEADER" ]; then
    printf '\n%s' "$row" >> "$csv_file"
  else
    printf '%s\n%s' "$CSV_HEADER" "$row" >> "$csv_file"
  fi
}

for analysis in "${ANALYSES_TO_RUN[@]}"; do
  analysis_dir="$RESULTS_DIR/$analysis"
  mkdir -p "$analysis_dir"

  for wasm_file in "${WASM_FILES[@]}"; do
    module_name="$(basename "$wasm_file" .wasm)"

    for ((run = 1; run <= REPETITIONS; run++)); do
      if [ "$REPETITIONS" -gt 1 ]; then
        run_suffix=".run${run}"
      else
        run_suffix=""
      fi
      all_file="$analysis_dir/$module_name${run_suffix}.all"
      output_file="$analysis_dir/$module_name${run_suffix}.output"

      echo "Running analysis '$analysis' on '$wasm_file' (run $run/$REPETITIONS) -> '$all_file'"
      start_ms="$(node -e 'console.log(Date.now())')"
      # Do not let a crashing node process (e.g. out of heap memory) abort the
      # whole script because of `set -e`/`pipefail`; capture its exit status.
      set +e
      node "$CLI" analysis "$analysis" "$wasm_file" --csv "$csv_file" --te "$EXECUTION_TIMEOUT_SECONDS" 2>&1 | tee "$all_file"
      node_status="${PIPESTATUS[0]}"
      set -e
      end_ms="$(node -e 'console.log(Date.now())')"
      elapsed_ms="$((end_ms - start_ms))"

      # module.output keeps only the plain console.log output, i.e. strip ANSI
      # color codes (winston colorizes the log level), drop every logger line
      # (lines starting with "[<date> <loglevel>]"), drop lines starting with
      # "Failed to listen for incoming", and drop empty lines.
      sed -E 's/\x1b\[[0-9;]*m//g' "$all_file" \
        | grep -Ev '^\[[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]*Z?[[:space:]]+[a-zA-Z]+\]' \
        | grep -Ev '^Failed to listen for incoming' \
        | grep -Ev '^[[:space:]]*$' \
        > "$output_file" || true

      echo "Total time: ${elapsed_ms} ms" | tee -a "$all_file"

      if [ "$node_status" -ne 0 ] && is_out_of_heap "$all_file"; then
        echo "Out of heap memory detected for analysis '$analysis' on '$wasm_file' (run $run/$REPETITIONS). Skipping remaining runs for this module/analysis." >&2
        write_out_of_heap_row "$analysis" "$(basename "$wasm_file")"
        break
      fi

      if [ -f "$csv_file" ] && tail -n 1 "$csv_file" | grep -qi "timeout"; then
        echo "Timeout detected in '$csv_file' for analysis '$analysis' on '$wasm_file' (run $run/$REPETITIONS). Skipping remaining runs for this module/analysis." >&2
        break
      fi
    done
  done
done
