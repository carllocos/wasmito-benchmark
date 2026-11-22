#!/usr/bin/env node
// plot_wei_opt.js
//
// Plots the runtime of Wasmito (on the WARDuino VM) next to the runtime of
// Whamm on the optimised Wizard engine ("wei + wizard opt"), per Wasm module.
// (The phases of Wasmito are plotted by plot_wasmito_phases.js.)
//
// This script only plots: it computes no statistics itself. It reads the
// CSV written by runtime_metrics_wasmito_wei.js, so that runs first:
//   1. runtime_metrics_wasmito_wei.js  the statistics of the times and
//                                      slowdowns of both tools
//   2. plot_wei_opt.js                 the plots of those statistics
// The drawing itself is done by the helpers in plot_util.js; this file reads
// the metrics CSV back into the data structure those helpers expect, and
// decides which plots are written where.
//
// Usage:
//   node src/plot_wei_opt.js --output <dir> <runtime-metrics-csv>
// e.g.
//   node src/runtime_metrics_wasmito_wei.js \
//        --output bench_output/plots/runtime_wizard_opt/runtime_metrics.csv \
//        bench_output/execution_time/wasmito/benchmark.csv \
//        bench_output/execution_time/wei-optimised-x86-64/benchmark.csv
//   node src/plot_wei_opt.js \
//        --output bench_output/plots/runtime_wizard_opt \
//        bench_output/plots/runtime_wizard_opt/runtime_metrics.csv
//
// Every plot is written as a PDF file. The output directory gets:
//   engine/engine_absolute.*          the runtime without any analysis of
//                                     WARDuino and of Wizard, in seconds
//   engine/engine_relative.*          the same, relative to each other
//   analysis/analysis_absolute.*      per analysis and Wasm module, the time
//                                     of both tools next to their runtime
//                                     without analysis
//   analysis/analysis_relative.*      per analysis and Wasm module, the
//                                     slowdown of both tools (time with the
//                                     analysis / time without it)
//   analysis/analysis_{absolute,relative}/<analysis>.*
//                                     the same, one plot per analysis
//
// All of Wasmito's times are total_ms, i.e. they include the time to spawn
// the VM (spawn_ms).

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import {
  comparedAnalyses,
  writeBaselineComparisonPlot,
  writeModuleComparisonPlot,
} from './plot_util.js';

// The file formats every plot is written in. plot_util.js can also draw
// 'png' and 'jpg'; add them here to get those files too.
const PLOT_FORMATS = ['pdf'];

// A benchmark run is stopped after this many minutes; such runs are marked
// as "timed out" in the plots, and the legend shows this limit.
const TIMEOUT_MINUTES = 10;

// The width of every plot in pixels; the height follows from the number of
// panels in the plot.
const PLOT_WIDTH = 1400;

// The analyses to compare, one entry per analysis:
//   [<name in Wasmito>, <name in Whamm>, <name in the plots>]
// The Wasmito analysis is compared with the Whamm analysis, and both appear
// under the plot name: as the title of the analysis' panel in
// analysis/analysis_{absolute,relative}.pdf and as the file name of its own
// plot in analysis/analysis_{absolute,relative}/<name in the plots>.pdf.
// Only the analyses listed here are plotted, and only when both frameworks
// have data for them; the panels are ordered alphabetically by plot name.
// The names in Wasmito and Whamm are those of the analysis column of the
// runtime metrics CSV.
const ANALYSES = [
  ['basic-block', 'basic_blocks', 'basic_blocks'],
  ['branches', 'branches', 'branches'],
  ['cache_sim', 'cache_sim', 'cache_sim'],
  ['call-graph', 'call_graph', 'call_graph'],
  ['hotness', 'hotness', 'hotness'],
  ['icount', 'icount', 'icount'],
  ['imix', 'imix', 'imix'],
  ['instr-coverage', 'instr_coverage', 'instr_coverage'],
  ['loop_tracer', 'loop_tracer', 'loop_tracer'],
  ['mem_access', 'mem_access', 'mem_access'],
];

// The colour of every framework, as an index in the palette of
// plot_util.js. Index 2 is the colour the original plot command also gives
// to wei + wizard opt, so the plots look the same as before.
const TOOL_COLOR_INDEX = { wasmito: 0, wei: 2 };

// The column of the raw benchmark CSV that the times of every framework come
// from: Wasmito's total_ms includes the time to spawn the VM, Whamm only
// records time_ms. Shown in the legend of engine/engine_relative, e.g.
// "(time_ms / median total_ms)".
const TIME_COLUMN = { wasmito: 'total_ms', wei: 'time_ms' };

// The statistics of the times and slowdowns in the runtime metrics CSV (the
// columns time_<stat> and slowdown_<stat>), see
// runtime_metrics_wasmito_wei.js.
const STATS = ['mean', 'median', 'min', 'max', 'stdev', 'q1', 'q3'];

// ---------------------------------------------------------------------------
// Small file system helpers
// ---------------------------------------------------------------------------

/** Creates `directoryPath` (and its parents) if it does not exist yet. */
function createDirectoryIfUnexisting(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

/** Whether `filePath` exists and is a regular file. */
function isFilePath(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Returns `outputDir/name`, creating that directory if needed. */
function subdirectory(outputDir, name) {
  const dir = path.join(outputDir, name);
  createDirectoryIfUnexisting(dir);
  return dir;
}

/**
 * The files to write the plot `name` to: one per format in PLOT_FORMATS,
 * e.g. [{ format: 'pdf', path: '<outputDir>/<name>.pdf' }].
 */
function outputTargets(outputDir, name) {
  return PLOT_FORMATS.map((format) => ({
    format,
    path: path.join(outputDir, `${name}.${format}`),
  }));
}

// ---------------------------------------------------------------------------
// Reading the metrics CSVs
// ---------------------------------------------------------------------------

/**
 * Reads a CSV file into its rows, each an object from column name to value
 * (a string; empty fields are ''). The metrics CSVs contain no quoted
 * fields, so splitting on ',' is enough.
 */
function readCsv(csvPath, requiredColumns) {
  const lines = fs
    .readFileSync(csvPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const header = (lines[0] ?? '').split(',');
  const missing = requiredColumns.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `'${csvPath}' is missing the column(s) ${missing.join(', ')}`,
    );
  }
  return {
    header,
    rows: lines.slice(1).map((line) => {
      const fields = line.split(',');
      return Object.fromEntries(header.map((c, i) => [c, fields[i] ?? '']));
    }),
  };
}

/**
 * The statistics `<prefix>_mean`, ... of a row as the object plot_util.js
 * expects ({ count, mean, median, min, max, stdev, q1, q3 }), or undefined
 * when the row has none (every run failed, or no slowdown without baseline).
 */
function statsOf(row, prefix) {
  if (row[`${prefix}_mean`] === '') return undefined;
  const stats = { count: Number(row.runs) };
  for (const s of STATS) stats[s] = Number(row[`${prefix}_${s}`]);
  return stats;
}

/**
 * Reads the runtime metrics CSV (runtime_metrics_wasmito_wei.js) back into
 * one "tool" per value of its framework column, in the shape that the plot
 * helpers of plot_util.js expect the following, which is one tool object:
 *   {
 *     label, runtime, baseline, timeColumn, colorIndex,
 *     cells: Map<wasm, Map<analysis, {
 *       runs: <statistics of the times>, slowdown: <statistics of the
 *       slowdowns>, failedRuns: <number>, failure: 'timeout' | 'error'
 *     }>>,
 *     baselineMedians: Map<wasm, median time of the baseline>,
 *     failedRuns: <number of failed runs in total>,
 *   }
 * The rows are read in file order, so the modules and analyses keep the
 * order in which the metrics script wrote them.
 */
function readTools(csvPath) {
  const { rows } = readCsv(csvPath, [
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
  ]);
  const tools = new Map();
  for (const row of rows) {
    if (!tools.has(row.framework)) {
      if (!(row.framework in TOOL_COLOR_INDEX)) {
        throw new Error(`'${csvPath}': unknown framework '${row.framework}'`);
      }
      tools.set(row.framework, {
        // The legends name a framework '<label> + <runtime>', e.g.
        // 'wei + wizard opt'.
        label: row.framework,
        runtime: row.runtime,
        baseline: row.baseline,
        timeColumn: TIME_COLUMN[row.framework],
        colorIndex: TOOL_COLOR_INDEX[row.framework],
        cells: new Map(),
        baselineMedians: new Map(),
        failedRuns: 0,
      });
    }
    const tool = tools.get(row.framework);
    const cell = {
      runs: statsOf(row, 'time'),
      slowdown: statsOf(row, 'slowdown'),
      failedRuns: Number(row.failed_runs),
      failure: row.failure || undefined,
    };
    const perWasm = tool.cells.get(row.wasm) ?? new Map();
    perWasm.set(row.analysis, cell);
    tool.cells.set(row.wasm, perWasm);
    tool.failedRuns += cell.failedRuns;
    // The slowdowns of a module are relative to the median of its baseline.
    if (row.analysis === tool.baseline && cell.runs?.median > 0) {
      tool.baselineMedians.set(row.wasm, cell.runs.median);
    }
  }
  // Wasmito first, then Whamm: the order of the bars in every group.
  return [...tools.values()].sort((a, b) => a.colorIndex - b.colorIndex);
}

/**
 * Applies ANALYSES to the frameworks read by readTools: in the `cells` of
 * every framework, each listed analysis is renamed to its plot name, and
 * the analyses that are not listed are dropped (the baseline, the run
 * without analysis, is kept: the slowdowns and the engine plots need it).
 * After this both frameworks call a compared analysis by the same name, so
 * the plot helpers of plot_util.js match them and show that name.
 * An analysis of the list that a framework has no data for is reported on
 * the console and left out of the plots, since it cannot be compared.
 */
function applyAnalysisNames(tools) {
  const plotNames = ANALYSES.map(([, , plotName]) => plotName);
  const duplicate = plotNames.find((n, i) => plotNames.indexOf(n) !== i);
  if (duplicate !== undefined) {
    throw new Error(`the plot name '${duplicate}' appears twice in ANALYSES`);
  }

  tools.forEach((tool, side) => {
    // side 0 is Wasmito (first name of an entry), side 1 is Whamm (second).
    const plotNameOf = new Map(
      ANALYSES.map((entry) => [entry[side], entry[2]]),
    );
    const found = new Set();
    for (const [wasm, perWasm] of tool.cells) {
      const renamed = new Map();
      for (const [analysis, cell] of perWasm) {
        if (analysis === tool.baseline) {
          renamed.set(analysis, cell);
        } else if (plotNameOf.has(analysis)) {
          renamed.set(plotNameOf.get(analysis), cell);
          found.add(analysis);
        }
      }
      tool.cells.set(wasm, renamed);
    }
    for (const analysis of plotNameOf.keys()) {
      if (!found.has(analysis)) {
        console.log(
          `Warning: ${tool.label} has no data for the analysis '${analysis}' of ANALYSES`,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// The plots
// ---------------------------------------------------------------------------
// Both functions below draw the same three kinds of plot, from `tools` (the
// frameworks read by readTools, after applyAnalysisNames) and `pairs` (which
// analysis of Wasmito is compared with which of Whamm):
//   a. engine/engine_<kind>.pdf: the runtimes without any analysis, WARDuino
//      vs Wizard
//   b. analysis/analysis_<kind>.pdf: every analysis both frameworks have, one
//      panel per analysis, a group of bars per Wasm module
//   c. analysis/analysis_<kind>/<plot name>.pdf: the same, every analysis in
//      a figure of its own, without a title
// Every bar has a whisker from the min to the max of the runs, and a letter
// replaces the bar of runs that timed out (T) or failed (E).
// comparedAnalyses lists the analyses both frameworks have, as
// { first: <Wasmito's name>, second: <Whamm's name> }, which are both the
// plot name of ANALYSES here; in file names, characters that are not safe in
// a file name are replaced by '_'.

/**
 * The relative plots, in which every bar is the median slowdown of the runs
 * (1× = as fast as the run without analysis on the same Wasm module): the
 * plots a., b. and c. described above.
 */
function plotRelative(tools, pairs, outputDir) {
  const engineDir = subdirectory(outputDir, 'engine');
  const analysisDir = subdirectory(outputDir, 'analysis');
  const perAnalysisDir = subdirectory(analysisDir, 'analysis_relative');

  plotEngineRelative(tools, engineDir);
  plotAnalysesRelative(tools, pairs, analysisDir);
  plotEachAnalysisRelative(tools, pairs, perAnalysisDir);
}

/**
 * a. The runtimes without analysis, relative to those of WARDuino, in
 * <engineDir>/engine_relative.pdf.
 */
function plotEngineRelative(tools, engineDir) {
  for (const target of outputTargets(engineDir, 'engine_relative')) {
    writeBaselineComparisonPlot(
      tools,
      {
        format: target.format,
        width: PLOT_WIDTH,
        absolute: false,
        timeoutMinutes: TIMEOUT_MINUTES,
        showMinMax: true,
      },
      target.path,
    );
    console.log(
      `Plotted the relative time of the runtimes without analysis to ${target.path}`,
    );
  }
}

/**
 * b. The slowdown of every analysis, one panel per analysis, all in one
 * figure: <analysisDir>/analysis_relative.pdf.
 */
function plotAnalysesRelative(tools, pairs, analysisDir) {
  for (const target of outputTargets(analysisDir, 'analysis_relative')) {
    writeModuleComparisonPlot(
      tools,
      pairs,
      {
        format: target.format,
        width: PLOT_WIDTH,
        absolute: false,
        timeoutMinutes: TIMEOUT_MINUTES,
        showMinMax: true,
      },
      target.path,
    );
    console.log(
      `Plotted the slowdown per Wasm module of ${tools.map((t) => t.label).join(', ')} to ${target.path}`,
    );
  }
}

/**
 * c. The slowdown of every analysis, each in a figure of its own without a
 * title: <perAnalysisDir>/<plot name>.pdf.
 */
function plotEachAnalysisRelative(tools, pairs, perAnalysisDir) {
  for (const { second: analysis } of comparedAnalyses(tools, pairs)) {
    for (const target of outputTargets(
      perAnalysisDir,
      analysis.replace(/[^\w.-]/g, '_'),
    )) {
      writeModuleComparisonPlot(
        tools,
        pairs,
        {
          format: target.format,
          title: false,
          width: PLOT_WIDTH,
          absolute: false,
          timeoutMinutes: TIMEOUT_MINUTES,
          showMinMax: true,
          analysis, // only draw this analysis
        },
        target.path,
      );
      console.log(
        `Plotted the slowdown per Wasm module of ${analysis} to ${target.path}`,
      );
    }
  }
}

/**
 * The absolute plots, in which every bar is the mean measured time of the
 * runs (log scale), and every framework also gets a lighter bar for its run
 * without analysis next to the bar of the analysis.
 */
function plotAbsolute(tools, pairs, outputDir) {
  const engineDir = subdirectory(outputDir, 'engine');
  const analysisDir = subdirectory(outputDir, 'analysis');
  const perAnalysisDir = subdirectory(analysisDir, 'analysis_absolute');

  // a. The measured times of the runtimes without analysis.
  for (const target of outputTargets(engineDir, 'engine_absolute')) {
    writeBaselineComparisonPlot(
      tools,
      {
        format: target.format,
        width: PLOT_WIDTH,
        absolute: true,
        timeoutMinutes: TIMEOUT_MINUTES,
        showMinMax: true,
      },
      target.path,
    );
    console.log(
      `Plotted the time of the runtimes without analysis to ${target.path}`,
    );
  }

  // b. The measured times of every analysis, all in one figure.
  for (const target of outputTargets(analysisDir, 'analysis_absolute')) {
    writeModuleComparisonPlot(
      tools,
      pairs,
      {
        format: target.format,
        width: PLOT_WIDTH,
        absolute: true,
        timeoutMinutes: TIMEOUT_MINUTES,
        showMinMax: true,
      },
      target.path,
    );
    console.log(
      `Plotted the time per Wasm module of ${tools.map((t) => t.label).join(', ')} to ${target.path}`,
    );
  }

  // c. The measured times of every analysis, each in a figure of its own.
  for (const { second: analysis } of comparedAnalyses(tools, pairs)) {
    for (const target of outputTargets(
      perAnalysisDir,
      analysis.replace(/[^\w.-]/g, '_'),
    )) {
      writeModuleComparisonPlot(
        tools,
        pairs,
        {
          format: target.format,
          title: false,
          width: PLOT_WIDTH,
          absolute: true,
          timeoutMinutes: TIMEOUT_MINUTES,
          showMinMax: true,
          analysis, // only draw this analysis
        },
        target.path,
      );
      console.log(
        `Plotted the time per Wasm module of ${analysis} to ${target.path}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

// `commander` parses the command line: it checks that the CSV path and
// --output are given, prints --help, and then calls the `.action` function
// below with the path and the parsed options.
const program = new Command();
program
  .name('plot_wei_opt')
  .description(
    'Plot the runtime of Wasmito on WARDuino next to that of Whamm on the optimised Wizard engine (wei + wizard opt), per Wasm module, into PDF files in the --output directory. Reads the CSV of runtime_metrics_wasmito_wei.js.',
  )
  .argument(
    '<runtime-metrics-csv>',
    'the CSV written by runtime_metrics_wasmito_wei.js',
  )
  .requiredOption(
    '-o, --output <dir>',
    'the directory to store the plots in, created if it does not exist (required)',
  )
  .action((runtimeMetricsCsv, options) => {
    debugger;
    const outputDir = options.output;

    // -----------------------------------------------------------------------
    // 1. Check the arguments
    // -----------------------------------------------------------------------
    // program.error prints the message and exits the process.
    if (!isFilePath(runtimeMetricsCsv)) {
      program.error('<runtime-metrics-csv> is not a valid path to a CSV file');
    }
    if (fs.existsSync(outputDir) && !fs.statSync(outputDir).isDirectory()) {
      program.error(`--output '${outputDir}' is not a directory`);
    }

    // The plot helpers match the analyses of the two frameworks through
    // these pairs [Wasmito name, Whamm name]. Since applyAnalysisNames gives
    // both frameworks the plot names of ANALYSES, every analysis is paired
    // with itself.
    const pairs = ANALYSES.map(([, , plotName]) => [plotName, plotName]);

    // Any error below (e.g. a CSV with a missing column) is reported as one
    // message, after which the process exits.
    try {
      // ---------------------------------------------------------------------
      // 2. Read the metrics
      // ---------------------------------------------------------------------
      const tools = readTools(runtimeMetricsCsv);
      if (tools.length !== 2) {
        throw new Error(
          `'${runtimeMetricsCsv}' must contain the frameworks ${Object.keys(TOOL_COLOR_INDEX).join(' and ')}`,
        );
      }
      // Rename the analyses to their plot names and drop the others.
      applyAnalysisNames(tools);

      createDirectoryIfUnexisting(outputDir);

      // ---------------------------------------------------------------------
      // 3. The plots
      // ---------------------------------------------------------------------
      plotRelative(tools, pairs, outputDir);
      plotAbsolute(tools, pairs, outputDir);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : e;
      program.error(`Could not create plot, error occurred: ${errMsg}`);
    }
  });

// Parse the command line and run the action above.
program.parse();
