#!/bin/sh
#
# Usage: install_dependencies.sh
#
# Installs the system dependencies that all.sh needs on a fresh Debian or
# Ubuntu machine (it uses apt-get, and sudo when not run as root). Run it once
# before all.sh; all.sh installs and builds everything else itself (the
# submodules, Virgil, Wizard, whamm, Wasmito, Wastrumentation and the Rust
# toolchains they use).
#
# Installs:
#   - build tools: git, make, cmake, gcc/g++ (build-essential), pkg-config
#     (Virgil, Wizard, WARDuino, whamm, Wastrumentation)
#   - OpenSSL and zlib headers (libssl-dev, zlib1g-dev), linked by
#     Wastrumentation's CLI
#   - curl, ca-certificates, xz-utils (downloads, e.g. arduino-cli and Node.js)
#   - Python 3 as both python3 and python, with pySerial (arduino-cli, Wasmito,
#     measure_runtime_wei.sh)
#   - headers to build the native npm modules from source when no prebuilt
#     binary fits: libudev-dev (serialport, Wasmito) and the Cairo/Pango
#     libraries (canvas, the plot tool in src/)
#   - Node.js 25.1.0 with npm, from nodejs.org, in /usr/local
#   - rustup (https://rustup.rs) with no default toolchain; install_whamm.sh
#     and build_portable_modules_wastrumentation.sh install the toolchains
#     they need
#
# After it finishes, open a new shell (or run `. "$HOME/.cargo/env"`) so that
# cargo and rustup are on the PATH.

set -e

NODE_VERSION=25.1.0

if ! command -v apt-get >/dev/null 2>&1; then
    echo "error: apt-get not found; this script supports Debian and Ubuntu only" >&2
    exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
    SUDO=
elif command -v sudo >/dev/null 2>&1; then
    SUDO=sudo
else
    echo "error: run this script as root or install sudo" >&2
    exit 1
fi

echo "> Installing system packages"
$SUDO apt-get update
DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y \
    git \
    build-essential \
    cmake \
    pkg-config \
    libssl-dev \
    zlib1g-dev \
    curl \
    ca-certificates \
    xz-utils \
    coreutils \
    python3 \
    python-is-python3 \
    python3-serial \
    libudev-dev \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev

echo "> Installing Node.js $NODE_VERSION"
case "$(uname -m)" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64 | arm64) NODE_ARCH=arm64 ;;
    *)
        echo "error: no Node.js build for architecture '$(uname -m)'" >&2
        exit 1
        ;;
esac
if command -v node >/dev/null 2>&1 && [ "$(node --version)" = "v$NODE_VERSION" ]; then
    echo "Node.js $NODE_VERSION is already installed"
else
    NODE_TARBALL=node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz
    TMP_DIR=$(mktemp -d)
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TARBALL" -o "$TMP_DIR/$NODE_TARBALL"
    $SUDO tar -xJf "$TMP_DIR/$NODE_TARBALL" -C /usr/local --strip-components=1 \
        --exclude CHANGELOG.md --exclude LICENSE --exclude README.md
    rm -rf "$TMP_DIR"
fi
echo "node $(/usr/local/bin/node --version), npm $(/usr/local/bin/npm --version)"

echo "> Installing rustup"
if command -v rustup >/dev/null 2>&1 || [ -x "$HOME/.cargo/bin/rustup" ]; then
    echo "rustup is already installed"
else
    curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain none
fi

echo "> Dependencies installed. Open a new shell (or run '. \"\$HOME/.cargo/env\"') before running scripts/all.sh."
