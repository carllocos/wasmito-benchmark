# src

The `plot` command of [Wasmito](https://github.com/carllocos/Wasmito)
(`cli/plot_command.ts`), rewritten in plain JavaScript as a standalone tool.
It plots the benchmark CSVs written by `measure_runtime_wasmito.sh` and
`measure_runtime_wei.sh` into PDF, PNG and JPG files.

## Install

Needs Node.js 20 or newer. `canvas` is a native module and is built (or
downloaded prebuilt) during the install.

```sh
cd src
npm install
```

## Usage

The options are the same as `wasmito plot`:

```sh
node cli.js plot --help

# Wasmito alone
node cli.js plot <wasmito.csv> <output-dir>
node cli.js plot --slowdown <wasmito.csv> <output-dir>

# Wasmito compared with Whamm (non-optimised and optimised Wizard)
node cli.js plot --whamm-optimised <whamm-opt.csv> <wasmito.csv> <whamm.csv> <output-dir>
```

For example, to plot all the results of `scripts/all.sh` to
`bench_output/plots` (from this directory):

```sh
node cli.js plot \
  --whamm-optimised ../bench_output/execution_time/wei-optimised-x86-64/benchmark.csv \
  ../bench_output/execution_time/wasmito/benchmark.csv \
  ../bench_output/execution_time/wei-not-optimised-x86-64/benchmark.csv \
  ../bench_output/plots
```

Log messages are printed at the level set by the `LogLevel` environment
variable (`error`, `warn`, `info` or `debug`; default `info`; `off` silences
them).

## Files

| File | From Wasmito |
|---|---|
| `cli.js` | entry point (replaces Wasmito's `cli/cli.ts`, with only `plot`) |
| `plot_command.js` | `cli/plot_command.ts` |
| `plot_util.js` | `src/util/plot_util.ts` |
| `markdown_tables.js` | `src/util/markdown_tables.ts` |
| `logger.js` | a small stand-in for `src/logger/logger.ts` (no winston) |

The TypeScript interfaces and type aliases are kept as JSDoc `@typedef`s.
