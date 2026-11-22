#!/usr/bin/env bash
#
# Writes the linear memories of every Wasm module in a directory (searched
# recursively) to a CSV file: one row per memory with its initial number of
# pages (64 KiB each), its maximum number of pages (empty when unbounded) and
# whether it is imported.
#
# Usage: scripts/measure_memory_pages.sh --output <csv-file> <directory>
# Requires: wasm-tools

set -euo pipefail

usage() {
  echo "Usage: $0 --output <csv-file> <directory>" >&2
  exit 1
}

output=""
directory=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output | -o)
      [ $# -ge 2 ] || usage
      output="$2"
      shift 2
      ;;
    --output=*)
      output="${1#--output=}"
      shift
      ;;
    -h | --help) usage ;;
    -*)
      echo "Error: unknown option $1" >&2
      usage
      ;;
    *)
      [ -z "$directory" ] || usage
      directory="$1"
      shift
      ;;
  esac
done

if [ -z "$output" ]; then
  echo "Error: --output is required" >&2
  usage
fi
if [ -z "$directory" ] || [ ! -d "$directory" ]; then
  echo "Error: '$directory' is not a directory" >&2
  usage
fi

if ! command -v wasm-tools >/dev/null 2>&1; then
  echo "Error: wasm-tools is not installed" >&2
  exit 1
fi

mkdir -p "$(dirname "$output")"

{
echo "module,memory,initial_pages,max_pages,imported"

find "$directory" -type f -name '*.wasm' | sort | while IFS= read -r module; do
  # The memory definitions and imports, e.g.
  #   (memory (;1;) 17)
  #   (import "whamm_core" "memory" (memory (;0;) 0))
  # --skeleton leaves out the function bodies, which is much faster.
  if ! memories=$(wasm-tools print --skeleton "$module" 2>/dev/null); then
    echo "Warning: could not parse $module" >&2
    continue
  fi
  printf '%s\n' "$memories" |
    grep -E '^\s*\((memory \(;|import .*\(memory \(;)' |
    while IFS= read -r line; do
      imported=false
      case "$line" in *'(import '*) imported=true ;; esac
      # From '(memory (;N;) [i64] min [max] [shared]' keep N, min and max.
      read -r index initial max < <(
        printf '%s\n' "$line" |
          sed -E 's/.*\(memory \(;([0-9]+);\)( i64)? ([0-9]+)( ([0-9]+))?.*/\1 \3 \5/'
      )
      echo "$module,$index,$initial,${max:-},$imported"
    done
done
} >"$output"

echo "Wrote $output"
