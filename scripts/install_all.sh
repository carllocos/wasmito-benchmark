#!/bin/sh

# Installs everything needed to run the benchmarks

set -e
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SCRIPTS_DIR=$ROOT_DIR/scripts
. "$SCRIPTS_DIR/env.sh"

echo "> Fetching submodules"
cd "$ROOT_DIR"
git submodule update --init --recursive
# wasmito tracks the branch set in .gitmodules: always use its latest commit
git submodule update --init --remote wasmito

echo "> Installing Wasmito"
cd "$WASMITO_DIR"
/bin/sh ./scripts/install.sh

for script in install_virgil.sh install_wizard.sh install_whamm.sh install_wasm-r3.sh; do
  echo "> Running $script"
  cd "$ROOT_DIR"
  /bin/sh "$SCRIPTS_DIR/$script"
done

echo "> Installation complete"
