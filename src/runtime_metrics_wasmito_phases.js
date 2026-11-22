#!/usr/bin/env node
// runtime_metrics_wasmito_phases.js
//
// Computes how the total runtime of Wasmito splits into its phases, which
// plot_runtimes.js draws as one stacked bar per Wasm module and analysis. The
// result is one CSV file; no plot is drawn here.
//
// Usage:
//   node src/runtime_metrics_wasmito_phases.js --output <phases-csv> <wasmito-csv>
// e.g.
//   node src/runtime_metrics_wasmito_phases.js \
//        --output bench_output/plots/runtime_wizard_opt/phases_metrics.csv \
//        bench_output/execution_time/wasmito/benchmark.csv
//
// Input:
//   <wasmito-csv>  the runs of Wasmito, with header
//                  analysis,wasm,parsing_ms,spawn_ms,register_ms,deploy_ms,
//                  run_ms,total_ms
// Every row is one run, with the time of every phase in ms:
//   parsing_ms   parsing the Wasm module
//   spawn_ms     spawning the WARDuino VM
//   register_ms  registering the advices of the analysis
//   deploy_ms    deploying the hooks in the VM
//   run_ms       running the module with the analysis
// A row where any of these is not a number (e.g. "timeout after 600000 ms")
// is a failed run.
//
// Output (--output), one row per analysis and Wasm module:
//   analysis               the analysis, e.g. call-graph
//   wasm                   the Wasm module, e.g. factorial.wasm
//   runs                   the number of successful runs
//   failure                when no run succeeded: 'timeout' when a run timed
//                          out, 'error' otherwise; empty otherwise
//   <phase>_mean           the mean time of every phase over the successful
//                          runs, e.g. spawn_ms_mean
//   unattributed_ms_mean   the part of the mean total time that no phase
//                          accounts for (never negative)
//   total_ms_mean          the mean total time
// Means are used, not medians, because the means of the phases add up to the
// mean total time while their medians do not. The time columns are empty
// for a failed analysis.
//
// The numbers are written with full precision, so that plot_runtimes.js draws
// exactly what it would draw from the raw runs.

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { breakdownPhases, computePhaseBreakdowns } from './plot_util.js';

/** Whether `filePath` exists and is a regular file. */
function isFilePath(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** A number with full precision, or an empty field when it is undefined. */
function csvNumber(v) {
  return v === undefined ? '' : String(v);
}

/**
 * The CSV lines of `breakdowns`, as returned by computePhaseBreakdowns: a
 * map of every analysis to a map of every Wasm module to either
 *   { runs, means: { <phase>: <mean ms> }, unattributed, total }
 * or, when every run failed, the string 'timeout' or 'error'.
 * The rows follow the order of the maps, so that plot_runtimes.js rebuilds
 * them in the same order.
 */
function formatCsv(breakdowns) {
  // The phases the input CSV has a column for, in the order of the plot.
  const phases = breakdownPhases(breakdowns);
  const lines = [
    [
      'analysis',
      'wasm',
      'runs',
      'failure',
      ...phases.map((p) => `${p}_mean`),
      'unattributed_ms_mean',
      'total_ms_mean',
    ].join(','),
  ];
  for (const [analysis, perAnalysis] of breakdowns) {
    for (const [wasm, b] of perAnalysis) {
      lines.push(
        typeof b === 'string'
          ? // Every run failed: no times, only the kind of failure.
            [analysis, wasm, '0', b, ...phases.map(() => ''), '', ''].join(',')
          : [
              analysis,
              wasm,
              `${b.runs}`,
              '',
              ...phases.map((p) => csvNumber(b.means[p])),
              csvNumber(b.unattributed),
              csvNumber(b.total),
            ].join(','),
      );
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name('runtime_metrics_wasmito_phases')
  .description(
    'Compute, per analysis and Wasm module, the mean time of every phase of Wasmito (parse, spawn, register, deploy, run), into one CSV file that plot_runtimes.js plots.',
  )
  .argument(
    '<wasmito-csv>',
    'the benchmark CSV of Wasmito, with header analysis,wasm,parsing_ms,spawn_ms,register_ms,deploy_ms,run_ms,total_ms (e.g. bench_output/execution_time/wasmito/benchmark.csv)',
  )
  .requiredOption(
    '-o, --output <phases-csv>',
    'the CSV file to write the phase means to; its directory is created if it does not exist (required)',
  )
  .action((wasmitoCsv, options) => {
    if (!isFilePath(wasmitoCsv)) {
      program.error('<wasmito-csv> is not a valid path to a CSV file');
    }

    try {
      // computePhaseBreakdowns (plot_util.js) groups the runs per analysis
      // and Wasm module and takes the mean of every phase and of the total.
      const breakdowns = computePhaseBreakdowns(
        fs.readFileSync(wasmitoCsv, 'utf-8'),
      );
      const lines = formatCsv(breakdowns);
      fs.mkdirSync(path.dirname(path.resolve(options.output)), {
        recursive: true,
      });
      fs.writeFileSync(options.output, lines.join('\n') + '\n');
      console.log(
        `Wrote ${lines.length - 1} rows of phase metrics to ${options.output}`,
      );
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : e;
      program.error(`Could not compute the metrics: ${errMsg}`);
    }
  });

// Parse the command line and run the action above.
program.parse();
