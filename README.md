# wasmito-benchmark

Benchmarks for [Wasmito](https://github.com/carllocos/Wasmito), compared against
the [Wizard engine](https://github.com/titzer/wizard-engine) running
[whamm](https://github.com/ejrgilbert/whamm) monitors, on the
[wasm-r3](https://github.com/doehyunbaek/wasm-benchmarks) benchmark modules.

## Dependencies

`scripts/all.sh` installs and builds everything else it needs (the submodules,
Virgil, Wizard, whamm, Wasmito, Wastrumentation and their Rust toolchains).
Only the tools below must already be installed on the machine; `all.sh`
first checks them with `scripts/test_dependencies.sh`, which can also be run
on its own. On a fresh Debian or Ubuntu machine,
`scripts/install_dependencies.sh` installs all of them (it uses `apt-get`, and
`sudo` when not run as root):

```sh
./scripts/install_dependencies.sh
. "$HOME/.cargo/env"   # or open a new shell, to put cargo and rustup on the PATH
./scripts/all.sh
```

### Platform

- **Linux on x86-64.** `all.sh` runs Wizard's `x86-64-linux` build, which only
  runs there. The other scripts also work on macOS (use
  `measure_runtime_wei.sh --target jvm` there).

### Tools

| Tool | Needed by | Notes |
|---|---|---|
| `git` | `install_all.sh`, Wasmito install, Wastrumentation | Fetches the submodules and git dependencies. No GitHub account is needed: all submodules use public HTTPS URLs. |
| `rustup` | `install_whamm.sh`, `build_portable_modules_wastrumentation.sh` | Install from <https://rustup.rs>. The scripts install the toolchains they need themselves (Rust 1.94.0 with `wasm32-wasip1` for whamm, nightly for Wastrumentation), without changing your default toolchain. |
| Node.js 25.1.0 and `npm` | Wasmito install, `install_wasmito.sh`, `measure_runtime_wasmito.sh`, the plot tool in `src/` | `install_wasmito.sh` also uses `npm` to build the AssemblyScript examples in `bench_input_data/mcu_modules/`. |
| `make`, `gcc`/`g++` | Virgil, Wizard, WARDuino, native npm modules | |
| `cmake` (>= 3.15) | Wasmito install | Builds the WARDuino emulator used by Wasmito. |
| `pkg-config`, OpenSSL and zlib headers (`libssl-dev`, `zlib1g-dev`) | `build_portable_modules_wastrumentation.sh` | Linked by Wastrumentation's CLI. |
| `curl` | Wasmito install, `install_dependencies.sh` | Downloads `arduino-cli`, Node.js and rustup. |
| Python 3, available as both `python3` and `python` | Wasmito install, `measure_runtime_wei.sh` | Needed by `arduino-cli`, and used to time the Wizard runs. On Ubuntu, `python-is-python3` provides `python`. |
| `python3-serial` (pySerial) | Wasmito install | Listed as a requirement by Wasmito. |
| `libudev-dev`, Cairo and Pango headers (`libcairo2-dev`, `libpango1.0-dev`, `libjpeg-dev`, `libgif-dev`, `librsvg2-dev`) | Wasmito's `serialport`, the plot tool's `canvas` | Only used when no prebuilt binary of these npm modules fits the machine and they are compiled instead. |
| GNU coreutils (`timeout`, `realpath`) | `measure_runtime_wei.sh`, Wasmito install | Preinstalled on Linux. On macOS, install `coreutils` (Homebrew provides `gtimeout`, which is also accepted). |
| `bash` | `measure_runtime_wasmito.sh`, Wizard's build | |
| A POSIX shell (`sh`) and standard tools (`sed`, `grep`, `xargs`, `tee`, `mktemp`) | all scripts | |

**Python 3 must be on the `PATH` as `python`, not only as `python3`.**
`arduino-cli`, which Wasmito's install uses, calls `python`, and it must be
Python 3 (not Python 2). Check it with `python --version`. On Debian/Ubuntu,
install `python-is-python3` (`install_dependencies.sh` does this); elsewhere,
add a `python` symlink to `python3` on the `PATH`, e.g.
`ln -s "$(command -v python3)" /usr/local/bin/python`.

### Optional

| Tool | Needed for |
|---|---|
| Java (JRE) | Only for `measure_runtime_wei.sh --target jvm` (Wizard's `wizeng.jvm` build), which `all.sh` does not use. |

Wasmito's own requirements are listed in
[wasmito/README.md](https://github.com/carllocos/Wasmito#installation); its
README also mentions that access to `/dev/*` is needed when working with
devices.

## Usage

```sh
git clone --recurse-submodules https://github.com/carllocos/wasmito-benchmark.git
cd wasmito-benchmark
./scripts/install_dependencies.sh   # once, on a fresh Debian/Ubuntu machine
. "$HOME/.cargo/env"
./scripts/all.sh
```

`all.sh` installs everything (`install_all.sh`), then runs `measure_runtime_all.sh`,
which runs the execution-time benchmarks in this order:

- `measure_runtime_wasmito.sh`;
- `measure_runtime_wei.sh` on x86-64 in optimised mode, then in non-optimised mode
  (after compiling the whamm monitors with `build_monitors_wei.sh`).

Those results are written to `bench_output/execution_time/`.

Finally, it runs `measure_sizes_all.sh`, which measures how much
instrumentation grows the modules, per framework:

- `measure_sizes_whamm.sh` instruments the wasm-r3 modules with every whamm
  script (`build_portable_modules_whamm.sh`);
- `measure_sizes_wastrumentation.sh` instruments both the wasm-r3 modules and
  the MCU example programs in `bench_input_data/mcu_modules/` (built by
  `install_wasmito.sh`) with every Wastrumentation analysis
  (`build_portable_modules_wastrumentation.sh`), including its ports of
  Wasmito's concurrency analyses in `wastrumentation-concurrency/`.

Those results are written to `bench_output/modules_overhead/`. Each framework
script writes the size of every instrumented module compared to the original
to `module_sizes_<framework>.csv`, and aggregates them per analysis in
`aggregated_metrics_<framework>.csv`.

Once everything is installed, each `measure_*.sh` script can be rerun on its
own.

`measure_runtime_all.sh` ends by running `./scripts/plot_runtime.sh`, which
plots its results to `bench_output/plots/runtime` using the plot tool in
`src/`. It needs the results of Wasmito and of the optimised Wizard engine;
the non-optimised Wizard engine is left out of the plots if it was not
measured. It runs even if a benchmark failed, and then lists the missing
results. It can also be rerun on its own; any arguments are passed on to the
plot tool (e.g. `./scripts/plot_runtime.sh --no-spawn`).
