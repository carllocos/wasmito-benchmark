#!/bin/sh

# Builds Whamm as described in whamm/README.md and its getting-started
# guide: the whamm_core library (target/wasm32-wasip1/release/whamm_core.wasm)
# and the whamm binary (target/release/whamm). env.sh puts the binary on
# the PATH and sets WHAMM_HOME.
#
# Requires rustup: https://rustup.rs. The Rust toolchain is pinned to
# $WHAMM_RUST_VERSION from env.sh
# without changing the machine's default toolchain.

set -e
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

RUST_VERSION=$WHAMM_RUST_VERSION
WASM_TARGET=wasm32-wasip1

if ! command -v rustup >/dev/null 2>&1; then
  echo "error: 'rustup' not found, install Rust first: https://rustup.rs" >&2
  exit 1
fi

echo "> Installing Rust $RUST_VERSION with target $WASM_TARGET"
rustup toolchain install "$RUST_VERSION" --profile minimal --target "$WASM_TARGET"
export RUSTUP_TOOLCHAIN=$RUST_VERSION

echo "> Building Whamm in $WHAMM_DIR"
cd "$WHAMM_DIR"
cargo build -p whamm_core --target "$WASM_TARGET" --release
cargo build --release

echo "> Checking Whamm"
ls -l "$WHAMM_CORE"
whamm --help > /dev/null
whamm info -fv --rule "wasm:opcode:i32.load:before" > /dev/null
echo "whamm OK"
