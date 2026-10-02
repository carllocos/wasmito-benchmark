#!/bin/sh
#
# Usage: test_dependencies.sh
#
# Checks that the dependencies all.sh needs are installed (the ones
# install_dependencies.sh installs on Debian and Ubuntu), and reports every
# missing one at once. Exits non-zero if a required dependency is missing.
#
# Errors (exit 1): a missing required command (git, make, cmake, gcc, g++,
# pkg-config, curl, python3, python, node, npm, rustup, cargo, timeout,
# realpath, bash and standard tools), a missing pySerial, and on Linux missing
# OpenSSL or zlib headers.
# Warnings: a Node.js version other than 25.1.0, missing headers that are only
# needed to compile the native npm modules from source (libudev, Cairo,
# Pango), and a platform other than Linux on x86-64.

NODE_VERSION=25.1.0

ERRORS=0
WARNINGS=0

error() {
    echo "  missing: $1" >&2
    ERRORS=$((ERRORS + 1))
}

warning() {
    echo "  warning: $1" >&2
    WARNINGS=$((WARNINGS + 1))
}

echo "> Checking the dependencies of all.sh"

OS=$(uname -s)
ARCH=$(uname -m)
if [ "$OS" != Linux ] || [ "$ARCH" != x86_64 ]; then
    warning "running on $OS $ARCH; all.sh runs Wizard's x86-64-linux build, which needs Linux on x86-64"
fi

# Commands, with what needs them.
for ENTRY in \
    "git:submodules, Wasmito install, Wastrumentation" \
    "make:Virgil, Wizard, WARDuino" \
    "cmake:WARDuino emulator (Wasmito install)" \
    "gcc:C/C++ builds" \
    "g++:C/C++ builds" \
    "pkg-config:Wastrumentation's CLI" \
    "curl:Wasmito install (arduino-cli)" \
    "python3:arduino-cli, measure_runtime_wei.sh" \
    "python:arduino-cli (on Ubuntu: python-is-python3)" \
    "node:Wasmito, MCU examples, plot tool" \
    "npm:Wasmito, MCU examples, plot tool" \
    "realpath:Wasmito install" \
    "bash:measure_runtime_wasmito.sh, Wizard's build" \
    "sed:all scripts" \
    "grep:all scripts" \
    "xargs:all scripts" \
    "tee:all scripts" \
    "mktemp:all scripts"; do
    CMD=${ENTRY%%:*}
    command -v "$CMD" >/dev/null 2>&1 || error "$CMD (${ENTRY#*:})"
done

# GNU timeout, or gtimeout from Homebrew's coreutils on macOS.
if ! command -v timeout >/dev/null 2>&1 && ! command -v gtimeout >/dev/null 2>&1; then
    error "timeout (GNU coreutils; measure_runtime_wei.sh)"
fi

# rustup and cargo, which the rustup installer puts in ~/.cargo/bin.
for CMD in rustup cargo; do
    if ! command -v "$CMD" >/dev/null 2>&1; then
        if [ -x "$HOME/.cargo/bin/$CMD" ]; then
            error "$CMD is installed but not on the PATH (run '. \"\$HOME/.cargo/env\"' or open a new shell)"
        else
            error "$CMD (whamm, Wastrumentation; install from https://rustup.rs)"
        fi
    fi
done

if command -v node >/dev/null 2>&1 && [ "$(node --version)" != "v$NODE_VERSION" ]; then
    warning "Node.js $(node --version) is installed, the benchmarks use v$NODE_VERSION"
fi

if command -v python3 >/dev/null 2>&1 && ! python3 -c "import serial" >/dev/null 2>&1; then
    error "pySerial (python3-serial; Wasmito install)"
fi

# Libraries, checked with pkg-config. Elsewhere than Linux they may be found
# without pkg-config (e.g. Homebrew's OpenSSL on macOS), so only warn there.
if command -v pkg-config >/dev/null 2>&1; then
    for ENTRY in "openssl:libssl-dev" "zlib:zlib1g-dev"; do
        MODULE=${ENTRY%%:*}
        if ! pkg-config --exists "$MODULE"; then
            if [ "$OS" = Linux ]; then
                error "$MODULE headers (${ENTRY#*:}; Wastrumentation's CLI)"
            else
                warning "pkg-config does not find $MODULE (Wastrumentation's CLI links against it)"
            fi
        fi
    done
    if [ "$OS" = Linux ]; then
        for ENTRY in "libudev:libudev-dev; serialport" "cairo:libcairo2-dev; canvas" \
            "pangocairo:libpango1.0-dev; canvas"; do
            MODULE=${ENTRY%%:*}
            pkg-config --exists "$MODULE" ||
                warning "$MODULE headers (${ENTRY#*:}), only needed when the npm module has no prebuilt binary"
        done
    fi
fi

if [ "$ERRORS" -gt 0 ]; then
    if [ "$ERRORS" -eq 1 ]; then
        echo "error: 1 required dependency is missing (on Debian/Ubuntu, run scripts/install_dependencies.sh)" >&2
    else
        echo "error: $ERRORS required dependencies are missing (on Debian/Ubuntu, run scripts/install_dependencies.sh)" >&2
    fi
    exit 1
fi
echo "All required dependencies are installed ($WARNINGS warnings)."
