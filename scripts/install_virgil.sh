#!/bin/sh

# Installs Virgil as described in virgil/start/README.md: puts virgil/bin
# on the PATH (see env.sh) and bootstraps the compiler with `make`, since
# Wizard needs features that are newer than the stable compiler binaries

set -e
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

echo "> Bootstrapping Virgil in $VIRGIL_DIR"
cd "$VIRGIL_DIR"
make

echo "> Checking Virgil"
cd "$VIRGIL_DIR/apps/HelloWorld"
v3i HelloWorld.v3
