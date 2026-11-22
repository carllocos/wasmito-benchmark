#!/usr/bin/env node
// plot_runtimes.js
//
// Reads the runtime metrics of Wasmito and Whamm (wei) and, optionally, the
// phases of Wasmito, and plots them with Vega-Lite.
//
// For now only the runtime overhead is plotted (plotSlowdowns), like
// analysis/analysis_relative of scripts/plot_runtime.sh but with the
// overhead of section 4.4 of the paper: per analysis and Wasm module, the
// mean total time with the analysis divided by the mean total time without
// any analysis, on the same framework. It is written to
//   <dir>/analysis/analysis_relative.pdf             all analyses
//   <dir>/analysis/analysis_relative/<analysis>.pdf  one plot per analysis
// With [phases-metrics-csv], also how the total time of Wasmito splits into
// its phases (plotPhases), to <dir>/wasmito_phases/wasmito_phases.pdf.
// Also the absolute runtimes with and without analysis (plotBaselines), to
// <dir>/analysis/analysis_absolute.pdf, sized for one page of the paper.
// The other plot function (plotTimes) is still
// empty and disabled.
//
// This script only plots: it computes no statistics itself. It reads the
// CSVs written by the metrics scripts, so those run first:
//   1. runtime_metrics_wasmito_wei.js     the statistics of the times and
//                                         slowdowns of both frameworks
//      runtime_metrics_wasmito_phases.js  the mean time of every phase of
//                                         Wasmito (optional)
//   2. plot_runtimes.js                   the plots
//
// Usage:
//   node src/plot_runtimes.js --output <dir> <runtime-metrics-csv> \
//        [phases-metrics-csv]
// e.g.
//   node src/plot_runtimes.js \
//        --output bench_output/plots/runtimes \
//        bench_output/plots/runtime_wizard_opt/runtime_metrics.csv \
//        bench_output/plots/runtime_wizard_opt/phases_metrics.csv
//
// The data the plot functions get:
//
//   runtimes: Map<framework, Framework>, e.g. runtimes.get('wasmito'), where
//     Framework = {
//       framework: 'wasmito' | 'wei',
//       runtime:   'warduino' | 'wizard opt', the VM it ran on
//       baseline:  'no-analysis' | 'none', the name of the run without
//                  any analysis
//       cells:     Map<wasm, Map<analysis, Cell>>, in the order of the CSV
//     }
//     Cell = {
//       runs:       number of successful runs
//       failedRuns: number of failed runs
//       failure:    'timeout' | 'error' | undefined (no run failed)
//       time:       Stats of the times of the successful runs (ms), or
//                   undefined when every run failed
//       slowdown:   Stats of the slowdowns (time / median time of the
//                   baseline on the same Wasm module), or undefined when
//                   every run failed or the module has no baseline run
//     }
//     Stats = { mean, median, min, max, stdev, q1, q3 }
//
//   phases (only with [phases-metrics-csv]): Map<analysis, Map<wasm, Phases>>
//     Phases = {
//       runs:         number of successful runs
//       failure:      'timeout' | 'error' | undefined, as for a Cell; the
//                     means below are undefined when every run failed
//       means:        { parsing_ms, spawn_ms, register_ms, deploy_ms,
//                       run_ms }: the mean time of every phase (ms)
//       unattributed: mean of the time not in any phase (ms)
//       total:        mean total time (ms)
//     }

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import * as vega from 'vega';
import * as vegaLite from 'vega-lite';

// The statistics of the times and slowdowns in the runtime metrics CSV (the
// columns time_<stat> and slowdown_<stat>), see
// runtime_metrics_wasmito_wei.js.
const STATS = ['mean', 'median', 'min', 'max', 'stdev', 'q1', 'q3'];

// The file formats every plot is written in: 'pdf', 'svg' and 'png' are
// supported.
const PLOT_FORMATS = ['pdf'];

// A benchmark run is stopped after this many minutes; shown in the plots
// next to the T of runs that timed out.
const TIMEOUT_MINUTES = 10;

// The analyses to plot, one entry per analysis:
//   [<name in Wasmito>, <name in Whamm>, <name in the plots>]
// These are the analyses with which Gilbert et al. benchmarked wei (the
// Whamm column of the analyses table of the paper). The names in Wasmito
// and Whamm are those of the analysis column of the runtime metrics CSV.
// The panels follow the order of this list.
const ANALYSES = [
  ['basic-block', 'basic_blocks', 'basic-block'],
  ['branches', 'branches', 'branches'],
  ['cache_sim', 'cache_sim', 'cache_sim'],
  ['call-graph', 'call_graph', 'call-graph'],
  ['hotness', 'hotness', 'hotness'],
  ['icount', 'icount', 'icount'],
  ['imix', 'imix', 'instruction-mix'],
  ['instr-coverage', 'instr_coverage', 'instr-coverage'],
  ['loop_tracer', 'loop_tracer', 'loop_tracer'],
  ['mem_access', 'mem_access', 'mem_access'],
];

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

/** Returns `outputDir/name`, creating that directory if needed. */
function subdirectory(outputDir, name) {
  const dir = path.join(outputDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Reading the CSVs
// ---------------------------------------------------------------------------

/**
 * Reads a CSV into its rows, each an object from column name to value (all
 * strings). Throws when one of `requiredColumns` is missing. Empty lines and
 * lines starting with '#' (comments, e.g. a row commented out to leave it
 * out of the plots) are skipped. The CSVs contain no quoted fields, so
 * splitting on ',' is enough.
 */
function readCsv(csvPath, requiredColumns) {
  const lines = fs
    .readFileSync(csvPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  const header = (lines[0] ?? '').split(',');
  const missing = requiredColumns.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `'${csvPath}' is missing the column(s) ${missing.join(', ')}`,
    );
  }
  return lines.slice(1).map((line) => {
    const fields = line.split(',');
    return Object.fromEntries(header.map((c, i) => [c, fields[i] ?? '']));
  });
}

/** A number, or undefined for an empty field. */
function numberOrUndefined(field) {
  return field === '' ? undefined : Number(field);
}

/**
 * The Stats in the columns <prefix>_<stat> of `row`, e.g. time_mean, or
 * undefined when they are empty (every run failed).
 */
function statsOf(row, prefix) {
  if (row[`${prefix}_mean`] === '') return undefined;
  return Object.fromEntries(
    STATS.map((s) => [s, Number(row[`${prefix}_${s}`])]),
  );
}

/**
 * Reads the runtime metrics CSV (runtime_metrics_wasmito_wei.js) into a
 * Map<framework, Framework>, see the top of this file.
 */
function readRuntimes(csvPath) {
  const rows = readCsv(csvPath, [
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
  const runtimes = new Map();
  for (const row of rows) {
    const framework = runtimes.get(row.framework) ?? {
      framework: row.framework,
      runtime: row.runtime,
      baseline: row.baseline,
      cells: new Map(),
    };
    const perWasm = framework.cells.get(row.wasm) ?? new Map();
    perWasm.set(row.analysis, {
      runs: Number(row.runs),
      failedRuns: Number(row.failed_runs),
      failure: row.failure === '' ? undefined : row.failure,
      time: statsOf(row, 'time'),
      slowdown: statsOf(row, 'slowdown'),
    });
    framework.cells.set(row.wasm, perWasm);
    runtimes.set(row.framework, framework);
  }
  if (runtimes.size === 0) throw new Error(`'${csvPath}' contains no rows`);
  return runtimes;
}

/**
 * Reads the phases metrics CSV (runtime_metrics_wasmito_phases.js) into a
 * Map<analysis, Map<wasm, Phases>>, see the top of this file. The phases
 * are the columns <phase>_mean, e.g. spawn_ms_mean.
 */
function readPhases(csvPath) {
  const rows = readCsv(csvPath, [
    'analysis',
    'wasm',
    'runs',
    'failure',
    'unattributed_ms_mean',
    'total_ms_mean',
  ]);
  // The phase columns, e.g. spawn_ms_mean -> spawn_ms.
  const phaseNames = Object.keys(rows[0] ?? {})
    .filter(
      (c) =>
        c.endsWith('_mean') &&
        c !== 'unattributed_ms_mean' &&
        c !== 'total_ms_mean',
    )
    .map((c) => c.slice(0, -'_mean'.length));

  const phases = new Map();
  for (const row of rows) {
    const perAnalysis = phases.get(row.analysis) ?? new Map();
    perAnalysis.set(row.wasm, {
      runs: Number(row.runs),
      failure: row.failure === '' ? undefined : row.failure,
      means: Object.fromEntries(
        phaseNames.map((p) => [p, numberOrUndefined(row[`${p}_mean`])]),
      ),
      unattributed: numberOrUndefined(row.unattributed_ms_mean),
      total: numberOrUndefined(row.total_ms_mean),
    });
    phases.set(row.analysis, perAnalysis);
  }
  return phases;
}

// ---------------------------------------------------------------------------
// Plots (to be written)
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// The runtime overhead per analysis and Wasm module (paper, section 4.4)
// ---------------------------------------------------------------------------

// The overhead follows section 4.4 of the paper: the overhead of an analysis
// a on a module m is
//   mean total time of a on m / mean total time of m without any analysis
// where the baseline (the run without analysis) is that of the same
// framework: WARDuino for Wasmito, the optimised Wizard engine for wei.
// The whisker of a bar goes from the fastest to the slowest run, divided by
// the same baseline mean.

/**
 * Which analysis name of ANALYSES every framework uses: Wasmito the first,
 * wei (Whamm) the second.
 */
const ANALYSIS_NAME_INDEX = { wasmito: 0, wei: 1 };

/**
 * The colour of every framework: the same blue and green as the plots of
 * scripts/plot_runtime.sh.
 */
const FRAMEWORK_COLORS = { wasmito: '#0072b2', wei: '#009e73' };

// The title of the y-axis of the overhead plots.
// The titles of the y-axis of the overhead plots: of a single analysis, and
// of all analyses. × means "times": an overhead of 3× means that the run with
// the analysis takes 3 times as long as the run without it.
const OVERHEAD_TITLE = 'Runtime Overhead vs. baseline (×, log scale)';
const SHORT_OVERHEAD_TITLE = 'Runtime Overhead (×, log)';

// The x positions (pixels from the left of the first panel) of the legends
// of analysis_relative (all analyses), which are drawn inside the top of
// the first panel, right of its name: the frameworks and the T and E.
const LEGEND_INSIDE_X = [100, 330];

// The room (pixels) the overhead written above a bar needs; when there is
// less room between the bar and the top of its panel, it is written inside
// the bar instead.
const LABEL_HEIGHT = 30;

// The height of every panel of analysis_relative (all analyses).
const GRID_PANEL_HEIGHT = 120;

// The top of the y-axis of every row of panels of analysis_relative (all
// analyses), from the top row down; a row without one goes up to what its
// data needs. With two panels per row and the analyses of ANALYSES these
// are the rows basic_blocks/branches, cache_sim/call_graph, hotness/icount,
// imix/instr_coverage and loop_tracer/mem_access.
const ROW_Y_MAX = [20, 100, 200, 100, 500];

/**
 * The marker drawn instead of a bar when there is no overhead: T when the
 * runs (of the analysis or of the baseline) timed out, E when they failed
 * with an error, and – when there is no data at all.
 */
function failureMarker(cell) {
  if (cell?.failure === 'timeout') return 'T';
  if (cell?.failure === 'error') return 'E';
  return '–';
}

/** The legend entry of a framework, e.g. 'wasmito + warduino'. */
function frameworkLegend(framework) {
  return `${framework.framework} + ${framework.runtime}`;
}

/**
 * The data of the overhead plots, as a flat list of rows (the shape
 * Vega-Lite expects), one per analysis of ANALYSES, framework and Wasm
 * module:
 *   { analysis, wasm, framework, legend,
 *     overhead, min, max, top, label }   when there is an overhead
 *   { analysis, wasm, framework, legend,
 *     marker }                           when there is none (T, E or –)
 * where `top` is the highest point of the bar or its whisker (where its
 * value is written) and `label` the value written on it.
 * Analyses that no framework has are left out.
 */
function overheadRows(runtimes) {
  const frameworks = [...runtimes.values()];
  for (const f of frameworks) {
    if (!(f.framework in ANALYSIS_NAME_INDEX)) {
      throw new Error(`unknown framework '${f.framework}'`);
    }
  }
  // Every Wasm module of any framework, so that a module one framework
  // lacks still gets a marker.
  const wasms = [...new Set(frameworks.flatMap((f) => [...f.cells.keys()]))];

  const rows = [];
  for (const names of ANALYSES) {
    const plotName = names[2];
    const nameIn = (f) => names[ANALYSIS_NAME_INDEX[f.framework]];
    const hasAnalysis = frameworks.some((f) =>
      [...f.cells.values()].some((perWasm) => perWasm.has(nameIn(f))),
    );
    if (!hasAnalysis) continue;

    for (const f of frameworks) {
      for (const wasm of wasms) {
        const perWasm = f.cells.get(wasm);
        const cell = perWasm?.get(nameIn(f));
        const baseline = perWasm?.get(f.baseline);
        const row = {
          analysis: plotName,
          wasm: wasm.replace(/\.wasm$/, ''),
          framework: f.framework,
          legend: frameworkLegend(f),
        };
        if (cell?.time !== undefined && baseline?.time !== undefined) {
          const base = baseline.time.mean;
          row.overhead = cell.time.mean / base;
          row.min = cell.time.min / base;
          row.max = cell.time.max / base;
          row.top = Math.max(row.overhead, row.max);
          row.label = `${row.overhead.toFixed(2)}×`;
        } else {
          // No overhead: say why, for the analysis or else its baseline.
          row.marker = failureMarker(cell?.time === undefined ? cell : baseline);
        }
        rows.push(row);
      }
    }
  }
  return rows;
}

/**
 * The domain of the y-axis of the overhead plots of `rows`: from 1× (or the
 * lowest whisker, when a run was faster than the baseline) up to the highest
 * whisker, with room above it for the overhead written over the bar.
 */
function overheadDomain(rows) {
  const valid = rows.filter((r) => r.overhead !== undefined);
  const lowest = Math.min(1, ...valid.map((r) => r.min));
  const highest = Math.max(1, ...valid.map((r) => r.top));
  // The written overhead takes about as much room as a factor 4 on the
  // log axis of these plots.
  return [lowest, highest * 4];
}

/** The ticks 1, 2, 5, 10, 20, 50, ... (and 0.5, 0.2, ...) within `domain`. */
function overheadTicks([lo, hi]) {
  const ticks = [];
  for (let e = Math.floor(Math.log10(lo)); 10 ** e <= hi; e++) {
    for (const m of [1, 2, 5]) {
      const t = m * 10 ** e;
      if (t >= lo && t <= hi) ticks.push(t);
    }
  }
  return ticks;
}

/**
 * The Vega-Lite specification of one panel of an overhead plot: the rows of
 * one analysis, with per Wasm module a bar per framework from 1× to its
 * overhead, a whisker from min to max, the overhead written above it, and a
 * T, E or – where there is no bar. Options:
 *   domain, ticks   the y-axis (see overheadDomain and overheadTicks)
 *   yTitle          the title of the y-axis, or null for none
 *   yAxis           whether to draw the y-axis; without it, the panel
 *                   still gets the horizontal grid lines
 *   xLabels         whether to write the names of the Wasm modules
 *   width, height   the size of the plot area
 *   legendDomain, legendColors  the frameworks and their colours
 *   legendInside    draw the legends inside the top of the first panel
 *                   (see LEGEND_INSIDE_X) instead of above the plot
 *   nameInside      write the name of the analysis inside the top-left
 *                   corner of the panel instead of as a title above it, so
 *                   that it takes no space and is at the same height in
 *                   every panel
 */
function overheadPanel(rows, opts) {
  const { domain, ticks, legendDomain, legendColors } = opts;
  const hasOverhead = { filter: 'isValid(datum.overhead)' };
  // Whether the overhead written above a bar would stick out above the
  // panel: then it is written inside the top of the bar instead. The y
  // position of a value on the log axis, in pixels from the top:
  const [lo, hi] = domain;
  const pixelsFromTop = (v) =>
    (opts.height * Math.log(hi / v)) / Math.log(hi / lo);
  const panelRows = rows.map((r) =>
    r.overhead === undefined
      ? r
      : { ...r, labelInside: pixelsFromTop(r.top) < LABEL_HEIGHT },
  );
  // The y encoding of `field`, shared by every layer.
  const y = (field) => ({
    field,
    type: 'quantitative',
    scale: { type: 'log', domain, nice: false },
    title: opts.yTitle,
    axis: opts.yAxis
      ? {
          values: ticks,
          labelExpr: "format(datum.value, '~g') + '×'",
          // A fixed width for the ticks and their labels, so that the
          // titles of all panels line up whatever their labels.
          minExtent: 36,
          maxExtent: 36,
        }
      : // No axis line, ticks or labels, only the horizontal grid lines at
        // the same heights as in the panel with the axis.
        { values: ticks, grid: true, labels: false, ticks: false, domain: false },
  });

  // Where the legends go: above the plot, or (opts.legendInside) inside the
  // top of the first panel, right of its name, in the empty space above the
  // bars. `index` 0 is the legend of the frameworks, 1 the one of T and E.
  const legendPlace = (index) =>
    opts.legendInside
      ? {
          orient: 'none',
          legendX: LEGEND_INSIDE_X[index],
          legendY: 3,
          fillColor: 'white',
        }
      : { orient: 'top' };

  const name = rows[0].analysis;
  // The name of the analysis inside the panel, drawn once (its own data).
  const nameLayer = {
    data: { values: [{}] },
    mark: {
      type: 'text',
      align: 'left',
      baseline: 'top',
      fontSize: 11,
      fontWeight: 'bold',
    },
    encoding: {
      x: { value: 6 },
      y: { value: 4 },
      xOffset: { value: 0 },
      text: { value: name },
    },
  };

  return {
    ...(opts.nameInside
      ? {}
      : { title: { text: name, anchor: 'start', fontSize: 12, offset: 4 } }),
    data: { values: panelRows },
    width: opts.width,
    height: opts.height,
    encoding: {
      x: {
        field: 'wasm',
        type: 'nominal',
        title: null,
        axis: opts.xLabels
          ? { labelAngle: -45 }
          : // Only the ticks: the names are written under the bottom
            // panels, at the same positions.
            { labels: false },
      },
      // The bars of the frameworks next to each other per Wasm module.
      xOffset: {
        field: 'legend',
        type: 'nominal',
        scale: { domain: legendDomain },
      },
    },
    layer: [
      // The bars, from 1× (no overhead) to the overhead. They must start
      // at 1: on a log scale a bar from 0 is not drawn.
      {
        transform: [hasOverhead],
        mark: { type: 'bar' },
        encoding: {
          y: y('overhead'),
          y2: { datum: 1 },
          color: {
            field: 'legend',
            type: 'nominal',
            title: null,
            scale: { domain: legendDomain, range: legendColors },
            legend: {
              ...legendPlace(0),
              direction: 'horizontal',
              labelLimit: 0,
            },
          },
          tooltip: [
            { field: 'framework' },
            { field: 'wasm' },
            { field: 'overhead', format: '.2f' },
            { field: 'min', format: '.2f' },
            { field: 'max', format: '.2f' },
          ],
        },
      },
      // The whiskers, from the fastest to the slowest run, with caps.
      {
        transform: [hasOverhead],
        mark: { type: 'rule', color: 'black' },
        encoding: { y: y('min'), y2: { field: 'max' } },
      },
      {
        transform: [hasOverhead],
        mark: { type: 'tick', color: 'black', thickness: 1, size: 5 },
        encoding: { y: y('min') },
      },
      {
        transform: [hasOverhead],
        mark: { type: 'tick', color: 'black', thickness: 1, size: 5 },
        encoding: { y: y('max') },
      },
      // The overhead, written upwards above the bar and its whisker ...
      {
        transform: [hasOverhead, { filter: '!datum.labelInside' }],
        mark: {
          type: 'text',
          angle: -90,
          align: 'left',
          baseline: 'middle',
          dx: 3,
          fontSize: 7,
        },
        encoding: { y: y('top'), text: { field: 'label' } },
      },
      // ... or, when there is no room above it, downwards inside the top
      // of the bar, in white.
      {
        transform: [hasOverhead, { filter: 'datum.labelInside' }],
        mark: {
          type: 'text',
          angle: -90,
          align: 'right',
          baseline: 'middle',
          dx: -3,
          fontSize: 7,
          color: 'white',
        },
        encoding: { y: y('overhead'), text: { field: 'label' } },
      },
      // The T, E or – where there is no bar. The opacity channel (always
      // 1) only serves to get a second legend, next to the one of the
      // colours, that explains T and E (not –: there is normally no
      // missing data).
      {
        transform: [{ filter: 'isValid(datum.marker)' }],
        mark: {
          type: 'text',
          baseline: 'bottom',
          dy: -2,
          fontSize: 10,
          fontWeight: 'bold',
        },
        encoding: {
          y: { datum: 1 },
          text: { field: 'marker' },
          opacity: {
            field: 'marker',
            type: 'ordinal',
            sort: ['T', 'E', '–'],
            scale: { domain: ['T', 'E', '–'], range: [1, 1, 1] },
            legend: {
              ...legendPlace(1),
              direction: 'horizontal',
              title: null,
              values: ['T', 'E'],
              symbolOpacity: 0,
              symbolSize: 0,
              labelLimit: 0,
              labelExpr: `datum.label === 'T' ? 'T  timed out (${TIMEOUT_MINUTES} min)' : 'E  failed with an error'`,
            },
          },
        },
      },
      ...(opts.nameInside ? [nameLayer] : []),
    ],
  };
}

/** The frameworks of `rows`, in their order, and their colours. */
function legendOf(rows) {
  const legends = [...new Map(rows.map((r) => [r.legend, r.framework]))];
  return {
    legendDomain: legends.map(([legend]) => legend),
    legendColors: legends.map(([, f]) => FRAMEWORK_COLORS[f]),
  };
}

/** What every overhead plot specification starts with. */
const OVERHEAD_SPEC_BASE = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  background: 'white',
  config: { view: { stroke: '#dddddd' } },
};

/**
 * The Vega-Lite specification of the overhead plot of one analysis: one
 * panel with its own axes, sized to its data.
 */
function overheadSpec(rows) {
  const domain = overheadDomain(rows);
  return {
    ...OVERHEAD_SPEC_BASE,
    ...overheadPanel(rows, {
      domain,
      ticks: overheadTicks(domain),
      yTitle: OVERHEAD_TITLE,
      yAxis: true,
      xLabels: true,
      width: 560,
      height: 160,
      ...legendOf(rows),
    }),
  };
}

/**
 * The Vega-Lite specification of the overhead plot of all analyses: one
 * panel per analysis, `columns` next to each other, in the order of
 * ANALYSES, packed closely:
 *   - the panels of a row share their y-axis, up to ROW_Y_MAX of that row
 *     (or, without one, up to what the data of the row needs); it is drawn
 *     only left of the first panel of the row;
 *   - its title is written once, left of the middle row, for all panels;
 *   - the names of the Wasm modules are written only under the bottom
 *     panels; the other panels have ticks at the same positions.
 */
function overheadGridSpec(rows, columns) {
  const analyses = [...new Set(rows.map((r) => r.analysis))];
  const rowCount = Math.ceil(analyses.length / columns);
  const height = GRID_PANEL_HEIGHT;
  // Room between the rows for the overheads written above the highest bars.
  const rowGap = 12;
  // The title of the y-axis goes left of the middle row; with an even
  // number of rows, it is moved down to between the two middle rows.
  const titleRow = Math.floor((rowCount - 1) / 2);
  const titleShift = rowCount % 2 === 0 ? (height + rowGap) / 2 : 0;

  const panels = analyses.map((analysis, i) => {
    const row = Math.floor(i / columns);
    const rowAnalyses = analyses.slice(row * columns, (row + 1) * columns);
    const rowRows = rows.filter((r) => rowAnalyses.includes(r.analysis));
    const auto = overheadDomain(rowRows);
    const domain = [auto[0], ROW_Y_MAX[row] ?? auto[1]];
    const isTitled = row === titleRow && i % columns === 0;
    const panel = overheadPanel(
      rows.filter((r) => r.analysis === analysis),
      {
        domain,
        ticks: overheadTicks(domain),
        yTitle: isTitled ? SHORT_OVERHEAD_TITLE : null,
        yAxis: i % columns === 0,
        xLabels: row === rowCount - 1,
        width: 560,
        height,
        nameInside: true,
        legendInside: true,
        ...legendOf(rows),
      },
    );
    if (isTitled && titleShift !== 0) {
      // Move the title down by titleShift from the middle of its panel.
      for (const layer of panel.layer) {
        const axis = layer.encoding.y?.axis;
        if (axis) axis.titleY = height / 2 + titleShift;
      }
    }
    return panel;
  });

  return {
    ...OVERHEAD_SPEC_BASE,
    concat: panels,
    columns,
    spacing: { row: rowGap, column: 16 },
    // Lay the panels out by their plot areas only, so that they line up
    // exactly; their axes and titles stick out into the spacing.
    bounds: 'flush',
    // Every row has its own y-axis.
    resolve: { scale: { y: 'independent' } },
  };
}

/**
 * Renders the Vega-Lite `spec` without a browser and writes it to
 * `<basePath>.<format>` for every format of PLOT_FORMATS: SVG directly, PDF
 * and PNG drawn by the `canvas` package.
 */
async function writeVegaLitePlot(spec, basePath) {
  const view = new vega.View(vega.parse(vegaLite.compile(spec).spec), {
    renderer: 'none',
  });
  for (const format of PLOT_FORMATS) {
    const target = `${basePath}.${format}`;
    if (format === 'svg') {
      fs.writeFileSync(target, await view.toSVG());
    } else if (format === 'png') {
      const canvas = await view.toCanvas(2);
      fs.writeFileSync(target, canvas.toBuffer('image/png'));
    } else {
      const canvas = await view.toCanvas(1, { type: 'pdf' });
      fs.writeFileSync(target, canvas.toBuffer());
    }
    console.log(`Plotted to ${target}`);
  }
  view.finalize();
}

/**
 * Plots the runtime overhead of every analysis per Wasm module, for Wasmito
 * and wei next to each other, like analysis/analysis_relative of
 * scripts/plot_runtime.sh, but with the overhead of the paper (see above):
 *   <outputDir>/analysis_relative.*              all analyses, one panel each
 *   <outputDir>/analysis_relative/<analysis>.*   one plot per analysis
 */
async function plotSlowdowns(runtimes, outputDir) {
  // debugger;

  const rows = overheadRows(runtimes);
  if (rows.length === 0) throw new Error('There is no data to plot');

  // All analyses together, two panels next to each other, sharing the
  // names of the Wasm modules at the bottom.
  await writeVegaLitePlot(
    overheadFigureSpec(rows),
    path.join(outputDir, 'analysis_relative'),
  );

  // Every analysis on its own.
  const perAnalysisDir = subdirectory(outputDir, 'analysis_relative');
  for (const analysis of [...new Set(rows.map((r) => r.analysis))]) {
    await writeVegaLitePlot(
      overheadSpec(rows.filter((r) => r.analysis === analysis)),
      path.join(perAnalysisDir, analysis),
    );
  }
}

/**
 * Plots the measured times of every analysis per Wasm module (Cell.time).
 */
function plotTimes(runtimes, outputDir) {
  // TODO
}

// ---------------------------------------------------------------------------
// The phases of Wasmito's total time (paper, section 4.4, wasmito_phases)
// ---------------------------------------------------------------------------

/**
 * The phases of a Wasmito run, bottom to top in a stack: the column of the
 * phases metrics CSV (without _mean), the name in the legend, and the
 * colour (the same as in the wasmito_phases plot of scripts/plot_runtime.sh).
 */
const PHASES = [
  ['parsing_ms', 'parse wasm', '#0072b2'],
  ['spawn_ms', 'spawn', '#e69f00'],
  ['register_ms', 'register advices', '#009e73'],
  ['deploy_ms', 'deploy hooks', '#d55e00'],
  ['run_ms', 'run analysis', '#56b4e9'],
];

// The title of the y-axis of the phases plot.
const PHASES_TITLE = 'Phases Percentage Execution Time (%)';

// The height of every panel of the phases plot.
const PHASES_PANEL_HEIGHT = 120;

// The share of the total time is written next to a segment of a stack only
// when the segment is at least this big; smaller ones have too little room.
const MIN_LABELED_SHARE = 0.04;

// The width of a stack, in pixels.
const STACK_WIDTH = 14;

/** A share of the total time as a percentage: '<1%', '4%', '85%'. */
function percentLabel(share) {
  return share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`;
}

/** A duration in ms written above a stack, in seconds: '1.19 s'. */
function secondsLabel(ms) {
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * The data of the phases plot, as a flat list of rows, one kind per layer:
 *   { kind: 'segment', analysis, wasm, phase, start, end, mid, share, label }
 *       one phase of a stack: from `start` to `end` (shares of the total
 *       time, 0 to 1), with its label at `mid`
 *   { kind: 'total', analysis, wasm, label }
 *       the mean total time, written above the stack
 *   { kind: 'marker', analysis, wasm, marker }
 *       T, E or – instead of a stack
 * The analyses are those of ANALYSES that Wasmito has (by their name in the
 * plots), in that order, and the baseline is left out.
 */
function phaseRows(phases) {
  const wasms = [
    ...new Set([...phases.values()].flatMap((m) => [...m.keys()])),
  ].sort();
  const rows = [];
  for (const [wasmitoName, , plotName] of ANALYSES) {
    const perWasm = phases.get(wasmitoName);
    if (perWasm === undefined) continue;
    for (const wasmFile of wasms) {
      const p = perWasm.get(wasmFile);
      const base = { analysis: plotName, wasm: wasmFile.replace(/\.wasm$/, '') };
      if (p === undefined || p.total === undefined) {
        // No successful run: why (see failureMarker).
        rows.push({ ...base, kind: 'marker', marker: failureMarker(p) });
        continue;
      }
      rows.push({ ...base, kind: 'total', label: secondsLabel(p.total) });
      let start = 0;
      for (const [column, phase] of PHASES) {
        const share = (p.means[column] ?? 0) / p.total;
        if (share <= 0) continue;
        const end = start + share;
        rows.push({
          ...base,
          kind: 'segment',
          phase,
          start,
          end,
          mid: (start + end) / 2,
          share,
          label: share >= MIN_LABELED_SHARE ? percentLabel(share) : '',
        });
        start = end;
      }
    }
  }
  return rows;
}

/**
 * The Vega-Lite specification of one panel of the phases plot: the rows of
 * one analysis, with per Wasm module a stack of its phases, their shares
 * written next to it, and the mean total time above it, or a T, E or –.
 * Options: yTitle (or null), yAxis, xLabels (see overheadPanel).
 */
function phasePanel(rows, opts) {
  const y = (field) => ({
    field,
    type: 'quantitative',
    scale: { domain: [0, 1], nice: false },
    title: opts.yTitle,
    axis: {
      values: [0, 0.25, 0.5, 0.75, 1],
      format: '.0%',
      grid: true,
      // Keep every label: Vega would drop some it deems too close.
      labelOverlap: false,
      // A fixed width, so that all panels line up (see overheadPanel).
      minExtent: 36,
      maxExtent: 36,
      ...(opts.yAxis ? {} : { labels: false, ticks: false, domain: false }),
    },
  });
  // The y encoding of a fixed value: with the same axis, or Vega-Lite would
  // fall back to its default ticks (0%, 50%, 100%).
  const yDatum = (value) => {
    const { field, ...rest } = y('');
    return { ...rest, datum: value };
  };
  const kind = (k) => ({ filter: `datum.kind === '${k}'` });

  return {
    data: { values: rows },
    width: 560,
    height: PHASES_PANEL_HEIGHT,
    encoding: {
      x: {
        field: 'wasm',
        type: 'nominal',
        title: null,
        axis: opts.xLabels ? { labelAngle: -45 } : { labels: false },
      },
    },
    layer: [
      // The stacks, one segment per phase.
      {
        transform: [kind('segment')],
        mark: { type: 'bar', width: STACK_WIDTH },
        encoding: {
          y: y('start'),
          y2: { field: 'end' },
          color: {
            field: 'phase',
            type: 'nominal',
            title: null,
            scale: {
              domain: PHASES.map(([, phase]) => phase),
              range: PHASES.map(([, , color]) => color),
            },
            legend: { orient: 'top', direction: 'horizontal', labelLimit: 0 },
          },
          tooltip: [
            { field: 'wasm' },
            { field: 'phase' },
            { field: 'share', format: '.1%' },
          ],
        },
      },
      // The share of every (big enough) segment, right of the stack.
      {
        transform: [kind('segment')],
        mark: {
          type: 'text',
          align: 'left',
          baseline: 'middle',
          dx: STACK_WIDTH / 2 + 2,
          fontSize: 7,
        },
        encoding: { y: y('mid'), text: { field: 'label' } },
      },
      // The mean total time, above the stack.
      {
        transform: [kind('total')],
        mark: { type: 'text', baseline: 'bottom', dy: -2, fontSize: 7 },
        encoding: { y: yDatum(1), text: { field: 'label' } },
      },
      // The name of the analysis, above the panel and the total times. A
      // text mark at a fixed position rather than a title: a title is placed
      // above everything drawn around the panel, so the y-axis title (taller
      // than the panel) would push it down.
      {
        data: { values: [{}] },
        mark: {
          type: 'text',
          align: 'left',
          baseline: 'bottom',
          fontSize: 12,
          fontWeight: 'bold',
        },
        encoding: {
          x: { value: 0 },
          y: { value: -14 },
          text: { value: rows[0].analysis },
        },
      },
      // The T, E or – instead of a stack, with its legend (see
      // overheadPanel).
      {
        transform: [kind('marker')],
        mark: {
          type: 'text',
          baseline: 'bottom',
          dy: -2,
          fontSize: 10,
          fontWeight: 'bold',
        },
        encoding: {
          y: yDatum(0),
          text: { field: 'marker' },
          opacity: {
            field: 'marker',
            type: 'ordinal',
            sort: ['T', 'E', '–'],
            scale: { domain: ['T', 'E', '–'], range: [1, 1, 1] },
            legend: {
              orient: 'top',
              direction: 'horizontal',
              title: null,
              values: ['T', 'E'],
              symbolOpacity: 0,
              symbolSize: 0,
              labelLimit: 0,
              labelExpr: `datum.label === 'T' ? 'T  timed out (${TIMEOUT_MINUTES} min)' : 'E  failed with an error'`,
            },
          },
        },
      },
    ],
  };
}

/**
 * The Vega-Lite specification of the phases plot: one panel per analysis,
 * `columns` next to each other, laid out like analysis_relative (see
 * overheadGridSpec): the y-axis title once, left of the middle row, the
 * names of the Wasm modules only under the bottom panels.
 */
function phaseGridSpec(rows, columns) {
  const analyses = [...new Set(rows.map((r) => r.analysis))];
  const rowCount = Math.ceil(analyses.length / columns);
  // Room between the rows for the name of the analysis and the total times.
  const rowGap = 46;
  const titleRow = Math.floor((rowCount - 1) / 2);
  const titleShift =
    rowCount % 2 === 0 ? (PHASES_PANEL_HEIGHT + rowGap) / 2 : 0;

  const panels = analyses.map((analysis, i) => {
    const row = Math.floor(i / columns);
    const isTitled = row === titleRow && i % columns === 0;
    const panel = phasePanel(
      rows.filter((r) => r.analysis === analysis),
      {
        yTitle: isTitled ? PHASES_TITLE : null,
        yAxis: i % columns === 0,
        xLabels: row === rowCount - 1,
      },
    );
    if (isTitled && titleShift !== 0) {
      for (const layer of panel.layer) {
        const axis = layer.encoding.y?.axis;
        if (axis) axis.titleY = PHASES_PANEL_HEIGHT / 2 + titleShift;
      }
    }
    return panel;
  });

  return {
    ...OVERHEAD_SPEC_BASE,
    concat: panels,
    columns,
    spacing: { row: rowGap, column: 16 },
    bounds: 'flush',
  };
}

/**
 * Plots how the mean total time of Wasmito splits into its phases (parse
 * the Wasm module, spawn the VM, register the advices, deploy the hooks,
 * run the analysis), per analysis and Wasm module, like
 * wasmito_phases/wasmito_phases of scripts/plot_runtime.sh, in the style of
 * analysis_relative:
 *   <outputDir>/wasmito_phases.*
 */
async function plotPhases(phases, outputDir) {
  const rows = phaseRows(phases);
  if (rows.length === 0) throw new Error('There is no data to plot');
  await writeVegaLitePlot(
    phasesFigureSpec(rows),
    path.join(outputDir, 'wasmito_phases'),
  );
}

// ---------------------------------------------------------------------------
// The figures of the paper: analysis_relative and wasmito_phases
// ---------------------------------------------------------------------------

// Both figures are drawn at the size they have in the paper, so that they are
// included without scaling and their text keeps its size:
//   \includegraphics[width=\textwidth]{figures/analysis_relative.pdf}
// One unit of these plots is one point (pt) of the PDF. They are
// FIGURE_WIDTH wide and, with these sizes, about 280pt high: with the
// caption, at most half of a page (\textheight is 632pt).

// \textwidth of the paper (lipics-v2021), in pt.
const FIGURE_WIDTH = 398;
// Panels next to each other.
const FIGURE_COLUMNS = 2;
// The height of the plot area of a panel.
const FIGURE_PANEL_HEIGHT = 32;
// Space between two panels next to each other.
const FIGURE_COLUMN_GAP = 8;
// Space between two rows of panels, which holds the name of the analysis.
const FIGURE_ROW_GAP = 12;
// Room left of the first column for the y-axis title, ticks and labels.
const FIGURE_Y_AXIS_WIDTH = 41;
// The width of the plot area of a panel, so that the figure is FIGURE_WIDTH
// wide.
const FIGURE_PANEL_WIDTH =
  (FIGURE_WIDTH - FIGURE_Y_AXIS_WIDTH - (FIGURE_COLUMNS - 1) * FIGURE_COLUMN_GAP) /
  FIGURE_COLUMNS;
// Font sizes: the labels, and the names of the analyses and axis titles.
const FIGURE_FONT_SIZE = 6;
const FIGURE_TITLE_FONT_SIZE = 7;
// The width of a stack of the phases figure.
const FIGURE_STACK_WIDTH = 7;

// The grid of analysis_relative and wasmito_phases (see figurePlace).
const FIGURE_LAYOUT = {
  columns: FIGURE_COLUMNS,
  panelWidth: FIGURE_PANEL_WIDTH,
  panelHeight: FIGURE_PANEL_HEIGHT,
  rowGap: FIGURE_ROW_GAP,
  columnGap: FIGURE_COLUMN_GAP,
};

// The Vega-Lite configuration of both figures: small fonts and tight
// spacing.
const FIGURE_CONFIG = {
  view: { stroke: '#dddddd' },
  axis: {
    labelFontSize: FIGURE_FONT_SIZE,
    titleFontSize: FIGURE_TITLE_FONT_SIZE,
    tickSize: 3,
    labelPadding: 2,
    titlePadding: 3,
  },
  legend: {
    labelFontSize: FIGURE_FONT_SIZE,
    symbolSize: 25,
    labelOffset: 2,
    columnPadding: 3,
    padding: 0,
    offset: 4,
  },
};

/**
 * Where panel `index` of `count` goes in the grid of a figure, and what it
 * shows: the y-axis labels only in the first column, the names of the Wasm
 * modules only in the bottom row, and the y-axis title only left of the
 * middle row (with an even number of rows, moved down to between the two
 * middle rows by `titleShift`).
 */
function figurePlace(index, count, layout = FIGURE_LAYOUT) {
  const rowCount = Math.ceil(count / layout.columns);
  const row = Math.floor(index / layout.columns);
  const first = index % layout.columns === 0;
  return {
    row,
    first,
    bottom: row === rowCount - 1,
    titled: first && row === Math.floor((rowCount - 1) / 2),
    titleShift:
      rowCount % 2 === 0 ? (layout.panelHeight + layout.rowGap) / 2 : 0,
    panelHeight: layout.panelHeight,
  };
}

/**
 * The y-axis of a panel of a figure at `place` (see figurePlace): `ticks`
 * labelled by `labelExpr` in the first column, only grid lines elsewhere,
 * and `title` left of the middle row.
 */
function figureYAxis(place, ticks, labelExpr, title) {
  return {
    title: place.titled ? title : null,
    axis: place.first
      ? {
          values: ticks,
          labelExpr,
          labelOverlap: false,
          grid: true,
          ...(place.titled && place.titleShift !== 0
            ? { titleY: place.panelHeight / 2 + place.titleShift }
            : {}),
        }
      : { values: ticks, grid: true, labels: false, ticks: false, domain: false },
  };
}

/** The x encoding of a panel of a figure: the names only in the bottom row. */
function figureX(place) {
  return {
    field: 'wasm',
    type: 'nominal',
    title: null,
    axis: place.bottom ? { labelAngle: -45 } : { labels: false },
  };
}

/** The name of the analysis, written just above its panel. */
function figureNameLayer(name) {
  return {
    data: { values: [{}] },
    mark: {
      type: 'text',
      align: 'left',
      baseline: 'bottom',
      fontSize: FIGURE_TITLE_FONT_SIZE,
      fontWeight: 'bold',
    },
    encoding: {
      x: { value: 0 },
      y: { value: -1 },
      xOffset: { value: 0 },
      text: { value: name },
    },
  };
}

/**
 * The T or E (or –) instead of a bar, at `y`, with the legend that explains
 * T and E (see overheadPanel).
 */
function figureMarkerLayer(transform, y) {
  return {
    transform,
    mark: {
      type: 'text',
      baseline: 'bottom',
      dy: -1,
      fontSize: FIGURE_FONT_SIZE,
      fontWeight: 'bold',
    },
    encoding: {
      y,
      text: { field: 'marker' },
      opacity: {
        field: 'marker',
        type: 'ordinal',
        sort: ['T', 'E', '–'],
        scale: { domain: ['T', 'E', '–'], range: [1, 1, 1] },
        legend: {
          orient: 'top',
          direction: 'horizontal',
          title: null,
          values: ['T', 'E'],
          symbolOpacity: 0,
          symbolSize: 0,
          labelLimit: 0,
          labelExpr: `datum.label === 'T' ? 'T timed out (${TIMEOUT_MINUTES} min)' : 'E failed with an error'`,
        },
      },
    },
  };
}

/** A figure made of `panels`, laid out in a grid as `layout` says. */
function figureSpec(panels, layout = FIGURE_LAYOUT) {
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    background: 'white',
    concat: panels,
    columns: layout.columns,
    spacing: { row: layout.rowGap, column: layout.columnGap },
    // Lay the panels out by their plot areas only, so that they line up
    // exactly; axes and names stick out into the spacing.
    bounds: 'flush',
    // Every row of the overhead figure has its own y-axis.
    resolve: { scale: { y: 'independent' } },
    config: FIGURE_CONFIG,
  };
}

/** The ticks 1, 10, 100, ... within `domain`: few enough for small panels. */
function decadeTicks([lo, hi]) {
  const ticks = [];
  for (let t = 1; t <= hi; t *= 10) if (t >= lo) ticks.push(t);
  return ticks;
}

/**
 * Figure analysis_relative of the paper: per analysis a panel with, per
 * Wasm module, a bar per framework from 1× to its overhead, a whisker from
 * the fastest to the slowest run, and a T or E where there is no bar. The
 * panels of a row share their y-axis, up to ROW_Y_MAX of that row. The
 * overheads are not written on the bars: there is no room for them at this
 * size.
 */
function overheadFigureSpec(rows) {
  const analyses = [...new Set(rows.map((r) => r.analysis))];
  const { legendDomain, legendColors } = legendOf(rows);

  const panels = analyses.map((analysis, i) => {
    const place = figurePlace(i, analyses.length);
    const rowAnalyses = analyses.slice(
      place.row * FIGURE_COLUMNS,
      (place.row + 1) * FIGURE_COLUMNS,
    );
    const auto = overheadDomain(
      rows.filter((r) => rowAnalyses.includes(r.analysis)),
    );
    const domain = [auto[0], ROW_Y_MAX[place.row] ?? auto[1]];
    const axis = figureYAxis(
      place,
      decadeTicks(domain),
      "format(datum.value, '~g') + '×'",
      SHORT_OVERHEAD_TITLE,
    );
    const scale = { type: 'log', domain, nice: false };
    const y = (field) => ({ field, type: 'quantitative', scale, ...axis });
    const hasOverhead = { filter: 'isValid(datum.overhead)' };

    return {
      data: { values: rows.filter((r) => r.analysis === analysis) },
      width: FIGURE_PANEL_WIDTH,
      height: FIGURE_PANEL_HEIGHT,
      encoding: {
        x: figureX(place),
        xOffset: {
          field: 'legend',
          type: 'nominal',
          scale: { domain: legendDomain },
        },
      },
      layer: [
        // The bars, from 1× (see overheadPanel).
        {
          transform: [hasOverhead],
          mark: { type: 'bar' },
          encoding: {
            y: y('overhead'),
            y2: { datum: 1 },
            color: {
              field: 'legend',
              type: 'nominal',
              title: null,
              scale: { domain: legendDomain, range: legendColors },
              legend: { orient: 'top', direction: 'horizontal', labelLimit: 0 },
            },
          },
        },
        // The whiskers, from the fastest to the slowest run.
        {
          transform: [hasOverhead],
          mark: { type: 'rule', color: 'black', strokeWidth: 0.5 },
          encoding: { y: y('min'), y2: { field: 'max' } },
        },
        figureMarkerLayer(
          [{ filter: 'isValid(datum.marker)' }],
          { datum: 1, type: 'quantitative', scale, ...axis },
        ),
        figureNameLayer(analysis),
      ],
    };
  });
  return figureSpec(panels);
}

/**
 * Figure wasmito_phases of the paper: per analysis a panel with, per Wasm
 * module, a stack of the share of every phase in the mean total time, or a
 * T or E. The shares and total times are not written next to the stacks:
 * there is no room for them at this size.
 */
function phasesFigureSpec(rows) {
  const analyses = [...new Set(rows.map((r) => r.analysis))];

  const panels = analyses.map((analysis, i) => {
    const place = figurePlace(i, analyses.length);
    const axis = figureYAxis(
      place,
      [0, 0.5, 1],
      "format(datum.value, '.0%')",
      PHASES_TITLE,
    );
    const scale = { domain: [0, 1], nice: false };
    const kind = (k) => ({ filter: `datum.kind === '${k}'` });

    return {
      data: { values: rows.filter((r) => r.analysis === analysis) },
      width: FIGURE_PANEL_WIDTH,
      height: FIGURE_PANEL_HEIGHT,
      encoding: { x: figureX(place) },
      layer: [
        // The stacks, one segment per phase.
        {
          transform: [kind('segment')],
          mark: { type: 'bar', width: FIGURE_STACK_WIDTH },
          encoding: {
            y: { field: 'start', type: 'quantitative', scale, ...axis },
            y2: { field: 'end' },
            color: {
              field: 'phase',
              type: 'nominal',
              title: null,
              scale: {
                domain: PHASES.map(([, phase]) => phase),
                range: PHASES.map(([, , color]) => color),
              },
              legend: { orient: 'top', direction: 'horizontal', labelLimit: 0 },
            },
          },
        },
        figureMarkerLayer(
          [kind('marker')],
          { datum: 0, type: 'quantitative', scale, ...axis },
        ),
        figureNameLayer(analysis),
      ],
    };
  });
  return figureSpec(panels);
}

// ---------------------------------------------------------------------------
// The absolute runtimes, with and without analysis (analysis_absolute)
// ---------------------------------------------------------------------------

// The layout of analysis_absolute: a full page of the paper (\textheight is
// 632pt), one panel per row, so that the four bars of every Wasm module
// stay readable. Included with \includegraphics[width=\textwidth].
const PAGE_LAYOUT = {
  columns: 1,
  panelWidth: FIGURE_WIDTH - FIGURE_Y_AXIS_WIDTH,
  panelHeight: 40,
  rowGap: FIGURE_ROW_GAP,
  columnGap: FIGURE_COLUMN_GAP,
};

// The title of the y-axis of analysis_absolute.
const RUNTIME_TITLE = 'Runtime (s, log)';

// A lighter tint of every framework colour, for the runs without analysis.
const FRAMEWORK_BASELINE_COLORS = { wasmito: '#7fb8d8', wei: '#7fcfb9' };

/**
 * The data of analysis_absolute, as a flat list of rows, per analysis of
 * ANALYSES, framework and Wasm module two bars, the run without analysis
 * (the baseline) and the run with it:
 *   { analysis, wasm, series, framework, baseline, time, min, max }
 *       a bar: the mean time and the fastest and slowest run, in seconds
 *   { analysis, wasm, series, marker }
 *       T, E or – instead of a bar
 * where `series` is the legend entry, e.g. 'warduino, no analysis' or
 * 'wasmito + warduino, with analysis'.
 */
function absoluteRows(runtimes) {
  const frameworks = [...runtimes.values()];
  const wasms = [...new Set(frameworks.flatMap((f) => [...f.cells.keys()]))];
  const rows = [];
  for (const names of ANALYSES) {
    const plotName = names[2];
    const nameIn = (f) => names[ANALYSIS_NAME_INDEX[f.framework]];
    const hasAnalysis = frameworks.some((f) =>
      [...f.cells.values()].some((perWasm) => perWasm.has(nameIn(f))),
    );
    if (!hasAnalysis) continue;

    for (const f of frameworks) {
      for (const wasm of wasms) {
        for (const baseline of [true, false]) {
          const cell = f.cells
            .get(wasm)
            ?.get(baseline ? f.baseline : nameIn(f));
          const row = {
            analysis: plotName,
            wasm: wasm.replace(/\.wasm$/, ''),
            framework: f.framework,
            baseline,
            // Without analysis only the VM runs, so the baseline is named
            // after the VM alone, e.g. 'warduino, no analysis'.
            series: baseline
              ? `${f.runtime}, no analysis`
              : `${frameworkLegend(f)}, with analysis`,
          };
          if (cell?.time !== undefined) {
            row.time = cell.time.mean / 1000;
            row.min = cell.time.min / 1000;
            row.max = cell.time.max / 1000;
          } else {
            row.marker = failureMarker(cell);
          }
          rows.push(row);
        }
      }
    }
  }
  return rows;
}

/**
 * Figure analysis_absolute: per analysis a panel with, per Wasm module and
 * framework, a lighter bar with the mean time of the run without analysis
 * and a darker bar with the mean time of the run with the analysis, a
 * whisker from the fastest to the slowest run, and a T or E where there is
 * no bar. All panels share one log y-axis, in seconds.
 */
function absoluteFigureSpec(rows) {
  const analyses = [...new Set(rows.map((r) => r.analysis))];
  // The four bars of a Wasm module, left to right, and their colours.
  const series = [...new Map(rows.map((r) => [r.series, r]))].map(
    ([name, r]) => ({
      name,
      color: (r.baseline ? FRAMEWORK_BASELINE_COLORS : FRAMEWORK_COLORS)[
        r.framework
      ],
    }),
  );
  const seriesDomain = series.map((s) => s.name);
  // One axis for all panels: from the fastest run up to the slowest.
  const timed = rows.filter((r) => r.time !== undefined);
  const lo = 10 ** Math.floor(Math.log10(Math.min(...timed.map((r) => r.min))));
  const hi = Math.max(...timed.map((r) => r.max)) * 1.2;
  const domain = [lo, hi];
  const ticks = [];
  for (let t = lo; t <= hi; t *= 10) ticks.push(t);

  const panels = analyses.map((analysis, i) => {
    const place = figurePlace(i, analyses.length, PAGE_LAYOUT);
    const axis = figureYAxis(
      place,
      ticks,
      "format(datum.value, '~g') + ' s'",
      RUNTIME_TITLE,
    );
    const scale = { type: 'log', domain, nice: false };
    const y = (field) => ({ field, type: 'quantitative', scale, ...axis });
    const hasTime = { filter: 'isValid(datum.time)' };

    return {
      data: { values: rows.filter((r) => r.analysis === analysis) },
      width: PAGE_LAYOUT.panelWidth,
      height: PAGE_LAYOUT.panelHeight,
      encoding: {
        x: figureX(place),
        xOffset: {
          field: 'series',
          type: 'nominal',
          scale: { domain: seriesDomain },
        },
      },
      layer: [
        // The bars, from the bottom of the axis up to the mean time.
        {
          transform: [hasTime],
          mark: { type: 'bar' },
          encoding: {
            y: y('time'),
            y2: { datum: lo },
            color: {
              field: 'series',
              type: 'nominal',
              title: null,
              scale: {
                domain: seriesDomain,
                range: series.map((s) => s.color),
              },
              legend: {
                orient: 'top',
                direction: 'horizontal',
                columns: 2,
                labelLimit: 0,
              },
            },
          },
        },
        // The whiskers, from the fastest to the slowest run.
        {
          transform: [hasTime],
          mark: { type: 'rule', color: 'black', strokeWidth: 0.5 },
          encoding: { y: y('min'), y2: { field: 'max' } },
        },
        figureMarkerLayer(
          [{ filter: 'isValid(datum.marker)' }],
          { datum: lo, type: 'quantitative', scale, ...axis },
        ),
        figureNameLayer(analysis),
      ],
    };
  });
  return figureSpec(panels, PAGE_LAYOUT);
}

/**
 * Plots the absolute runtimes of every analysis per Wasm module, next to the
 * runtimes without any analysis (the baselines), for Wasmito and wei, like
 * analysis/analysis_absolute of scripts/plot_runtime.sh, sized for one page
 * of the paper (the appendix on absolute runtimes):
 *   <outputDir>/analysis_absolute.*
 */
async function plotBaselines(runtimes, outputDir) {
  const rows = absoluteRows(runtimes);
  if (rows.length === 0) throw new Error('There is no data to plot');
  await writeVegaLitePlot(
    absoluteFigureSpec(rows),
    path.join(outputDir, 'analysis_absolute'),
  );
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

// `commander` parses the command line: it checks that the runtime metrics
// CSV and --output are given, prints --help, and then calls the `.action`
// function below with the paths and the parsed options.
const program = new Command();
program
  .name('plot_runtimes')
  .description(
    'Plot the runtimes of Wasmito and Whamm (wei) per Wasm module and analysis, read from the CSV of runtime_metrics_wasmito_wei.js and, optionally, the phases of Wasmito from the CSV of runtime_metrics_wasmito_phases.js.',
  )
  .argument(
    '<runtime-metrics-csv>',
    'the CSV written by runtime_metrics_wasmito_wei.js',
  )
  .argument(
    '[phases-metrics-csv]',
    'the CSV written by runtime_metrics_wasmito_phases.js (optional)',
  )
  .requiredOption(
    '-o, --output <dir>',
    'the directory to store the plots in, created if it does not exist (required)',
  )
  .action(async (runtimeMetricsCsv, phasesMetricsCsv, options) => {
    const outputDir = options.output;

    // program.error prints the message and exits the process.
    if (!isFilePath(runtimeMetricsCsv)) {
      program.error('<runtime-metrics-csv> is not a valid path to a CSV file');
    }
    if (phasesMetricsCsv !== undefined && !isFilePath(phasesMetricsCsv)) {
      program.error('[phases-metrics-csv] is not a valid path to a CSV file');
    }
    if (fs.existsSync(outputDir) && !fs.statSync(outputDir).isDirectory()) {
      program.error(`--output '${outputDir}' is not a directory`);
    }

    try {
      fs.mkdirSync(outputDir, { recursive: true });

      const runtimes = readRuntimes(runtimeMetricsCsv);
      console.log(
        `Read the runtimes of ${[...runtimes.keys()].join(', ')} from ${runtimeMetricsCsv}`,
      );
      // Temporarily disabled: only the slowdowns are plotted for now.
      await plotBaselines(runtimes, subdirectory(outputDir, 'analysis'));
      await plotSlowdowns(runtimes, subdirectory(outputDir, 'analysis'));
      // plotTimes(runtimes, subdirectory(outputDir, 'times'));

      // The phases, only when [phases-metrics-csv] is given.
      if (phasesMetricsCsv !== undefined) {
        const phases = readPhases(phasesMetricsCsv);
        console.log(
          `Read the phases of ${phases.size} analyses from ${phasesMetricsCsv}`,
        );
        await plotPhases(phases, subdirectory(outputDir, 'wasmito_phases'));
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : e;
      program.error(`Could not create plot, error occurred: ${errMsg}`);
    }
  });

// Parse the command line and run the action above (parseAsync, since the
// action is async: it waits for Vega to render).
await program.parseAsync();
