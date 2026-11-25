#!/usr/bin/env node
// runtime_metrics_wasmito_wei.js
//
// Computes the runtime statistics that plot_runtimes.js plots: for Wasmito
// (on the WARDuino VM), for Whamm on the optimised Wizard engine
// ("wei + wizard opt") and, optionally, for Wastrumentation on the same
// engine ("wastrumentation + wizard opt"), per Wasm module and per
// analysis, the statistics of
// the measured times and of the slowdowns. The result is one CSV file; no
// plot is drawn here.
//
// Usage:
//   node src/runtime_metrics_wasmito_wei.js --output <metrics-csv> \
//        <wasmito-csv> <wei-optimised-csv> [wastrumentation-optimised-csv]
// e.g.
//   node src/runtime_metrics_wasmito_wei.js \
//        --output bench_output/plots/runtime_wizard_opt/runtime_metrics.csv \
//        bench_output/execution_time/wasmito/benchmark.csv \
//        bench_output/execution_time/wei-optimised-x86-64/benchmark.csv \
//        bench_output/execution_time/wastrumentation-optimised-x86-64/benchmark.csv
//
// Input:
//   <wasmito-csv>        the runs of Wasmito, with header
//                        analysis,wasm,parsing_ms,spawn_ms,register_ms,
//                        deploy_ms,run_ms,total_ms
//   <wei-optimised-csv>  the runs of Whamm on the optimised Wizard engine,
//                        with header analysis,wasm_module,time_ms
//   [wastrumentation-optimised-csv]
//                        the runs of the modules instrumented by
//                        Wastrumentation on the optimised Wizard engine
//                        (measure_runtime_wastrumentation.sh), in the same
//                        format as <wei-optimised-csv> (optional)
// Every row is one run. A row whose time is not a number (e.g. "TIMEOUT",
// "ERROR" or "timeout after 600000 ms") is a failed run.
// The time of a Wasmito run is its total_ms, so it includes the time to
// spawn the VM (spawn_ms); the time of a Whamm run is its time_ms.
//
// Output (--output), one row per framework, Wasm module and analysis, the
// baseline (the run without any analysis) included:
//   framework    the dynamic analysis framework: 'wasmito', 'wei' (Whamm)
//                or 'wastrumentation'
//   runtime      the VM the framework ran on: 'warduino' or 'wizard opt'
//   baseline     the name of the run without analysis: 'no-analysis'
//                (Wasmito) or 'none' (Whamm, Wastrumentation)
//   wasm         the Wasm module, e.g. factorial.wasm
//   analysis     the analysis, e.g. call-graph
//   runs         the number of successful runs
//   failed_runs  the number of failed runs
//   failure      'timeout' when a run timed out, 'error' when runs only
//                failed otherwise, empty when no run failed
//   time_<stat>      statistics of the times of the successful runs (ms)
//   slowdown_<stat>  statistics of the slowdowns of the successful runs
// where <stat> is mean, median, min, max, stdev (sample standard deviation),
// q1 and q3 (first and third quartile). The slowdown of a run is its time
// divided by the median time of the baseline on the same Wasm module, so the
// baseline itself has a median slowdown of 1. The statistics are empty when
// every run failed, and the slowdowns also when the module has no successful
// baseline run.
//
// The numbers are written with full precision, so that plot_runtimes.js draws
// exactly what it would draw from the raw runs.

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import {
  BASELINE_ANALYSIS, // 'no-analysis': Wasmito's run without any analysis
  WHAMM_BASELINE, // 'none': Whamm's run without any analysis
  computeModuleSlowdowns,
  parseBenchmarkCsv,
} from './plot_util.js';

// The statistics written for the times and for the slowdowns, in this order
// (the names of the fields computeStats in plot_util.js returns).
const STATS = ['mean', 'median', 'min', 'max', 'stdev', 'q1', 'q3'];

// The header of the output CSV.
const HEADER = [
  'framework',
  'runtime',
  'baseline',
  'wasm',
  'analysis',
  'runs',
  'failed_runs',
  'failure',
  ...STATS.map((s) => `time_${s}`),
  ...STATS.map((s) => `slowdown_${s}`),
];

/** Whether `filePath` exists and is a regular file. */
function isFilePath(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Reads a benchmark CSV and groups its runs per Wasm module and analysis
 * (see parseBenchmarkCsv in plot_util.js). For every run only the time is
 * kept: Whamm's time_ms is read under the name total_ms. Failed runs are
 * counted per module and analysis, and reported on the console.
 */
function readRuns(csv) {
  const parsed = parseBenchmarkCsv(
    fs.readFileSync(csv, 'utf-8'),
    'total_ms',
    (line, reason) => console.log(`Skipping line ${line} of '${csv}': ${reason}`),
  );
  if (parsed.runs === 0) {
    throw new Error(`'${csv}' contains no usable rows`);
  }
  return parsed;
}

/** A number with full precision, or an empty field when it is undefined. */
function csvNumber(v) {
  return v === undefined ? '' : String(v);
}

/** The values of the statistics `stats` (or empty fields) in STATS order. */
function statFields(stats) {
  return STATS.map((s) => csvNumber(stats?.[s]));
}

/**
 * The output rows of one framework, as returned by computeModuleSlowdowns
 * (which calls it a "tool"): its
 * `cells` map every Wasm module to a map of every analysis to
 *   { runs: <statistics of the times>, slowdown: <statistics of the
 *     slowdowns>, failedRuns: <number>, failure: 'timeout' | 'error' }.
 * The rows follow the order of `cells`: the modules sorted, the baseline
 * first and then the other analyses sorted.
 */
function toolRows(tool) {
  const rows = [];
  for (const [wasm, perWasm] of tool.cells) {
    for (const [analysis, cell] of perWasm) {
      rows.push(
        [
          tool.label,
          tool.runtime,
          tool.baseline,
          wasm,
          analysis,
          `${cell.runs?.count ?? 0}`,
          `${cell.failedRuns}`,
          cell.failure ?? '',
          ...statFields(cell.runs),
          ...statFields(cell.slowdown),
        ].join(','),
      );
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name('runtime_metrics_wasmito_wei')
  .description(
    'Compute, per Wasm module and analysis, the statistics of the runtimes and slowdowns of Wasmito on WARDuino, of Whamm on the optimised Wizard engine (wei + wizard opt) and, optionally, of Wastrumentation on the same engine, into one CSV file that plot_runtimes.js plots.',
  )
  .argument(
    '<wasmito-csv>',
    'the benchmark CSV of Wasmito, with header analysis,wasm,parsing_ms,spawn_ms,register_ms,deploy_ms,run_ms,total_ms (e.g. bench_output/execution_time/wasmito/benchmark.csv)',
  )
  .argument(
    '<wei-optimised-csv>',
    'the benchmark CSV of Whamm on the optimised Wizard engine, with header analysis,wasm_module,time_ms (e.g. bench_output/execution_time/wei-optimised-x86-64/benchmark.csv)',
  )
  .argument(
    '[wastrumentation-optimised-csv]',
    'the benchmark CSV of the modules instrumented by Wastrumentation on the optimised Wizard engine, in the format of <wei-optimised-csv> (e.g. bench_output/execution_time/wastrumentation-optimised-x86-64/benchmark.csv; optional)',
  )
  .requiredOption(
    '-o, --output <metrics-csv>',
    'the CSV file to write the statistics to; its directory is created if it does not exist (required)',
  )
  .action((wasmitoCsv, weiOptCsv, wastrOptCsv, options) => {
    if (!isFilePath(wasmitoCsv)) {
      program.error('<wasmito-csv> is not a valid path to a CSV file');
    }
    if (!isFilePath(weiOptCsv)) {
      program.error('<wei-optimised-csv> is not a valid path to a CSV file');
    }
    if (wastrOptCsv !== undefined && !isFilePath(wastrOptCsv)) {
      program.error(
        '[wastrumentation-optimised-csv] is not a valid path to a CSV file',
      );
    }

    try {
      // One framework per input CSV. computeModuleSlowdowns computes, per
      // Wasm module, the median time of the baseline and, for every
      // analysis, the statistics of its times and of its slowdowns (each run
      // divided by that baseline median). It throws when no module has a
      // successful baseline run. Its first argument is the name of the
      // framework and its last the runtime; together they name the bars in
      // the legends of the plots, e.g. 'wei + wizard opt'.
      const tools = [
        {
          ...computeModuleSlowdowns(
            'wasmito',
            readRuns(wasmitoCsv),
            BASELINE_ANALYSIS,
            'warduino',
          ),
        },
        {
          ...computeModuleSlowdowns(
            'wei',
            readRuns(weiOptCsv),
            WHAMM_BASELINE,
            'wizard opt',
          ),
        },
        // Wastrumentation's baseline is, as wei's, Wizard on the original
        // module ('none').
        ...(wastrOptCsv === undefined
          ? []
          : [
              computeModuleSlowdowns(
                'wastrumentation',
                readRuns(wastrOptCsv),
                WHAMM_BASELINE,
                'wizard opt',
              ),
            ]),
      ];

      const lines = [HEADER.join(','), ...tools.flatMap(toolRows)];
      fs.mkdirSync(path.dirname(path.resolve(options.output)), {
        recursive: true,
      });
      fs.writeFileSync(options.output, lines.join('\n') + '\n');
      console.log(
        `Wrote ${lines.length - 1} rows of runtime metrics to ${options.output}`,
      );
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : e;
      program.error(`Could not compute the metrics: ${errMsg}`);
    }
  });

// Parse the command line and run the action above.
program.parse();
