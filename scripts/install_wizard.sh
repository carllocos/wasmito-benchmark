#!/bin/sh

# Builds the Wizard engine as described in wizard/doc/Building.md, using
# the Virgil compiler in virgil/ (run install_virgil.sh first).
#
# Builds the two wizeng binaries the benchmarks use: wizeng.x86-64-linux
# and wizeng.jvm. Optimised and non-optimised runs use the same binaries:
# they only differ in the flags passed to wizeng at run time
# (e.g. --mode=jit vs --mode=int)

set -e
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT_DIR/scripts/env.sh"

echo "> Building Wizard in $WIZARD_DIR"
cd "$WIZARD_DIR"
make -j x86-64-linux jvm
ls -l bin/wizeng.x86-64-linux bin/wizeng.jvm
