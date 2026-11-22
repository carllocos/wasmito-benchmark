#!/usr/bin/env node
// plot_memory_use.js
//
// Plots, per analysis, the distribution over the Wasm-R3 modules of the
// memory increase of the VM of Whamm (wei), Wastrumentation and Wasmito, as
// violin plots in the style of plot_module_sizes.js: the same values as the
// table of latex_table_memory_use.js (see memory_use_util.js), i.e. per
// module max_rss(analysis) - max_rss(no-analysis), in KiB.
//
// In every violin:
//   - every Wasm-R3 module is a black tick, and the median a white line;
//   - the outliers (beyond 1.5 times the interquartile range from the
//     quartiles, on the log scale of the plot) are hollow circles;
//   - the analyses count on the Wasm-R3 modules, except Wasmito's
//     concurrency bug analyses (order, variable-atomicity and multi-word
//     violation), which count on the MCU modules of the concurrency bug
//     evaluation (which only Wasmito runs); those violins get another colour.
//
// The concurrency bug analyses are shown for the frameworks of
// --include-concurrency (comma-separated wei, wastrumentation, wasmito, all or
// none; default wasmito).
//
// <wasmito-csv...> is one or more CSVs (or directories of CSVs) of
// `wasmito analysis --vm-memory`, e.g. the runs on the Wasm-R3 modules and
// those on the MCU modules.
//
// The y axis is logarithmic: y = sign(v) log10(1 + |v|), so that increases of
// 0 KiB (and negative ones) can be shown too.
//
// Usage:
//   node src/plot_memory_use.js --output <dir> [--any-status]
//     [--include-concurrency <frameworks>]
//     <wei-csv> <wastrumentation-csv> <wasmito-csv>...
// writes <dir>/memory_use.pdf (and one PDF per analysis in
// <dir>/memory_use/), sized to be included with
//   \includegraphics[width=\textwidth]{figures/memory_use.pdf}

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import * as vega from 'vega';
import * as vegaLite from 'vega-lite';
import { analysisRows, isConcurrency, labelOf, nameIn, parseFrameworkKeys, FRAMEWORKS, HLINE, lookup, median, readMemoryUse, warnUnknown } from './memory_use_util.js';

// The colours of plot_runtimes.js and plot_module_sizes.js.
const MCU = 'Wasmito (MCU modules)';
const COLORS = { 'Whamm (wei)': '#009e73', Wastrumentation: '#e69f00', Wasmito: '#0072b2', [MCU]: '#cc79a7' };

// The sizes of the figures of plot_heap_usage.js (pt).
const FIGURE_WIDTH = 398;
const COLUMNS = 4;
const PANEL_HEIGHT = 72;
const COLUMN_GAP = 8;
const ROW_GAP = 12;
const Y_AXIS_WIDTH = 41;
const PANEL_WIDTH = (FIGURE_WIDTH - Y_AXIS_WIDTH - (COLUMNS - 1) * COLUMN_GAP) / COLUMNS;
const FONT_SIZE = 6;
const TITLE_FONT_SIZE = 7;
const Y_TITLE = 'Memory increase (log)';
let HAS_MCU = false;
const X_DOMAIN = [-0.6, FRAMEWORKS.length - 0.4];

// The violins: a Gaussian kernel density of the transformed values, at least
// MIN_BANDWIDTH wide, scaled so that the widest violin of a panel is
// MAX_HALF_WIDTH of the space of one framework.
const MIN_BANDWIDTH = 0.05;
const MAX_HALF_WIDTH = 0.42;
const STEPS = 60;

const t = (kib) => Math.sign(kib) * Math.log10(1 + Math.abs(kib));

// The ticks (KiB) and their labels, every other power of ten (so that the labels fit).
const TICKS = [
  [-1048576, '-1 GB'], [-10240, '-10 MB'], [-100, '-100 KB'],
  [0, '0'], [100, '100 KB'], [10240, '10 MB'], [1048576, '1 GB'],
];

const CONFIG = {
  view: { stroke: '#dddddd' },
  axis: { labelFontSize: FONT_SIZE, titleFontSize: TITLE_FONT_SIZE, tickSize: 3, labelPadding: 2, titlePadding: 3 },
  legend: { labelFontSize: FONT_SIZE, symbolSize: 25, labelOffset: 2, columnPadding: 6, padding: 0, offset: 4 },
};

/** The outline of a violin over the transformed values ts: per height, the density there. */
function density(ts) {
  const n = ts.length;
  const mean = ts.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(ts.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const h = Math.max(MIN_BANDWIDTH, 1.06 * sd * n ** -0.2);
  const lo = Math.min(...ts) - 3 * h;
  const hi = Math.max(...ts) + 3 * h;
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const y = lo + ((hi - lo) * i) / STEPS;
    const d = ts.reduce((a, x) => a + Math.exp(-0.5 * ((y - x) / h) ** 2), 0) / (n * h);
    return { y, d };
  });
}

/** The quantile q of the sorted values s (linear interpolation). */
function quantile(s, q) {
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}

/** The rows of one panel: the violins, medians, modules, outliers and markers. */
function panelRows(label, row, data) {
  const rows = [];
  const outlines = [];
  FRAMEWORKS.forEach((fw, x) => {
    const values = lookup(data, fw, row);
    // Wasmito's concurrency analyses run on the MCU modules: another colour.
    const framework = fw === 'Wasmito' && isConcurrency(nameIn(row, fw)) ? MCU : fw;
    if (values === undefined || values.size === 0) {
      rows.push({ kind: 'marker', framework, x, marker: values === undefined ? '--' : 'n/a' });
    } else {
      const ts = [...values.values()].map(t);
      outlines.push({ framework, x, outline: density(ts) });
      rows.push({ kind: 'median', framework, x, y: median(ts) });
      const s = [...ts].sort((a, b) => a - b);
      const q1 = quantile(s, 0.25);
      const q3 = quantile(s, 0.75);
      const iqr = q3 - q1;
      for (const [module, kib] of values) {
        const y = t(kib);
        const outlier = y < q1 - 1.5 * iqr || y > q3 + 1.5 * iqr;
        rows.push({ kind: outlier ? 'outlier' : 'point', framework, x, module, y });
      }
    }
  });
  const maxD = Math.max(...outlines.flatMap((o) => o.outline.map((p) => p.d)));
  for (const { framework, x, outline } of outlines) {
    outline.forEach((p, i) => rows.push({
      kind: 'violin', framework, order: i, y: p.y,
      left: x - (MAX_HALF_WIDTH * p.d) / maxD, right: x + (MAX_HALF_WIDTH * p.d) / maxD,
    }));
  }
  return rows.map((r) => ({ analysis: label, ...r }));
}

function panelSpec(rows, label, index, count, standalone, yDomain, yTicks) {
  const rowCount = Math.ceil(count / COLUMNS);
  const row = Math.floor(index / COLUMNS);
  const first = standalone || index % COLUMNS === 0;
  const titled = standalone || (first && row === Math.floor((rowCount - 1) / 2));
  const titleShift = !standalone && rowCount % 2 === 0 ? (PANEL_HEIGHT + ROW_GAP) / 2 : 0;
  const labelExpr = yTicks.reduceRight(
    (rest, [kib, l]) => `abs(datum.value - ${t(kib)}) < 1e-6 ? '${l}' : ${rest}`, "''");
  const scale = { domain: yDomain, nice: false, zero: false };
  const y = (field) => ({
    field,
    type: 'quantitative',
    scale,
    title: titled ? Y_TITLE : null,
    axis: first
      ? {
          values: yTicks.map(([kib]) => t(kib)),
          labelExpr,
          grid: true,
          ...(titled && titleShift !== 0 ? { titleY: PANEL_HEIGHT / 2 + titleShift } : {}),
        }
      : { values: yTicks.map(([kib]) => t(kib)), grid: true, labels: false, ticks: false, domain: false },
  });
  const x = (field) => ({ field, type: 'quantitative', scale: { domain: X_DOMAIN, nice: false, zero: false }, axis: null });
  const kind = (k) => ({ filter: `datum.kind === '${k}'` });
  // Wasmito on the MCU modules only gets a legend entry when it is shown.
  const domain = HAS_MCU ? [...FRAMEWORKS, MCU] : FRAMEWORKS;
  const color = {
    field: 'framework',
    type: 'nominal',
    title: null,
    scale: { domain, range: domain.map((f) => COLORS[f]) },
    legend: standalone ? null : { orient: 'top', direction: 'horizontal' },
  };
  return {
    data: { values: rows },
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    layer: [
      {
        transform: [kind('violin')],
        mark: { type: 'area', orient: 'horizontal', opacity: 0.85, clip: true },
        encoding: { y: y('y'), x: { ...x('left'), stack: null }, x2: { field: 'right' }, color, detail: { field: 'framework' } },
      },
      {
        transform: [kind('point')],
        mark: { type: 'tick', orient: 'horizontal', color: 'black', thickness: 0.5, size: 6, clip: true },
        encoding: { y: y('y'), x: x('x') },
      },
      {
        transform: [kind('median')],
        mark: { type: 'tick', orient: 'horizontal', color: 'white', thickness: 1.2, size: 9, clip: true },
        encoding: { y: y('y'), x: x('x') },
      },
      {
        transform: [kind('outlier')],
        mark: { type: 'point', shape: 'circle', filled: false, color: 'black', strokeWidth: 0.6, size: 10, clip: true },
        encoding: { y: y('y'), x: x('x') },
      },
      {
        transform: [kind('marker')],
        mark: { type: 'text', baseline: 'bottom', dy: -2, fontSize: FONT_SIZE, color: '#777777' },
        encoding: { y: (({ field, ...rest }) => ({ ...rest, datum: yDomain[0] }))(y('y')), x: x('x'), text: { field: 'marker' } },
      },
      {
        data: { values: [{}] },
        mark: { type: 'text', align: 'left', baseline: 'bottom', fontSize: TITLE_FONT_SIZE, fontWeight: 'bold' },
        encoding: { x: { value: 0 }, y: { value: -1 }, text: { value: label } },
      },
    ],
  };
}

async function write(spec, base) {
  const view = new vega.View(vega.parse(vegaLite.compile(spec).spec), { renderer: 'none' });
  const canvas = await view.toCanvas(1, { type: 'pdf' });
  fs.writeFileSync(`${base}.pdf`, canvas.toBuffer());
  view.finalize();
  console.log(`Plotted to ${base}.pdf`);
}

async function main(weiCsv, wastrCsv, wasmitoCsvs, opts) {
  const data = readMemoryUse(weiCsv, wastrCsv, wasmitoCsvs, { anyStatus: opts.anyStatus, includeConcurrency: opts.includeConcurrency });
  const analyses = analysisRows(opts).filter((a) => a !== HLINE);
  warnUnknown(data, analyses);
  const panels = analyses
    .filter((row) => FRAMEWORKS.some((f) => lookup(data, f, row)?.size > 0))
    .map((row) => [labelOf(row), panelRows(labelOf(row), row, data)]);

  HAS_MCU = panels.some(([, rows]) => rows.some((r) => r.framework === MCU));

  // The y domain: the violins and points, padded, at the ticks around them.
  // (the tails of the violins below the lowest module are clipped)
  const ys = panels.flatMap(([, rows]) => rows.filter((r) => r.y !== undefined).map((r) => r.y));
  const pointYs = panels.flatMap(([, rows]) => rows.filter((r) => r.kind !== 'violin' && r.y !== undefined).map((r) => r.y));
  const lo = Math.min(0, Math.floor(Math.min(...pointYs)));
  const hi = Math.ceil(Math.max(...ys));
  const yDomain = [lo - 0.6, hi];
  const yTicks = TICKS.filter(([kib]) => t(kib) >= yDomain[0] && t(kib) <= yDomain[1]);

  const base = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', background: 'white', config: CONFIG };
  fs.mkdirSync(path.join(opts.output, 'memory_use'), { recursive: true });
  await write(
    {
      ...base,
      concat: panels.map(([label, rows], i) => panelSpec(rows, label, i, panels.length, false, yDomain, yTicks)),
      columns: COLUMNS,
      spacing: { row: ROW_GAP, column: COLUMN_GAP },
      bounds: 'flush',
      resolve: { scale: { color: 'shared' }, legend: { color: 'shared' } },
    },
    path.join(opts.output, 'memory_use'),
  );
  for (const [label, rows] of panels) {
    await write({ ...base, ...panelSpec(rows, label, 0, 1, true, yDomain, yTicks) },
      path.join(opts.output, 'memory_use', label.replace(/ /g, '_')));
  }
}

new Command()
  .requiredOption('--output <dir>', 'the directory to write the plots to')
  .option('--any-status', 'also count runs whose status is not ok')
  .option('--include-concurrency <frameworks>',
    'plot the concurrency bug analyses of these frameworks: comma-separated wei, wastrumentation, wasmito, all or none',
    parseFrameworkKeys, parseFrameworkKeys('wasmito'))
  .argument('<wei-csv>', 'CSV of scripts/measure_memory_use_wei.sh (wizard_memory_use.csv)')
  .argument('<wastrumentation-csv>', 'CSV of scripts/measure_memory_use_wastrumentation.sh')
  .argument('<wasmito-csv...>', 'CSVs (or directories of CSVs) of wasmito analysis --vm-memory')
  .action(main)
  .parse();
