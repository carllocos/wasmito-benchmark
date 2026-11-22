#!/usr/bin/env node
// plot_wasmito_phases.js
//
// Plots how the total runtime of Wasmito splits into its phases: one
// stacked bar per Wasm module and analysis, with the share of every phase
// (parse wasm, spawn the VM, register advices, deploy hooks, run analysis)
// in the mean total time.
//
// This script only plots: it computes no statistics itself. It reads the
// CSV written by runtime_metrics_wasmito_phases.js, so that runs first:
//   1. runtime_metrics_wasmito_phases.js  the mean time of every phase
//   2. plot_wasmito_phases.js             the plot of those means
// The drawing itself is done by writePhasePlot in plot_util.js; this file
// reads the metrics CSV back into the data structure that function expects.
//
// Usage:
//   node src/plot_wasmito_phases.js --output <dir> <phases-metrics-csv>
// e.g.
//   node src/runtime_metrics_wasmito_phases.js \
//        --output bench_output/plots/runtime_wizard_opt/phases_metrics.csv \
//        bench_output/execution_time/wasmito/benchmark.csv
//   node src/plot_wasmito_phases.js \
//        --output bench_output/plots/runtime_wizard_opt \
//        bench_output/plots/runtime_wizard_opt/phases_metrics.csv
//
// The plot is written as a PDF file to
//   <dir>/wasmito_phases/wasmito_phases.pdf
// so that it lands next to the plots of plot_wei_opt.js when both are given
// the same output directory.

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { writePhasePlot } from './plot_util.js';

// The file formats every plot is written in. plot_util.js can also draw
// 'png' and 'jpg'; add them here to get those files too.
const PLOT_FORMATS = ['pdf'];

// A benchmark run is stopped after this many minutes; analyses whose runs
// all timed out are marked as "timed out" in the plot, and the legend shows
// this limit.
const TIMEOUT_MINUTES = 10;

// The width of the plot in pixels; the height follows from the number of
// analyses in the plot.
const PLOT_WIDTH = 1400;

// ---------------------------------------------------------------------------
// Small file system helpers
// ---------------------------------------------------------------------------

/** Whether `filePath` exists and is a regular file. */
function isFilePath(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reading the metrics CSV
// ---------------------------------------------------------------------------

/**
 * Reads the phases metrics CSV (runtime_metrics_wasmito_phases.js) into the
 * shape the phases plot of plot_util.js expects:
 *   Map<analysis, Map<wasm,
 *     { runs, means: { <phase>: <mean ms> }, unattributed, total }
 *     | 'timeout' | 'error'>>
 * where the string replaces the times when every run failed. The phases
 * are the columns <phase>_mean of the CSV, e.g. spawn_ms_mean. The rows are
 * read in file order, so the analyses and modules keep the order in which
 * the metrics script wrote them. The CSV contains no quoted fields, so
 * splitting on ',' is enough.
 */
function readPhases(csvPath) {
  const lines = fs
    .readFileSync(csvPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const header = (lines[0] ?? '').split(',');
  const required = [
    'analysis',
    'wasm',
    'runs',
    'failure',
    'unattributed_ms_mean',
    'total_ms_mean',
  ];
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `'${csvPath}' is missing the column(s) ${missing.join(', ')}`,
    );
  }

  // The phase columns, e.g. spawn_ms_mean -> spawn_ms.
  const phases = header
    .filter(
      (c) =>
        c.endsWith('_mean') &&
        c !== 'unattributed_ms_mean' &&
        c !== 'total_ms_mean',
    )
    .map((c) => c.slice(0, -'_mean'.length));

  const breakdowns = new Map();
  for (const line of lines.slice(1)) {
    // The row as an object from column name to value.
    const fields = line.split(',');
    const row = Object.fromEntries(header.map((c, i) => [c, fields[i] ?? '']));

    const perAnalysis = breakdowns.get(row.analysis) ?? new Map();
    perAnalysis.set(
      row.wasm,
      row.failure !== ''
        ? // Every run failed: only the kind of failure is known.
          row.failure
        : {
            runs: Number(row.runs),
            means: Object.fromEntries(
              phases.map((p) => [p, Number(row[`${p}_mean`])]),
            ),
            total: Number(row.total_ms_mean),
            unattributed: Number(row.unattributed_ms_mean),
          },
    );
    breakdowns.set(row.analysis, perAnalysis);
  }
  return breakdowns;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

// `commander` parses the command line: it checks that the CSV path and
// --output are given, prints --help, and then calls the `.action` function
// below with the path and the parsed options.
const program = new Command();
program
  .name('plot_wasmito_phases')
  .description(
    'Plot how the total runtime of Wasmito splits into its phases (parse, spawn, register, deploy, run), per analysis and Wasm module, into a PDF file in <dir>/wasmito_phases. Reads the CSV of runtime_metrics_wasmito_phases.js.',
  )
  .argument(
    '<phases-metrics-csv>',
    'the CSV written by runtime_metrics_wasmito_phases.js',
  )
  .requiredOption(
    '-o, --output <dir>',
    'the directory to store the plot in (in its subdirectory wasmito_phases), created if it does not exist (required)',
  )
  .action((phasesMetricsCsv, options) => {
    const outputDir = options.output;

    // program.error prints the message and exits the process.
    if (!isFilePath(phasesMetricsCsv)) {
      program.error('<phases-metrics-csv> is not a valid path to a CSV file');
    }
    if (fs.existsSync(outputDir) && !fs.statSync(outputDir).isDirectory()) {
      program.error(`--output '${outputDir}' is not a directory`);
    }

    try {
      const phases = readPhases(phasesMetricsCsv);
      const phasesDir = path.join(outputDir, 'wasmito_phases');
      fs.mkdirSync(phasesDir, { recursive: true });

      // The plot in every format of PLOT_FORMATS.
      for (const format of PLOT_FORMATS) {
        const target = path.join(phasesDir, `wasmito_phases.${format}`);
        writePhasePlot(
          phases,
          { format, width: PLOT_WIDTH, timeoutMinutes: TIMEOUT_MINUTES },
          target,
        );
        console.log(`Plotted the phases of wasmito to ${target}`);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : e;
      program.error(`Could not create plot, error occurred: ${errMsg}`);
    }
  });

// Parse the command line and run the action above.
program.parse();
