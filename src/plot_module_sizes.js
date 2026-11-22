#!/usr/bin/env node
// plot_module_sizes.js
//
// Plots, per analysis, the distribution of the sizes (KiB, log scale) of the
// four MCU modules of the concurrency bug evaluation once instrumented by
// Whamm and Wastrumentation, as violin plots, in the style of the
// figures of plot_runtimes.js (figure analysis_relative of the paper).
//
// Whamm's size is that of everything that must be deployed: the instrumented
// module plus whamm_core.wasm and the user library (cache_sim, loop_tracer)
// it imports.
//
// Input: the CSV of src/mcu_module_sizes.js.
//
// Usage:
//   node src/plot_module_sizes.js --output <dir> <module_sizes.csv>
// writes <dir>/module_sizes.pdf (and one PDF per analysis in
// <dir>/module_sizes/), sized to be included with
//   \includegraphics[width=\textwidth]{figures/module_sizes.pdf}

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import * as vega from 'vega';
import * as vegaLite from 'vega-lite';

// [name in the CSV, name in the plot], in the order of the memory overhead
// table of the paper.
const ANALYSES = [
  ['imix', 'instruction-mix'],
  ['basic_blocks', 'basic-block'],
  ['instr_coverage', 'instr-coverage'],
  ['branches', 'branches'],
  ['call_graph', 'call-graph'],
  ['taint', 'taint'],
  ['mem_access', 'mem_access'],
  ['crypto', 'cryptomining'],
  ['forward', 'forward'],
  ['denan', 'denan'],
  ['safe_heap', 'safe-heap'],
  ['icount', 'icount'],
  ['hotness', 'hotness'],
  ['cache_sim', 'cache_sim'],
  ['loop_tracer', 'loop_tracer'],
  ['order_violation', 'order violation'],
  // Last, so that its long name sticks out into the empty space after it.
  ['data_race_violation', 'multi-word violation'],
  ['variable_violation', 'variable-atomicity violation'],
];

// The frameworks, left to right in every panel, and their colours: Whamm as
// in plot_runtimes.js, Wastrumentation in orange (Okabe-Ito).
const FRAMEWORKS = ['Whamm', 'Wastrumentation'];
const COLORS = { Whamm: '#009e73', Wastrumentation: '#e69f00' };

// The sizes of the figures of plot_runtimes.js (pt).
const FIGURE_WIDTH = 398;
const COLUMNS = 4;
const PANEL_HEIGHT = 48;
const COLUMN_GAP = 8;
const ROW_GAP = 12;
const Y_AXIS_WIDTH = 41;
const PANEL_WIDTH = (FIGURE_WIDTH - Y_AXIS_WIDTH - (COLUMNS - 1) * COLUMN_GAP) / COLUMNS;
const FONT_SIZE = 6;
const TITLE_FONT_SIZE = 7;
const Y_TITLE = 'Module Size (KiB, log)';
const Y_DOMAIN = [1, 1000];
const Y_TICKS = [1, 10, 100, 1000];

const CONFIG = {
  view: { stroke: '#dddddd' },
  axis: { labelFontSize: FONT_SIZE, titleFontSize: TITLE_FONT_SIZE, tickSize: 3, labelPadding: 2, titlePadding: 3 },
  legend: { labelFontSize: FONT_SIZE, symbolSize: 25, labelOffset: 2, columnPadding: 3, padding: 0, offset: 4 },
};

// The violins: a Gaussian kernel density of the log10 of the sizes, at least
// MIN_BANDWIDTH (log10) wide (so that four almost equal sizes still give a visible
// violin), scaled so that the widest violin of a panel is MAX_HALF_WIDTH of
// the space of one framework.
const MIN_BANDWIDTH = 0.05;
const MAX_HALF_WIDTH = 0.42;
const STEPS = 60;

function readCsv(file) {
  const [header, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
  const cols = header.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}

/** The sizes (KiB) per analysis and framework. */
function sizesOf(rows) {
  const sizes = new Map();
  const add = (analysis, framework, module, bytes) => {
    const key = `${analysis}/${framework}`;
    if (!sizes.has(key)) sizes.set(key, new Map());
    sizes.get(key).set(module, bytes / 1024);
  };
  for (const r of rows) {
    add(r.analysis, r.framework, r.module, Number(r.total_bytes));
  }
  return sizes;
}

/** The outline of a violin: per height y, the density there. */
function density(values) {
  const logs = values.map(Math.log10);
  const n = logs.length;
  const mean = logs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const h = Math.max(MIN_BANDWIDTH, 1.06 * sd * n ** -0.2);
  const lo = Math.min(...logs) - 3 * h;
  const hi = Math.max(...logs) + 3 * h;
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const l = lo + ((hi - lo) * i) / STEPS;
    const d = logs.reduce((a, x) => a + Math.exp(-0.5 * ((l - x) / h) ** 2), 0) / (n * h);
    return { y: 10 ** l, d };
  });
}

/** The rows of one panel: the violins, the sizes as points, and the markers. */
function panelRows(analysis, label, sizes) {
  const outlines = [];
  const points = [];
  const markers = [];
  FRAMEWORKS.forEach((framework, x) => {
    const modules = sizes.get(`${analysis}/${framework}`);
    if (modules === undefined || false) {
      markers.push({ framework, x, marker: 'n/a' });
      return;
    }
    const values = [...modules.values()];
    outlines.push({ framework, x, outline: density(values) });
    for (const [module, kib] of modules) points.push({ framework, x, module, kib });
  });
  const maxD = Math.max(...outlines.flatMap((o) => o.outline.map((p) => p.d)));
  const violins = outlines.flatMap(({ framework, x, outline }) =>
    outline.map((p, i) => ({
      kind: 'violin', analysis: label, framework, order: i, y: p.y,
      left: x - (MAX_HALF_WIDTH * p.d) / maxD, right: x + (MAX_HALF_WIDTH * p.d) / maxD,
    })),
  );
  return [
    ...violins,
    ...points.map((p) => ({ kind: 'point', analysis: label, ...p })),
    ...markers.map((m) => ({ kind: 'marker', analysis: label, ...m })),
  ];
}

function panelSpec(rows, label, index, count, standalone) {
  const rowCount = Math.ceil(count / COLUMNS);
  const row = Math.floor(index / COLUMNS);
  const first = standalone || index % COLUMNS === 0;
  const titled = standalone || (first && row === Math.floor((rowCount - 1) / 2));
  const titleShift = !standalone && rowCount % 2 === 0 ? (PANEL_HEIGHT + ROW_GAP) / 2 : 0;
  const scale = { type: 'log', domain: Y_DOMAIN, nice: false };
  const y = (field) => ({
    field,
    type: 'quantitative',
    scale,
    title: titled ? Y_TITLE : null,
    axis: first
      ? {
          values: Y_TICKS,
          labelExpr: "format(datum.value, '~g')",
          grid: true,
          ...(titled && titleShift !== 0 ? { titleY: PANEL_HEIGHT / 2 + titleShift } : {}),
        }
      : { values: Y_TICKS, grid: true, labels: false, ticks: false, domain: false },
  });
  const x = (field) => ({
    field,
    type: 'quantitative',
    scale: { domain: [-0.5, FRAMEWORKS.length - 0.5], nice: false, zero: false },
    axis: null,
  });
  const kind = (k) => ({ filter: `datum.kind === '${k}'` });
  const color = {
    field: 'framework',
    type: 'nominal',
    title: null,
    scale: { domain: FRAMEWORKS, range: FRAMEWORKS.map((f) => COLORS[f]) },
    legend: { orient: 'top', direction: 'horizontal', labelLimit: 0 },
  };
  return {
    data: { values: rows },
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    layer: [
      {
        transform: [kind('violin')],
        mark: { type: 'area', orient: 'horizontal', opacity: 0.85 },
        encoding: {
          y: y('y'),
          x: { ...x('left'), stack: null },
          x2: { field: 'right' },
          color,
          detail: { field: 'framework' },
        },
      },
      {
        transform: [kind('point')],
        mark: { type: 'tick', orient: 'horizontal', color: 'black', thickness: 0.5, size: 6 },
        encoding: { y: y('kib'), x: x('x') },
      },
      {
        transform: [kind('marker')],
        mark: { type: 'text', baseline: 'bottom', dy: -2, fontSize: FONT_SIZE, color: '#777777' },
        encoding: { y: { datum: Y_DOMAIN[0], type: 'quantitative', scale }, x: x('x'), text: { field: 'marker' } },
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

async function main(csv, opts) {
  const sizes = sizesOf(readCsv(csv));
  const panels = ANALYSES.filter(([a]) => FRAMEWORKS.some((f) => sizes.has(`${a}/${f}`))).map(([a, label]) => [label, panelRows(a, label, sizes)]);
  const base = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    background: 'white',
    config: CONFIG,
  };
  fs.mkdirSync(path.join(opts.output, 'module_sizes'), { recursive: true });
  await write(
    {
      ...base,
      concat: panels.map(([label, rows], i) => panelSpec(rows, label, i, panels.length, false)),
      columns: COLUMNS,
      spacing: { row: ROW_GAP, column: COLUMN_GAP },
      bounds: 'flush',
    },
    path.join(opts.output, 'module_sizes'),
  );
  for (const [label, rows] of panels) {
    await write({ ...base, ...panelSpec(rows, label, 0, 1, true) }, path.join(opts.output, 'module_sizes', label.replace(/ /g, '_')));
  }
}

new Command()
  .requiredOption('--output <dir>', 'the directory to write the plots to')
  .argument('<module-sizes-csv>', 'the CSV of src/mcu_module_sizes.js')
  .action(main)
  .parse();
