import * as fs from 'fs';
import { createCanvas } from 'canvas';

export const METRICS = [
  'parsing_ms',
  'spawn_ms',
  'register_ms',
  'deploy_ms',
  'run_ms',
  'total_ms',
];
/**
 * @typedef {(typeof METRICS)[number]} Metric
 */

export const PLOT_FORMATS = ['pdf', 'png', 'jpg'];
/**
 * @typedef {(typeof PLOT_FORMATS)[number]} PlotFormat
 */

export const BASELINE_ANALYSIS = 'no-analysis';

const METRIC_LABELS = {
  parsing_ms: 'Parsing time (ms)',
  spawn_ms: 'VM spawn time (ms)',
  register_ms: 'Advice registration time (ms)',
  deploy_ms: 'Advice deployment time (ms)',
  run_ms: 'Analysis run time (ms)',
  total_ms: 'Total time (ms)',
};

export function isMetric(name) {
  return METRICS.includes(name);
}

/** Maps a file extension (without dot) to a plot format. */
export function plotFormatFromExtension(extension) {
  switch (extension?.toLowerCase()) {
    case 'pdf':
      return 'pdf';
    case 'png':
      return 'png';
    case 'jpg':
    case 'jpeg':
      return 'jpg';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// CSV parsing and statistics
// ---------------------------------------------------------------------------

/**
 * The values of one metric, grouped as wasm module -> analysis -> runs.
 *
 * @typedef {Map<string, Map<string, number[]>>} Samples
 */

/**
 * Why a run failed: it hit the time limit (`timeout after 600000 ms` or
 * `TIMEOUT`), or anything else (e.g. Whamm's `ERROR`).
 *
 * @typedef {'timeout' | 'error'} FailureKind
 */

/**
 * @typedef {Object} ParsedBenchmarkCsv
 * @property {Samples} samples
 * @property {Map<string, Map<string, number>>} failures - Number of failed runs per wasm module and analysis.
 * @property {Map<string, Map<string, FailureKind>>} failureKinds - Why the runs of a wasm module and analysis failed; a timeout wins.
 * @property {number} runs - Number of successful runs.
 * @property {number} skippedRows
 */

/** Whamm's benchmark CSVs name the wasm column `wasm_module`. */
const WASM_COLUMNS = ['wasm', 'wasm_module'];
/** Whamm's benchmark CSVs name the total time column `time_ms`. */
const METRIC_COLUMN_ALIASES = {
  total_ms: ['total_ms', 'time_ms'],
};
const NUMERIC_COLUMNS = [...METRICS, 'time_ms'];

function findColumn(header, names) {
  for (const name of names) {
    const idx = header.indexOf(name);
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Parses a benchmark CSV (header: analysis,wasm,parsing_ms,spawn_ms,
 * register_ms,deploy_ms,run_ms,total_ms) and collects the values of `metric`. The header
 * of Whamm's benchmark CSVs (wasm_module,analysis,time_ms) is understood too.
 *
 * Columns are looked up by header name, so surplus trailing fields on a row
 * are ignored. Like `scripts/stats_for_runs.sh`, a row where any known numeric
 * column is not a number (e.g. `timeout after 60000 ms` or `TIMEOUT`) is a
 * failed run and is skipped. `onSkip` is called with the 1-based line number
 * and the reason.
 */
export function parseBenchmarkCsv(content, metric, onSkip = () => undefined) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = (lines[0] ?? '').split(',').map((h) => h.trim());
  const analysisIdx = header.indexOf('analysis');
  const wasmIdx = findColumn(header, WASM_COLUMNS);
  const metricIdx = findColumn(
    header,
    METRIC_COLUMN_ALIASES[metric] ?? [metric],
  );
  const missing = [
    analysisIdx < 0 ? 'analysis' : undefined,
    wasmIdx < 0 ? 'wasm' : undefined,
    metricIdx < 0 ? metric : undefined,
  ].filter((c) => c !== undefined);
  if (missing.length > 0) {
    throw new Error(`CSV is missing required column(s): ${missing.join(', ')}`);
  }

  const knownMetricIdxs = NUMERIC_COLUMNS.map((m) => header.indexOf(m)).filter(
    (i) => i >= 0,
  );

  const samples = new Map();
  const failures = new Map();
  const failureKinds = new Map();
  let runs = 0;
  let skippedRows = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const fields = lines[i].split(',').map((f) => f.trim());

    const failed = knownMetricIdxs.find(
      (idx) =>
        fields[idx] === undefined ||
        fields[idx] === '' ||
        !Number.isFinite(Number(fields[idx])),
    );
    if (failed !== undefined) {
      skippedRows++;
      const failedWasm = fields[wasmIdx];
      const perWasmFailures = failures.get(failedWasm) ?? new Map();
      const failedAnalysis = fields[analysisIdx];
      perWasmFailures.set(
        failedAnalysis,
        (perWasmFailures.get(failedAnalysis) ?? 0) + 1,
      );
      failures.set(failedWasm, perWasmFailures);
      const perWasmKinds = failureKinds.get(failedWasm) ?? new Map();
      if (perWasmKinds.get(failedAnalysis) !== 'timeout') {
        perWasmKinds.set(
          failedAnalysis,
          /timeout/i.test(fields[failed] ?? '') ? 'timeout' : 'error',
        );
      }
      failureKinds.set(failedWasm, perWasmKinds);
      onSkip(
        i + 1,
        `value '${fields[failed] ?? ''}' for '${header[failed]}' is not a number`,
      );
      continue;
    }

    const wasm = fields[wasmIdx];
    const analysis = fields[analysisIdx];
    const perWasm = samples.get(wasm) ?? new Map();
    const values = perWasm.get(analysis) ?? [];
    values.push(Number(fields[metricIdx]));
    perWasm.set(analysis, values);
    samples.set(wasm, perWasm);
    runs++;
  }
  return { samples, failures, failureKinds, runs, skippedRows };
}

/**
 * A benchmark CSV of wasmito without the time spent spawning the VM: the
 * `spawn_ms` column is dropped and subtracted from `total_ms` on every row
 * where both are numbers. Rows of failed runs are kept as they are.
 */
export function withoutSpawn(content) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = (lines[0] ?? '').split(',').map((h) => h.trim());
  const spawnIdx = header.indexOf('spawn_ms');
  const totalIdx = header.indexOf('total_ms');
  if (spawnIdx < 0 || totalIdx < 0) {
    throw new Error(
      'CSV is missing the spawn_ms or total_ms column to leave spawning out',
    );
  }
  const drop = (fields) => fields.filter((_, i) => i !== spawnIdx);
  return [
    drop(header).join(','),
    ...lines.slice(1).map((line) => {
      if (line.trim() === '') return line;
      const fields = line.split(',').map((f) => f.trim());
      const spawn = Number(fields[spawnIdx]);
      const total = Number(fields[totalIdx]);
      if (
        fields[spawnIdx] !== '' &&
        fields[totalIdx] !== '' &&
        Number.isFinite(spawn) &&
        Number.isFinite(total)
      ) {
        fields[totalIdx] = `${total - spawn}`;
      }
      return drop(fields).join(',');
    }),
  ].join('\n');
}

/**
 * @typedef {Object} Stats
 * @property {number} count
 * @property {number} mean
 * @property {number} median
 * @property {number} min
 * @property {number} max
 * @property {number} stdev - Sample standard deviation (n - 1); 0 when there is a single run.
 * @property {number} q1 - First and third quartile, linearly interpolated.
 * @property {number} q3
 */

/** The `p` quantile (0 to 1) of ascending `sorted`, linearly interpolated. */
function quantile(sorted, p) {
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function computeStats(values) {
  if (values.length === 0) {
    throw new Error('Cannot compute statistics of an empty list');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / count;
  const mid = Math.floor(count / 2);
  const median =
    count % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const variance =
    count > 1
      ? sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (count - 1)
      : 0;
  return {
    count,
    mean,
    median,
    min: sorted[0],
    max: sorted[count - 1],
    stdev: Math.sqrt(variance),
    q1: quantile(sorted, 0.25),
    q3: quantile(sorted, 0.75),
  };
}

/** `no-analysis` first (the baseline), then the others alphabetically. */
export function orderAnalyses(names) {
  const sorted = [...new Set(names)].sort();
  const baselineIdx = sorted.indexOf(BASELINE_ANALYSIS);
  if (baselineIdx > 0) {
    sorted.splice(baselineIdx, 1);
    sorted.unshift(BASELINE_ANALYSIS);
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Axis scales
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Axis
 * @property {number[]} ticks
 * @property {(value: number) => number} position - Maps a value to a fraction in [0, 1] of the axis length.
 */

/** Ticks at 1/2/5 x 10^k from 0 up to the first tick >= `max`. */
export function linearAxis(max, targetTicks = 4) {
  if (!(max > 0)) {
    return { ticks: [0, 1], position: (v) => Math.min(Math.max(v, 0), 1) };
  }
  const rawStep = max / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step =
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) *
    magnitude;
  const ticks = [];
  for (let i = 0; i * step < max + step * 0.999; i++) {
    ticks.push(Number((i * step).toPrecision(12)));
  }
  const top = ticks[ticks.length - 1];
  return {
    ticks,
    position: (v) => Math.min(Math.max(v / top, 0), 1),
  };
}

/** Extra room, in decades, so the extreme values are not on the plot edges. */
const LOG_AXIS_PADDING = 0.05;

/**
 * Ticks at the powers of ten within the positive values, with a little
 * padding around them. When fewer than two powers of ten fit, the axis spans
 * the enclosing decades instead. When the axis spans fewer than three
 * decades, 2 and 5 times each power of ten are ticks as well. Values at or
 * below the start of the axis (e.g. a 0 ms measurement) are drawn on the left
 * edge. With `from`, the axis starts exactly there instead, without padding.
 */
export function logAxis(positiveMin, max, from) {
  const minPower =
    Number.isFinite(positiveMin) && positiveMin > 0
      ? Math.log10(positiveMin)
      : 0;
  const maxPower = max > 0 ? Math.max(Math.log10(max), minPower) : minPower + 1;
  let lo = from !== undefined ? Math.log10(from) : minPower - LOG_AXIS_PADDING;
  let hi = maxPower + LOG_AXIS_PADDING;
  let first = Math.ceil(lo);
  let last = Math.floor(hi);
  if (last <= first) {
    if (from === undefined) lo = Math.floor(lo);
    hi = Math.max(Math.ceil(hi), lo + 1);
    first = lo;
    last = hi;
  }
  const multipliers = hi - lo < 3 ? [1, 2, 5] : [1];
  const ticks = [];
  for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) {
    for (const m of multipliers) {
      const power = Math.log10(m) + e;
      if (power >= lo - 1e-9 && power <= hi + 1e-9) {
        ticks.push(Number((m * 10 ** e).toPrecision(12)));
      }
    }
  }
  return {
    ticks,
    position: (v) =>
      v <= 0 ? 0 : Math.min(Math.max((Math.log10(v) - lo) / (hi - lo), 0), 1),
  };
}

// ---------------------------------------------------------------------------
// Density estimation (violins)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Density
 * @property {number[]} xs - Evenly spaced positions from the smallest to the largest value.
 * @property {number[]} ys - Density at each position, scaled so that the highest is 1.
 */

/**
 * Gaussian kernel density estimate of `values` (Silverman's bandwidth),
 * limited to the observed range. Returns undefined when no shape can be
 * estimated: a single value, or values that are all equal.
 */
export function kernelDensity(values, points = 64) {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[n - 1];
  if (n < 2 || !(max > min)) return undefined;

  const { stdev, q1, q3 } = computeStats(values);
  const iqr = q3 - q1;
  const spread = iqr > 0 ? Math.min(stdev, iqr / 1.34) : stdev;
  const bandwidth = 0.9 * spread * n ** -0.2;

  const xs = [];
  const ys = [];
  for (let i = 0; i < points; i++) {
    const x = min + ((max - min) * i) / (points - 1);
    xs.push(x);
    ys.push(
      sorted.reduce(
        (sum, v) => sum + Math.exp(-0.5 * ((x - v) / bandwidth) ** 2),
        0,
      ),
    );
  }
  const peak = Math.max(...ys);
  return { xs, ys: ys.map((y) => y / peak) };
}

// ---------------------------------------------------------------------------
// Slowdown relative to a baseline
// ---------------------------------------------------------------------------

/** The baseline of Whamm's benchmark CSVs: a run without any monitor. */
export const WHAMM_BASELINE = 'none';

/**
 * @typedef {Object} SlowdownGroup
 * @property {string} label - The tool that produced the CSV, shown in the plot.
 * @property {string} baseline
 * @property {Map<string, number[]>} slowdowns - Per analysis, the slowdown of each of its runs.
 * @property {Map<string, number>} failures - Per analysis, the number of failed runs.
 * @property {number} modules - Number of Wasm modules that have a baseline.
 * @property {string[]} modulesWithoutBaseline
 * @property {number} failedRuns - Number of failed runs, baseline runs included.
 */

/**
 * The slowdown of a run is its time divided by the mean time of the baseline
 * on the same Wasm module, so 1 means as fast as the baseline and 2 twice as
 * slow. Wasm modules without a successful baseline run are left out. Throws
 * when no module has a baseline at all.
 */
export function computeSlowdownGroup(
  label,
  { samples, failures, skippedRows },
  baseline,
) {
  const slowdowns = new Map();
  const failuresPerAnalysis = new Map();
  const modulesWithoutBaseline = [];
  let modules = 0;

  const wasms = [...new Set([...samples.keys(), ...failures.keys()])].sort();
  for (const wasm of wasms) {
    const baselineRuns = samples.get(wasm)?.get(baseline);
    const baselineMean = baselineRuns ? computeStats(baselineRuns).mean : 0;
    if (!(baselineMean > 0)) {
      modulesWithoutBaseline.push(wasm);
      continue;
    }
    modules++;
    for (const [analysis, values] of samples.get(wasm)) {
      if (analysis === baseline) continue;
      const perAnalysis = slowdowns.get(analysis) ?? [];
      perAnalysis.push(...values.map((v) => v / baselineMean));
      slowdowns.set(analysis, perAnalysis);
    }
    for (const [analysis, count] of failures.get(wasm) ?? new Map()) {
      if (analysis === baseline) continue;
      failuresPerAnalysis.set(
        analysis,
        (failuresPerAnalysis.get(analysis) ?? 0) + count,
      );
    }
  }
  if (modules === 0) {
    throw new Error(
      `${label}: no successful run of the baseline '${baseline}' found`,
    );
  }
  return {
    label,
    baseline,
    slowdowns,
    failures: failuresPerAnalysis,
    modules,
    modulesWithoutBaseline,
    failedRuns: skippedRows,
  };
}

/** A slowdown as shown to the reader: `1×`, `7.2×`, `120×`. */
export function formatSlowdown(v) {
  const rounded = v >= 10 ? Math.round(v) : Number(v.toPrecision(2));
  return `${rounded.toLocaleString('en-US')}×`;
}

/**
 * The analyses of a group by display name, with the slowdown of their runs,
 * or undefined when every run of the analysis failed.
 */
function analysisData(group) {
  const names = [
    ...new Set([...group.slowdowns.keys(), ...group.failures.keys()]),
  ].sort();
  return new Map(
    names.map((name) => [wasmDisplayName(name), group.slowdowns.get(name)]),
  );
}

// ---------------------------------------------------------------------------
// Matching the analyses of two tools
// ---------------------------------------------------------------------------

/**
 * An analysis of the first tool and the analysis of the second one it matches.
 *
 * @typedef {[first: string, second: string]} AnalysisPair
 */

/**
 * The analyses of wasmito (first) and Whamm (second) that do the same. They
 * follow the categories of Whamm's `tests/scripts/paper_eval` monitors, which
 * reimplement Wasabi's and Wastrumentation's analyses that wasmito ports.
 * `instruction-mix` counts how often each instruction is executed, as
 * `hotness-hw` does; `ins_count-hw` instruments the same way but has no
 * counterpart in wasmito.
 */
export const DEFAULT_ANALYSIS_PAIRS = [
  ['block-profiling', 'basic-blocks'],
  ['branches', 'branches-subset'],
  ['call-graph', 'call_graph'],
  ['coverage-instruction', 'coverage'],
  ['instruction-mix', 'hotness-hw'],
  ['memory-trace', 'mem_access'],
];

/** Parses `<first-analysis>=<second-analysis>`; a `.wasm` extension is dropped. */
export function parseAnalysisPair(spec) {
  const parts = spec.split('=').map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => part === '')) {
    throw new Error(
      `'${spec}' is not of the form <wasmito-analysis>=<whamm-analysis>`,
    );
  }
  return [wasmDisplayName(parts[0]), wasmDisplayName(parts[1])];
}

/** `overrides` replace every default pair that shares an analysis with them. */
export function mergeAnalysisPairs(defaults, overrides) {
  const firsts = new Set(overrides.map(([first]) => first));
  const seconds = new Set(overrides.map(([, second]) => second));
  return [
    ...defaults.filter(
      ([first, second]) => !firsts.has(first) && !seconds.has(second),
    ),
    ...overrides,
  ];
}

/**
 * One analysis of each tool that are compared, or one that has no match.
 *
 * @typedef {Object} ComparisonGroup
 * @property {string} [first]
 * @property {string} [second]
 */

/**
 * An analysis name without case, separators and a plural `s`, so that e.g.
 * wasmito's `basic-block` and Whamm's `basic_blocks` are the same analysis.
 */
function normalizedAnalysis(name) {
  return name
    .toLowerCase()
    .replace(/[-_\s]/g, '')
    .replace(/s$/, '');
}

/**
 * Matches the analyses of two groups: first the matched ones in the order of
 * the first group, then the analyses that only the first group has, then those
 * that only the second one has.
 */
export function compareAnalyses(first, second, pairs) {
  return matchAnalyses(
    [...analysisData(first).keys()],
    [...analysisData(second).keys()],
    pairs,
  );
}

/**
 * Matches the analysis names of two tools, see `compareAnalyses`. A name is
 * matched with its counterpart in `pairs`, or else with the name of the other
 * tool that is the same apart from case, separators and a plural `s`.
 */
export function matchAnalyses(firstNames, secondNames, pairs) {
  const second = new Set(secondNames);
  const counterpart = new Map(pairs);
  const matched = [];
  const onlyFirst = [];
  const usedSecond = new Set();
  for (const name of firstNames) {
    const paired = counterpart.get(name);
    const other =
      paired !== undefined && second.has(paired) && !usedSecond.has(paired)
        ? paired
        : secondNames.find(
            (candidate) =>
              !usedSecond.has(candidate) &&
              normalizedAnalysis(candidate) === normalizedAnalysis(name),
          );
    if (other !== undefined) {
      usedSecond.add(other);
      matched.push({ first: name, second: other });
    } else {
      onlyFirst.push({ first: name });
    }
  }
  const onlySecond = secondNames
    .filter((name) => !usedSecond.has(name))
    .map((name) => ({ second: name }));
  return [...matched, ...onlyFirst, ...onlySecond];
}

/**
 * Plain-text table of the slowdown statistics of every analysis. With two or
 * more groups, matching analyses are on consecutive lines; the groups after
 * the second share the analysis names of the second.
 */
export function formatSlowdownTable(groups, pairs = DEFAULT_ANALYSIS_PAIRS) {
  const table = [
    ['Tool', 'Analysis', 'Runs', 'Mean', 'Median', 'Min', 'Max', 'Stdev'],
  ];
  const addRow = (group, analysis, values) => {
    if (values === undefined) {
      table.push([group.label, analysis, '0', 'all runs failed']);
      return;
    }
    const s = computeStats(values);
    table.push([
      group.label,
      analysis,
      `${s.count}`,
      ...[s.mean, s.median, s.min, s.max, s.stdev].map(
        (v) => `${v.toFixed(2)}×`,
      ),
    ]);
  };

  if (groups.length >= 2) {
    const [first, ...others] = groups;
    const firstData = analysisData(first);
    const othersData = others.map(analysisData);
    for (const { first: a, second: b } of compareAnalyses(
      first,
      others[0],
      pairs,
    )) {
      if (a !== undefined) addRow(first, a, firstData.get(a));
      if (b !== undefined) {
        others.forEach((group, i) => addRow(group, b, othersData[i].get(b)));
      }
    }
  } else {
    for (const group of groups) {
      for (const [analysis, values] of analysisData(group)) {
        addRow(group, analysis, values);
      }
    }
  }

  const widths = table[0].map((_, col) =>
    Math.max(...table.map((row) => (row[col] ?? '').length)),
  );
  return table
    .map((row) =>
      row
        .map((cell, col) =>
          col < 2 ? cell.padEnd(widths[col]) : cell.padStart(widths[col]),
        )
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export const PLOT_KINDS = ['violin', 'range'];
/**
 * @typedef {(typeof PLOT_KINDS)[number]} PlotKind
 */

/**
 * @typedef {Object} PlotOptions
 * @property {Metric} metric
 * @property {PlotFormat} format
 * @property {PlotKind} kind - `violin`: the distribution of the runs. `range`: min to max, mean and standard deviation only.
 * @property {string | false} [title] - The title; a default one when undefined, none when false.
 * @property {boolean} logScale
 * @property {number} width - Logical width; the height follows from the number of panels.
 */

const COLORS = {
  surface: '#fcfcfb',
  ink: '#0b0b0b',
  inkSecondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  series: '#2a78d6',
  /** The second categorical hue, validated as a pair with `series`. */
  series2: '#eb6834',
  /** The third categorical hue, validated with the first two. */
  series3: '#1baf7a',
};
/** The colour of each tool when two or three are compared. */
const TOOL_COLORS = [COLORS.series, COLORS.series2, COLORS.series3];
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const RASTER_SCALE = 2;

const MARGIN = 32;
const MAX_COLUMNS = 3;
const COLUMN_GAP = 28;
const PANEL_GAP = 22;
const PANEL_TITLE_H = 24;
const ROW_H = { violin: 30, range: 22 };
/** Space between the rows of two compared analyses and the next ones. */
const GROUP_GAP = 14;
/** Tick labels plus the axis title carrying the unit. */
const AXIS_H = 42;
/** Room right of a panel's plot area for the label of the peak mean. */
const LABEL_PAD = 92;
const LABEL_GUTTER_PAD = 14;
/** Width taken by the coloured dot before a row label. */
const SWATCH_W = 16;
const NOTE_LINE_H = 18;
/** Extra header height for the line naming the compared tools. */
const TOOLS_LEGEND_H = 22;
/** Violins drawn from fewer runs than this are flagged as indicative. */
const FEW_RUNS = 5;

function formatNumber(v) {
  return Math.round(v).toLocaleString('en-US');
}

function setFont(ctx, px, weight = '') {
  ctx.font = `${weight} ${px}px ${FONT}`.trim();
}

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Splits `text` into lines that are at most `maxWidth` wide. */
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** The name of a Wasm module as shown in plots: without the `.wasm` extension. */
export function wasmDisplayName(wasm) {
  return wasm.replace(/\.wasm$/i, '');
}

/**
 * @typedef {Object} PanelRow
 * @property {string} key - Identifies the row in the values of its panel.
 * @property {string} label
 * @property {string} color
 * @property {number} gapBefore - Empty space above the row, to set a group of rows apart.
 */

function plainRows(names) {
  return names.map((name) => ({
    key: name,
    label: name,
    color: COLORS.series,
    gapBefore: 0,
  }));
}

/** The distance of every row from the top of the plot area. */
function rowOffsets(rows, rowH) {
  let y = 0;
  return rows.map((row) => {
    y += row.gapBefore;
    const top = y;
    y += rowH;
    return top;
  });
}

function plotAreaHeight(rows, rowH) {
  return rows.reduce((sum, row) => sum + row.gapBefore + rowH, 0);
}

/**
 * @typedef {Object} Panel
 * @property {string} title
 * @property {string} detail - Muted text after the title, e.g. how many runs the panel is based on.
 * @property {PanelRow[]} rows - The rows, top to bottom.
 * @property {boolean} swatches - Whether the labels get a dot in the colour of their row.
 * @property {Map<string, number[]>} values - The values per row key.
 * @property {Map<string, Stats>} stats - Statistics per row key.
 * @property {Set<string>} failed - Row keys without values because all their runs failed.
 */

/**
 * @typedef {Object} PanelLayout
 * @property {number} rowH
 * @property {number} x0
 * @property {number} y0
 * @property {number} plotW
 * @property {PlotKind} kind
 * @property {boolean} logScale
 * @property {string} axisTitle
 * @property {(v: number) => string} formatValue
 * @property {Axis} [axis] - An axis shared with other panels; by default one is derived per panel.
 * @property {number} [referenceValue] - A value marked with a vertical line, e.g. 1 for "no slowdown".
 */

function makePanel(title, detail, rows, values, failed, swatches = false) {
  const stats = new Map([...values].map(([r, v]) => [r, computeStats(v)]));
  const failedRows = new Set(failed);
  for (const row of values.keys()) failedRows.delete(row);
  return {
    title,
    detail: detail([...stats.values()]),
    rows,
    swatches,
    values,
    stats,
    failed: failedRows,
  };
}

/** `3` or `1-12`: the numbers of runs behind the rows of a panel. */
function countRange(stats) {
  if (stats.length === 0) return '0';
  const counts = stats.map((s) => s.count);
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  return lo === hi ? `${lo}` : `${lo}-${hi}`;
}

function axisFor(stats, logScale) {
  const top = Math.max(...stats.map((s) => Math.max(s.max, s.mean + s.stdev)));
  if (!logScale) return linearAxis(top);
  const positives = stats.flatMap((s) =>
    [s.min, s.mean - s.stdev].filter((v) => v > 0),
  );
  return logAxis(Math.min(...positives), top);
}

function createPlotCanvas(format, width, height) {
  const scale = format === 'pdf' ? 1 : RASTER_SCALE;
  const canvas =
    format === 'pdf'
      ? createCanvas(width, height, 'pdf')
      : createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = COLORS.surface;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'alphabetic';
  return { canvas, ctx };
}

function encodePlot(canvas, format) {
  switch (format) {
    case 'pdf':
      return canvas.toBuffer('application/pdf');
    case 'png':
      return canvas.toBuffer('image/png');
    case 'jpg':
      return canvas.toBuffer('image/jpeg', { quality: 0.92 });
  }
}

/**
 * @typedef {Object} ToolLegend
 * @property {string} label
 * @property {string} color
 */

/**
 * @typedef {Object} LegendStyle
 * @property {string} accent - The colour of the sample shapes.
 * @property {ToolLegend[]} [tools] - Tools to name by colour on a line above the shapes.
 */

/** The height of the title line, which the rest moves up by without one. */
const TITLE_H = 20;

/** The title to draw: `fallback` by default, none when `title` is false. */
function plotTitle(title, fallback) {
  return title === false ? undefined : (title ?? fallback);
}

/** Title, subtitle, notes and legend. */
function drawHeader(ctx, header) {
  const top = header.title === undefined ? MARGIN - TITLE_H : MARGIN;
  ctx.textAlign = 'left';
  if (header.title !== undefined) {
    ctx.fillStyle = COLORS.ink;
    setFont(ctx, 20, 'bold');
    ctx.fillText(header.title, MARGIN, top + 18);
  }
  ctx.fillStyle = COLORS.inkSecondary;
  setFont(ctx, 12);
  ctx.fillText(header.subtitle, MARGIN, top + 38);
  header.noteLines.forEach((line, i) => {
    ctx.fillText(line, MARGIN, top + 56 + i * NOTE_LINE_H);
  });
  drawLegend(
    ctx,
    MARGIN,
    header.height - 8,
    header.kind,
    header.showSpread,
    header.legend,
  );
}

function headerHeight(noteLines, legend, title) {
  return (
    104 +
    NOTE_LINE_H * noteLines.length +
    (legend?.tools !== undefined ? TOOLS_LEGEND_H : 0) -
    (title === false ? TITLE_H : 0)
  );
}

/**
 * Renders one small-multiple panel per analysis with one row per Wasm module.
 * A row is either a violin (density of the runs between their min and max) or
 * a min-max whisker, according to `opts.kind`. Both show the mean +/- 1 stdev,
 * the median (tick) and the mean (dot) of the chosen metric.
 */
export function renderBenchmarkPlot(
  { samples, failures, runs, skippedRows },
  opts,
) {
  const analyses = orderAnalyses(
    [...samples.values(), ...failures.values()].flatMap((perWasm) => [
      ...perWasm.keys(),
    ]),
  );
  const wasms = [...new Set([...samples.keys(), ...failures.keys()])].sort();
  const rows = plainRows(wasms.map(wasmDisplayName));
  const panels = analyses.map((analysis) => {
    const values = new Map();
    for (const wasm of wasms) {
      const runsOfPair = samples.get(wasm)?.get(analysis);
      if (runsOfPair) values.set(wasmDisplayName(wasm), runsOfPair);
    }
    return makePanel(
      analysis,
      (stats) => `n = ${countRange(stats)}`,
      rows,
      values,
      wasms
        .filter((wasm) => failures.get(wasm)?.has(analysis))
        .map(wasmDisplayName),
    );
  });
  if (runs === 0) throw new Error('There is no data to plot');

  const allStats = panels.flatMap((p) => [...p.stats.values()]);
  const singleRun = allStats.every((s) => s.count === 1);

  // Caveats a reader needs to interpret the marks correctly.
  const notes = [];
  if (skippedRows > 0) notes.push(failedRunsNote(skippedRows));
  if (opts.kind === 'violin') {
    notes.push(
      'A violin shows the relative density of the runs of one Wasm module, between their min and max, and needs at least 2 different runs.',
    );
    if (allStats.some((s) => s.count === 1)) {
      notes.push(
        singleRun
          ? 'Every Wasm module and analysis has a single run, so only the mean is drawn.'
          : 'Rows with a single run show only the mean.',
      );
    }
  } else if (singleRun) {
    notes.push(
      'With a single run per Wasm module and analysis, min, max and median equal the mean and there is no standard deviation.',
    );
  }
  const hasZero = [...samples.values()].some((perWasm) =>
    [...perWasm.values()].some((values) => values.some((v) => v <= 0)),
  );
  if (opts.logScale && hasZero) {
    notes.push('Values of 0 are drawn on the left edge of the log axis.');
  }

  const width = opts.width;
  const rowH = ROW_H[opts.kind];

  // Measure first: the label gutter and the wrapped notes depend on text width.
  const scratch = createCanvas(1, 1).getContext('2d');
  setFont(scratch, 12);
  const gutter = labelGutter(scratch, panels);
  const noteLines = wrapNotes(scratch, notes, width);

  const columns = Math.min(MAX_COLUMNS, panels.length);
  const panelRows = Math.ceil(panels.length / columns);
  const panelW =
    (width - 2 * MARGIN - gutter - (columns - 1) * COLUMN_GAP) / columns;
  const plotW = panelW - LABEL_PAD;
  const panelH = PANEL_TITLE_H + plotAreaHeight(rows, rowH) + AXIS_H;
  const legend = { accent: COLORS.series };
  const headerH = headerHeight(noteLines, legend, opts.title);
  const height =
    headerH + panelRows * panelH + (panelRows - 1) * PANEL_GAP + MARGIN;

  const { canvas, ctx } = createPlotCanvas(opts.format, width, height);
  drawHeader(ctx, {
    title: plotTitle(
      opts.title,
      `${METRIC_LABELS[opts.metric]} per analysis and Wasm module`,
    ),
    subtitle:
      `${runs} runs, ${analyses.length} analyses, ${rows.length} Wasm modules. ` +
      `Each panel has its own ${opts.logScale ? 'log' : 'linear'} x-axis.`,
    noteLines,
    height: headerH,
    kind: opts.kind,
    // With a single run per row there is no spread to explain, only the mean.
    showSpread: !singleRun,
    legend,
  });

  const axisTitle = `${METRIC_LABELS[opts.metric]}${opts.logScale ? ', log scale' : ''}`;
  panels.forEach((panel, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    const x0 = MARGIN + gutter + col * (panelW + COLUMN_GAP);
    const y0 = headerH + row * (panelH + PANEL_GAP);
    drawPanel(ctx, panel, {
      rowH,
      x0,
      y0,
      plotW,
      kind: opts.kind,
      logScale: opts.logScale,
      axisTitle,
      formatValue: formatNumber,
    });
    if (col === 0) drawRowLabels(ctx, panel, rowH, MARGIN, y0);
  });

  return encodePlot(canvas, opts.format);
}

/**
 * Renders the slowdown of every analysis relative to its baseline. Two or
 * three groups (CSV files) are compared with matching analyses next to each
 * other, see `renderSlowdownComparisonPlot`; one group gets a panel of its own.
 */
export function renderSlowdownPlot(
  groups,
  opts,
  pairs = DEFAULT_ANALYSIS_PAIRS,
) {
  if (groups.length >= 2) {
    return renderSlowdownComparisonPlot(groups, pairs, opts);
  }
  return renderStackedSlowdownPlot(groups, opts);
}

/** The notes about the slowdowns of any number of groups. */
function slowdownNotes(groups, allStats, kind) {
  const notes = [
    `The slowdown of a run is its total time divided by the mean total time of the baseline on the same Wasm module. The vertical line marks ${formatSlowdown(1)}, no slowdown.`,
  ];
  const failedRuns = groups.reduce((sum, g) => sum + g.failedRuns, 0);
  if (failedRuns > 0) notes.push(failedRunsNote(failedRuns));
  for (const g of groups) {
    if (g.modulesWithoutBaseline.length > 0) {
      notes.push(
        `${g.label}: ${g.modulesWithoutBaseline.map(wasmDisplayName).join(', ')} left out, no successful '${g.baseline}' run.`,
      );
    }
  }
  if (kind === 'violin') {
    if (allStats.every((s) => s.count === 1)) {
      notes.push('Every row has a single run, so only the mean is drawn.');
    } else if (allStats.some((s) => s.count === 1)) {
      notes.push('Rows with a single run show only the mean.');
    }
    if (allStats.some((s) => s.count > 1 && s.count < FEW_RUNS)) {
      notes.push(
        `Violins drawn from fewer than ${FEW_RUNS} runs are only indicative.`,
      );
    }
  }
  return notes;
}

/**
 * One panel per group, stacked and sharing one x-axis, with one row per
 * analysis. A violin is the distribution of the slowdown of all runs of that
 * analysis over all Wasm modules.
 */
function renderStackedSlowdownPlot(groups, opts) {
  const panels = groups.map((group) => {
    const data = analysisData(group);
    const values = new Map();
    for (const [analysis, v] of data) {
      if (v !== undefined) values.set(analysis, v);
    }
    return makePanel(
      group.label,
      (stats) => `baseline: ${group.baseline}, n = ${countRange(stats)} runs`,
      plainRows([...data.keys()]),
      values,
      data.keys(),
    );
  });
  const allStats = panels.flatMap((p) => [...p.stats.values()]);
  if (allStats.length === 0) throw new Error('There is no data to plot');
  const allSingle = allStats.every((s) => s.count === 1);
  const notes = slowdownNotes(groups, allStats, opts.kind);

  const width = opts.width;
  const rowH = ROW_H[opts.kind];
  const scratch = createCanvas(1, 1).getContext('2d');
  setFont(scratch, 12);
  const gutter = labelGutter(scratch, panels);
  const noteLines = wrapNotes(scratch, notes, width);

  const plotW = width - 2 * MARGIN - gutter - LABEL_PAD;
  const panelHeights = panels.map(
    (p) => PANEL_TITLE_H + plotAreaHeight(p.rows, rowH) + AXIS_H,
  );
  const legend = { accent: COLORS.series };
  const headerH = headerHeight(noteLines, legend, opts.title);
  const height =
    headerH +
    panelHeights.reduce((sum, h) => sum + h, 0) +
    (panels.length - 1) * PANEL_GAP +
    MARGIN;

  const { canvas, ctx } = createPlotCanvas(opts.format, width, height);
  drawHeader(ctx, {
    title: plotTitle(
      opts.title,
      'Slowdown per analysis relative to its baseline',
    ),
    subtitle:
      groups.map((g) => `${g.label}: ${g.modules} Wasm modules`).join(', ') +
      `. ${groups.length > 1 ? 'The panels share' : 'The panel has'} one ${opts.logScale ? 'log' : 'linear'} x-axis.`,
    noteLines,
    height: headerH,
    kind: opts.kind,
    showSpread: !allSingle,
    legend,
  });

  const axis = axisFor(allStats, opts.logScale);
  let y0 = headerH;
  panels.forEach((panel, idx) => {
    drawPanel(ctx, panel, {
      rowH,
      x0: MARGIN + gutter,
      y0,
      plotW,
      kind: opts.kind,
      logScale: opts.logScale,
      axisTitle: `Slowdown vs ${groups[idx].baseline} (×)${opts.logScale ? ', log scale' : ''}`,
      formatValue: formatSlowdown,
      axis,
      referenceValue: 1,
    });
    drawRowLabels(ctx, panel, rowH, MARGIN, y0);
    y0 += panelHeights[idx] + PANEL_GAP;
  });

  return encodePlot(canvas, opts.format);
}

/**
 * Compares the slowdown of the analyses of the tools of `groups` in one panel
 * with one shared axis. Matching analyses of the first two (see
 * `compareAnalyses`) are in adjacent rows, one colour per tool; the tools
 * after the second share the analysis names of the second. Analyses without a
 * match come last.
 */
function renderSlowdownComparisonPlot(groups, pairs, opts) {
  const [first, second] = groups;
  const data = groups.map(analysisData);
  const comparison = compareAnalyses(first, second, pairs);
  const tools = groups.map((g) => g.label).join(' vs ');

  const rows = [];
  const values = new Map();
  const failedKeys = [];
  for (const group of comparison) {
    let firstOfGroup = true;
    groups.forEach((_, side) => {
      const analysis = side === 0 ? group.first : group.second;
      if (analysis === undefined) return;
      const key = `${groups[side].label}\u0000${analysis}`;
      rows.push({
        key,
        label: analysis,
        color: TOOL_COLORS[side],
        gapBefore: firstOfGroup && rows.length > 0 ? GROUP_GAP : 0,
      });
      firstOfGroup = false;
      const slowdowns = data[side].get(analysis);
      if (slowdowns !== undefined) values.set(key, slowdowns);
      else failedKeys.push(key);
    });
  }
  const panel = makePanel(tools, () => '', rows, values, failedKeys, true);
  const allStats = [...panel.stats.values()];
  if (allStats.length === 0) throw new Error('There is no data to plot');
  const allSingle = allStats.every((s) => s.count === 1);

  const notes = slowdownNotes(groups, allStats, opts.kind);
  const matched = comparison.filter(
    (g) => g.first !== undefined && g.second !== undefined,
  );
  if (matched.length > 0) {
    notes.push(
      `Analyses next to each other are compared (${first.label} = ${second.label}): ${matched.map((g) => `${g.first} = ${g.second}`).join(', ')}.` +
        (matched.length < comparison.length
          ? ' Analyses without a match come last.'
          : ''),
    );
  }

  const width = opts.width;
  const rowH = ROW_H[opts.kind];
  const scratch = createCanvas(1, 1).getContext('2d');
  setFont(scratch, 12);
  const gutter = labelGutter(scratch, [panel]);
  const noteLines = wrapNotes(scratch, notes, width);

  const plotW = width - 2 * MARGIN - gutter - LABEL_PAD;
  const legend = {
    // The colours name the tools here, so the sample shapes are neutral.
    accent: COLORS.inkSecondary,
    tools: groups.map((g, i) => ({
      label: `${g.label} (baseline: ${g.baseline})`,
      color: TOOL_COLORS[i],
    })),
  };
  const headerH = headerHeight(noteLines, legend, opts.title);
  const panelH = PANEL_TITLE_H + plotAreaHeight(rows, rowH) + AXIS_H;
  const height = headerH + panelH + MARGIN;

  const { canvas, ctx } = createPlotCanvas(opts.format, width, height);
  drawHeader(ctx, {
    title: plotTitle(opts.title, `Slowdown of matching analyses, ${tools}`),
    subtitle:
      groups.map((g) => `${g.label}: ${g.modules} Wasm modules`).join(', ') +
      `. One ${opts.logScale ? 'log' : 'linear'} x-axis for all rows.`,
    noteLines,
    height: headerH,
    kind: opts.kind,
    showSpread: !allSingle,
    legend,
  });

  drawPanel(ctx, panel, {
    rowH,
    x0: MARGIN + gutter,
    y0: headerH,
    plotW,
    kind: opts.kind,
    logScale: opts.logScale,
    axisTitle: `Slowdown vs the baseline of each tool (×)${opts.logScale ? ', log scale' : ''}`,
    formatValue: formatSlowdown,
    axis: axisFor(allStats, opts.logScale),
    referenceValue: 1,
  });
  drawRowLabels(ctx, panel, rowH, MARGIN, headerH);

  return encodePlot(canvas, opts.format);
}

// ---------------------------------------------------------------------------
// Slowdown per Wasm module, compared between two tools
// ---------------------------------------------------------------------------

/**
 * The runs of one analysis on one Wasm module.
 *
 * @typedef {Object} ModuleCell
 * @property {Stats} [runs] - Statistics of the measured times; undefined when every run failed.
 * @property {Stats} [slowdown] - Statistics of the slowdown of every run; undefined without a baseline.
 * @property {number} failedRuns
 * @property {FailureKind} [failure]
 */

/**
 * The slowdown of every analysis on every Wasm module of one tool.
 *
 * @typedef {Object} ModuleSlowdowns
 * @property {string} label - The tool that produced the CSV, shown in the plot.
 * @property {string} baseline
 * @property {string} [runtime] - The runtime the tool instruments, e.g. `warduino`. Its baseline runs are named after it in the plots, and its analyses `<label> + <runtime>`.
 * @property {string} [analyzer] - How the analyses are named in the plots instead of `label`, e.g. `wei`.
 * @property {string} [timeColumn] - The CSV column of the times, as named in the plots; `total_ms` by default.
 * @property {Map<string, number>} baselineMedians - Median time of the baseline per Wasm module that has a successful run.
 * @property {Map<string, Map<string, ModuleCell>>} cells - Wasm module -> analysis -> its runs, the baseline included.
 * @property {number} failedRuns - Number of failed runs, baseline runs included.
 */

/**
 * The slowdown of a run is its time divided by the median time of the
 * baseline on the same Wasm module, so 1 means as fast as the baseline and 2
 * twice as slow. The median keeps a single outlying baseline run from shifting
 * every slowdown of a module. Analyses on a module without a successful
 * baseline run have statistics of their times but no slowdown.
 */
export function computeModuleSlowdowns(
  label,
  { samples, failures, failureKinds, skippedRows },
  baseline,
  runtime,
  analyzer,
) {
  const baselineMedians = new Map();
  const cells = new Map();
  const wasms = [...new Set([...samples.keys(), ...failures.keys()])].sort();
  for (const wasm of wasms) {
    const baselineRuns = samples.get(wasm)?.get(baseline);
    const base = baselineRuns ? computeStats(baselineRuns).median : 0;
    if (base > 0) baselineMedians.set(wasm, base);

    const perWasm = new Map();
    const analyses = [
      ...(samples.get(wasm)?.keys() ?? []),
      ...(failures.get(wasm)?.keys() ?? []),
    ];
    for (const analysis of orderAnalyses(analyses)) {
      const values = samples.get(wasm)?.get(analysis);
      perWasm.set(analysis, {
        runs: values && computeStats(values),
        slowdown:
          values && base > 0
            ? computeStats(values.map((v) => v / base))
            : undefined,
        failedRuns: failures.get(wasm)?.get(analysis) ?? 0,
        failure: failureKinds.get(wasm)?.get(analysis),
      });
    }
    cells.set(wasm, perWasm);
  }
  if (baselineMedians.size === 0) {
    throw new Error(
      `${label}: no successful run of the baseline '${baseline}' found`,
    );
  }
  return {
    label,
    baseline,
    runtime,
    analyzer,
    baselineMedians,
    cells,
    failedRuns: skippedRows,
  };
}

/** The analyses of a tool other than its baseline, sorted. */
export function moduleAnalyses(tool) {
  const names = new Set();
  for (const perWasm of tool.cells.values()) {
    for (const analysis of perWasm.keys()) {
      if (analysis !== tool.baseline) names.add(analysis);
    }
  }
  return [...names].sort();
}

function csvNumber(v) {
  return v === undefined ? '' : `${Number(v.toPrecision(6))}`;
}

/**
 * @typedef {Object} ComparisonPlotOptions
 * @property {PlotFormat} format
 * @property {string | false} [title] - The title; a default one when undefined, none when false.
 * @property {number} width - Logical width; the height follows from the number of panels.
 * @property {boolean} [absolute] - Plot the measured times (ms) instead of the slowdowns, the baselines included as a panel of their own.
 * @property {number} [timeoutMinutes] - The time limit of a run, shown with the marker of a timeout.
 * @property {boolean} [showMinMax] - Whether bars get a whisker from the min to the max of the runs; default true.
 * @property {boolean} [isolateSpawn] - Phases plot only: draw spawning as a bar of its own next to the stack of the other phases instead of in it.
 */

/** A number with exactly two decimals and thousands separators: `2,132.40`. */
function twoDecimals(v) {
  return v.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * A duration written on a bar, always in seconds with two decimals, so values
 * next to each other compare at a glance: `0.02 s`, `1.18 s`, `420.00 s`.
 */
function barSeconds(ms) {
  return `${twoDecimals(ms / 1000)} s`;
}

/** A slowdown written on a bar, with two decimals: `1.03×`, `2,132.40×`. */
function barSlowdown(v) {
  return `${twoDecimals(v)}×`;
}

/** A duration on an axis: `20 ms`, `1.5 s`. */
export function formatDuration(ms) {
  return ms >= 1000
    ? `${Number((ms / 1000).toPrecision(3)).toLocaleString('en-US')} s`
    : `${Number(ms.toPrecision(3))} ms`;
}

const COMPARISON_COLUMNS = 2;
const BAR_PLOT_H = 190;
/** Room left of a panel's plot area for the tick labels of the y-axis. */
const Y_AXIS_W = 74;

/** The title of a y-axis, rotated, centred on the plot area left of the ticks. */
function drawYAxisTitle(ctx, text, x, top, bottom) {
  ctx.save();
  ctx.translate(x, (top + bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = COLORS.inkSecondary;
  setFont(ctx, 11);
  ctx.textAlign = 'center';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}
const MAX_BAR_W = 18;
/** Surface gap between the bars of one tool on a Wasm module. */
const BAR_GAP = 1;
/** Surface gap between the bars of the two tools on a Wasm module. */
const TOOL_GAP = 2;
/**
 * The share of its slot the bars of a Wasm module take at most; the rest
 * separates it from the next module.
 */
const GROUP_FILL = { twoBars: 0.6, moreBars: 0.7 };
const X_LABEL_ANGLE = Math.PI / 4;
/** Room above a plot area for the values written over the tallest bars. */
const VALUE_LABEL_H = 40;
const VALUE_FONT_PX = 8.5;
/** How far above the axis line the letter of a missing bar sits. */
const MARKER_LIFT = 2.5;

/**
 * One bar per Wasm module in a panel of the per-module comparison.
 *
 * @typedef {Object} BarSeries
 * @property {number} side - The tool: its index, 0 for the first.
 * @property {boolean} baseline - Whether the bar is the tool's baseline rather than the analysis.
 * @property {string} color
 * @property {string} label
 */

/** The CSV column of the times of a tool, as named in the plots. */
export function timeColumnOf(tool) {
  return tool.timeColumn ?? 'total_ms';
}

/** How the baseline runs of a tool are named in the plots. */
export function baselineName(tool) {
  return tool.runtime ?? `${tool.label} ${tool.baseline}`;
}

/** How the analysis runs of a tool are named in the plots. */
export function analysisName(tool) {
  const name = tool.analyzer ?? tool.label;
  return tool.runtime !== undefined
    ? `${name} + ${tool.runtime}`
    : `${name} analysis`;
}

/** `hex` mixed with the surface, for a lighter bar of the same hue. */
function tint(hex, amount = 0.45) {
  const channels = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const surface = channels(COLORS.surface);
  return (
    '#' +
    channels(hex)
      .map((c, i) =>
        Math.round(c * amount + surface[i] * (1 - amount))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** Why a tool has no bar for an analysis on a Wasm module. */
const MISSING_MARKERS = {
  timeout: { symbol: 'T', label: 'timed out' },
  error: { symbol: 'E', label: 'failed with an error' },
  missing: { symbol: '–', label: 'no data' },
};
const NO_BASELINE_LABEL = 'no data or no successful baseline run';

function missingMarker(cell) {
  if (cell?.runs === undefined && cell?.failure !== undefined) {
    return MISSING_MARKERS[cell.failure];
  }
  return MISSING_MARKERS.missing;
}

/**
 * The bar of a series on a Wasm module, or the cell that says why there is none.
 *
 * @typedef {Object} BarValue
 * @property {Stats} [stats]
 * @property {ModuleCell} [cell]
 */

/**
 * What `renderBarChart` draws: panels of bars per Wasm module, one axis.
 *
 * @typedef {Object} BarChartSpec
 * @property {string} [title] - No title is drawn when undefined.
 * @property {BarSeries[]} series - The bars of every Wasm module, left to right.
 * @property {string[]} wasms
 * @property {{title: string; bar: (wasm: string, series: BarSeries) => BarValue;}[]} panels
 * @property {Axis} axis
 * @property {(v: number) => string} formatTick
 * @property {(v: number) => string} formatValue - How the value written on a bar is formatted.
 * @property {'mean' | 'median'} average - What a bar's height and its written value are.
 * @property {string} yTitle - What the y-axis shows, with its unit.
 * @property {number} [base] - The value bars grow from; the bottom of the axis when undefined.
 * @property {string} missingLabel
 * @property {number} columns
 * @property {number} plotH
 * @property {ComparisonPlotOptions} opts
 */

/** The Wasm modules of the tools, sorted by the name shown. */
function comparedWasms(tools, include = () => true) {
  return [...new Set(tools.flatMap((t) => [...t.cells.keys()]))]
    .filter(include)
    .sort((a, b) => wasmDisplayName(a).localeCompare(wasmDisplayName(b)));
}

/** The statistics of values that are all multiplied by `factor` > 0. */
function scaleStats(s, factor) {
  return {
    count: s.count,
    mean: s.mean * factor,
    median: s.median * factor,
    min: s.min * factor,
    max: s.max * factor,
    stdev: s.stdev * factor,
    q1: s.q1 * factor,
    q3: s.q3 * factor,
  };
}

/**
 * One small-multiple panel per analysis that the first two tools have (see
 * `matchAnalyses`), all sharing one log y-axis; the tools after the second
 * share the analysis names of the second. Every Wasm module gets a bar per
 * tool from 1× to the median slowdown of its runs, with a whisker from the
 * min to the max. A letter replaces the bar of runs that timed out or failed.
 * With `opts.absolute` the bars are the mean times instead, and every
 * tool gets a lighter bar for its baseline next to the bar of the analysis.
 */
export function renderModuleComparisonPlot(tools, pairs, opts) {
  const [first, second] = tools;
  const absolute = opts.absolute === true;
  const matched = matchAnalyses(
    moduleAnalyses(first),
    moduleAnalyses(second),
    pairs,
  ).filter((g) => g.first !== undefined && g.second !== undefined);
  if (matched.length === 0) {
    throw new Error(
      `${first.label} and ${second.label} have no analysis in common, pass --pair to match them`,
    );
  }
  const wasms = comparedWasms(tools, (wasm) =>
    matched.some((g) =>
      tools.some((tool, side) =>
        tool.cells.get(wasm)?.has(side === 0 ? g.first : g.second),
      ),
    ),
  );

  // The bars of a Wasm module, left to right. Times show the baseline of each
  // tool as well, in a tint of the tool's colour, before its analysis.
  const series = absolute
    ? tools.flatMap((tool, side) => [
        {
          side,
          baseline: true,
          color: tint(TOOL_COLORS[side]),
          label: baselineName(tool),
        },
        {
          side,
          baseline: false,
          color: TOOL_COLORS[side],
          label: analysisName(tool),
        },
      ])
    : tools.map((tool, side) => ({
        side,
        baseline: false,
        color: TOOL_COLORS[side],
        label: `${analysisName(tool)} (baseline: ${baselineName(tool)})`,
      }));
  const barOf = (group) => (wasm, bar) => {
    const tool = tools[bar.side];
    const analysis = bar.baseline
      ? tool.baseline
      : bar.side === 0
        ? group.first
        : group.second;
    const cell = tool.cells.get(wasm)?.get(analysis);
    return { stats: absolute ? cell?.runs : cell?.slowdown, cell };
  };
  const panels = matched.map((group) => ({
    // The analysis, by the name the second tool gives it.
    title: group.second,
    bar: barOf(group),
  }));
  const all = panels.flatMap((p) =>
    wasms.flatMap((wasm) => series.flatMap((s) => p.bar(wasm, s).stats ?? [])),
  );
  if (all.length === 0) throw new Error('There is no data to plot');

  return renderBarChart({
    title: plotTitle(
      opts.title,
      `${absolute ? 'Time' : 'Slowdown'} per Wasm module and analysis, ${tools.map((t) => t.label).join(' vs ')}`,
    ),
    series,
    wasms,
    panels,
    // Slowdowns start at 1×, the baseline, so every bar grows up from it.
    axis: absolute
      ? logAxis(
          Math.min(...all.map((s) => s.min).filter((v) => v > 0)),
          Math.max(...all.map((s) => s.max)),
        )
      : logAxis(1, Math.max(1, ...all.map((s) => s.max)), 1),
    formatTick: absolute ? formatDuration : formatSlowdown,
    formatValue: absolute ? barSeconds : barSlowdown,
    // Times are the mean of the runs, slowdowns their median.
    average: absolute ? 'mean' : 'median',
    yTitle: absolute
      ? 'Time (log scale)'
      : 'Slowdown vs. baseline (×, log scale)',
    base: absolute ? undefined : 1,
    missingLabel: absolute ? MISSING_MARKERS.missing.label : NO_BASELINE_LABEL,
    columns: Math.min(COMPARISON_COLUMNS, panels.length),
    plotH: BAR_PLOT_H,
    opts,
  });
}

/**
 * Compares the baselines of the tools, the runtimes without analysis, in one
 * panel. With `opts.absolute` every Wasm module gets a bar per runtime with its
 * mean time; otherwise a bar per runtime after the first with its time
 * relative to the median time of the first, below 1× when it is faster.
 */
export function renderBaselineComparisonPlot(tools, opts) {
  const [first, ...others] = tools;
  const absolute = opts.absolute === true;
  const wasms = comparedWasms(tools, (wasm) =>
    tools.some((t) => t.cells.get(wasm)?.has(t.baseline)),
  );
  const cellOf = (tool, wasm) => tool.cells.get(wasm)?.get(tool.baseline);

  const series = absolute
    ? tools.map((tool, side) => ({
        side,
        baseline: true,
        color: tint(TOOL_COLORS[side]),
        label: baselineName(tool),
      }))
    : others.map((tool, i) => ({
        side: i + 1,
        baseline: true,
        color: tint(TOOL_COLORS[i + 1]),
        label: `${baselineName(tool)} relative to ${baselineName(first)} (${timeColumnOf(tool)} / median ${timeColumnOf(first)})`,
      }));
  const bar = (wasm, s) => {
    if (absolute) {
      const cell = cellOf(tools[s.side], wasm);
      return { stats: cell?.runs, cell };
    }
    const reference = cellOf(first, wasm);
    const cell = cellOf(tools[s.side], wasm);
    if (reference?.runs === undefined) return { cell: reference };
    if (cell?.runs === undefined) return { cell };
    return { stats: scaleStats(cell.runs, 1 / reference.runs.median), cell };
  };
  const all = wasms.flatMap((wasm) =>
    series.flatMap((s) => bar(wasm, s).stats ?? []),
  );
  if (all.length === 0) throw new Error('There is no data to plot');
  const min = Math.min(...all.map((s) => s.min).filter((v) => v > 0));
  const max = Math.max(...all.map((s) => s.max));

  return renderBarChart({
    title: plotTitle(
      opts.title,
      absolute
        ? `Time per Wasm module without analysis, ${tools.map(baselineName).join(' vs ')}`
        : `Time of ${others.map(baselineName).join(' and ')} relative to ${baselineName(first)} per Wasm module, without analysis`,
    ),
    series,
    wasms,
    panels: [{ title: '', bar }],
    axis: absolute
      ? logAxis(min, max)
      : // Room below the lowest bar for the value written under it.
        logAxis(Math.min(1, min) / 3, Math.max(1, max)),
    formatTick: absolute ? formatDuration : formatSlowdown,
    formatValue: absolute ? barSeconds : barSlowdown,
    // Times are the mean of the runs, slowdowns their median.
    average: absolute ? 'mean' : 'median',
    yTitle: absolute
      ? 'Time (log scale)'
      : others.length === 1
        ? `${baselineName(others[0])} / ${baselineName(first)} time (×, log scale)`
        : `Time / ${baselineName(first)} time (×, log scale)`,
    base: absolute ? undefined : 1,
    missingLabel: MISSING_MARKERS.missing.label,
    columns: 1,
    plotH: 2 * BAR_PLOT_H,
    opts,
  });
}

/**
 * Renders the title, the legend and the panels of `spec`: per Wasm module a
 * bar for every series from the base to the mean or median, with a whisker from the
 * min to the max, or a letter saying why there is no bar.
 */
function renderBarChart(spec) {
  const { series, wasms, panels, axis, formatTick, columns, plotH, opts } =
    spec;
  const showMinMax = opts.showMinMax !== false;
  const width = opts.width;
  const scratch = createCanvas(1, 1).getContext('2d');
  setFont(scratch, 11);
  const longestLabel = Math.max(
    ...wasms.map((w) => scratch.measureText(wasmDisplayName(w)).width),
  );
  const xLabelH = Math.ceil(longestLabel * Math.sin(X_LABEL_ANGLE)) + 22;

  const panelRows = Math.ceil(panels.length / columns);
  const panelW = (width - 2 * MARGIN - (columns - 1) * COLUMN_GAP) / columns;
  const plotW = panelW - Y_AXIS_W;

  // Bars of one tool are BAR_GAP apart, the tools TOOL_GAP.
  const gaps = series.map((bar, k) =>
    k === 0 ? 0 : bar.side === series[k - 1].side ? BAR_GAP : TOOL_GAP,
  );
  const gapsW = gaps.reduce((sum, g) => sum + g, 0);
  const groupW = plotW / wasms.length;
  const barW = Math.min(
    MAX_BAR_W,
    (groupW * (series.length > 2 ? GROUP_FILL.moreBars : GROUP_FILL.twoBars) -
      gapsW) /
      series.length,
  );

  /**
   * The bars of a panel whose plot area starts at `x0`, `plotTop`, with the
   * values written on them placed so that none overlaps another or a bar.
   */
  const layoutPanel = (panel, x0, plotTop) => {
    const plotBottom = plotTop + plotH;
    const py = (v) => plotBottom - axis.position(v) * plotH;
    const baseY =
      spec.base === undefined
        ? plotBottom + 0.5
        : Math.round(py(spec.base)) + 0.5;
    const bars = [];
    wasms.forEach((wasm, i) => {
      const center = x0 + (i + 0.5) * groupW;
      let left = center - (series.length * barW + gapsW) / 2 - barW;
      series.forEach((s, k) => {
        left += barW + gaps[k];
        const { stats, cell } = panel.bar(wasm, s);
        const value =
          stats === undefined
            ? undefined
            : spec.average === 'mean'
              ? stats.mean
              : stats.median;
        bars.push({ left, series: s, stats, cell, value });
      });
    });
    const labels = placeValueLabels(
      scratch,
      bars.flatMap((b) => {
        if (b.stats === undefined || b.value === undefined) return [];
        // Past the end of the whisker, or of the bar without one.
        const minY = py(showMinMax ? b.stats.min : b.value);
        const maxY = py(showMinMax ? b.stats.max : b.value);
        const up = maxY <= baseY;
        return [
          {
            text: spec.formatValue(b.value),
            x: b.left + barW / 2,
            anchor: up ? maxY - 3 : minY + 3,
            up,
          },
        ];
      }),
      bars.flatMap((b) =>
        b.stats === undefined || b.value === undefined
          ? []
          : [
              {
                left: b.left,
                right: b.left + barW,
                // The whisker as well, when it is drawn.
                top: Math.min(baseY, py(showMinMax ? b.stats.max : b.value)),
                bottom: Math.max(baseY, py(showMinMax ? b.stats.min : b.value)),
              },
            ],
      ),
    );
    return { bars, labels, py, baseY, plotBottom };
  };

  // Room above and below the plot areas for the values that were moved.
  let labelsAbove = VALUE_LABEL_H;
  let labelsBelow = 0;
  for (const panel of panels) {
    for (const l of layoutPanel(panel, 0, 0).labels) {
      labelsAbove = Math.max(labelsAbove, Math.ceil(-l.top) + 4);
      labelsBelow = Math.max(labelsBelow, Math.ceil(l.bottom - plotH));
    }
  }
  const panelH =
    PANEL_TITLE_H + 8 + labelsAbove + plotH + labelsBelow + xLabelH;
  const legend = comparisonLegend(
    series,
    spec.missingLabel,
    opts.timeoutMinutes,
    showMinMax,
  );
  const legendLines = layoutLegend(scratch, legend, width - 2 * MARGIN).length;
  // The title, then the legend.
  const headerH =
    (spec.title === undefined ? 88 - 36 : 88) +
    (legendLines - 1) * LEGEND_LINE_H;
  const height =
    headerH + panelRows * panelH + (panelRows - 1) * PANEL_GAP + MARGIN;

  const { canvas, ctx } = createPlotCanvas(opts.format, width, height);

  if (spec.title !== undefined) {
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.ink;
    setFont(ctx, 20, 'bold');
    ctx.fillText(spec.title, MARGIN, MARGIN + 18);
  }
  drawComparisonLegend(
    ctx,
    legend,
    MARGIN,
    headerH - 16 - (legendLines - 1) * LEGEND_LINE_H,
    width - 2 * MARGIN,
  );

  panels.forEach((panel, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    const x0 = MARGIN + col * (panelW + COLUMN_GAP) + Y_AXIS_W;
    const y0 = headerH + row * (panelH + PANEL_GAP);
    const plotTop = y0 + PANEL_TITLE_H + 8 + labelsAbove;
    const { bars, labels, py, baseY, plotBottom } = layoutPanel(
      panel,
      x0,
      plotTop,
    );

    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.ink;
    setFont(ctx, 13, 'bold');
    ctx.fillText(panel.title, x0 - Y_AXIS_W, y0 + 14);

    // Recessive grid with the tick labels.
    ctx.lineWidth = 1;
    setFont(ctx, 10);
    ctx.textAlign = 'right';
    for (const t of axis.ticks) {
      const y = Math.round(py(t)) + 0.5;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + plotW, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(formatTick(t), x0 - 6, y + 3);
    }
    drawYAxisTitle(ctx, spec.yTitle, x0 - Y_AXIS_W + 8, plotTop, plotBottom);

    for (const { left, series: s, stats, cell, value } of bars) {
      const barCenter = left + barW / 2;
      if (stats === undefined || value === undefined) {
        // No bar, only a letter in text ink that says why.
        ctx.fillStyle = COLORS.inkSecondary;
        setFont(ctx, 10, 'bold');
        ctx.textAlign = 'center';
        ctx.fillText(
          missingMarker(cell).symbol,
          barCenter,
          baseY - MARKER_LIFT,
        );
        continue;
      }
      drawBar(ctx, left, barW, baseY, py(value), s.color);
      if (showMinMax && stats.max > stats.min) {
        ctx.strokeStyle = COLORS.ink;
        ctx.lineWidth = 1;
        const x = Math.round(barCenter) + 0.5;
        const capW = Math.min(3, barW / 2 - 1);
        ctx.beginPath();
        ctx.moveTo(x, py(stats.min));
        ctx.lineTo(x, py(stats.max));
        ctx.moveTo(x - capW, py(stats.min));
        ctx.lineTo(x + capW, py(stats.min));
        ctx.moveTo(x - capW, py(stats.max));
        ctx.lineTo(x + capW, py(stats.max));
        ctx.stroke();
      }
    }
    for (const label of labels) drawBarValue(ctx, label);

    wasms.forEach((wasm, i) => {
      // The Wasm module, slanted so long names fit under narrow groups.
      ctx.save();
      ctx.translate(x0 + (i + 0.5) * groupW, plotBottom + labelsBelow + 12);
      ctx.rotate(-X_LABEL_ANGLE);
      ctx.fillStyle = COLORS.inkSecondary;
      setFont(ctx, 11);
      ctx.textAlign = 'right';
      ctx.fillText(wasmDisplayName(wasm), 0, 4);
      ctx.restore();
    });

    ctx.strokeStyle = COLORS.inkSecondary;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0, baseY);
    ctx.lineTo(x0 + plotW, baseY);
    ctx.stroke();
  });

  return encodePlot(canvas, opts.format);
}

/**
 * A bar of `renderBarChart` at `left`, or the cell that says why there is none.
 *
 * @typedef {Object} PlacedBar
 * @property {number} left
 * @property {BarSeries} series
 * @property {Stats} [stats]
 * @property {ModuleCell} [cell]
 * @property {number} [value] - The height of the bar: the mean or median of `stats`.
 */

/**
 * A box on the canvas that a value written on a bar must not overlap.
 *
 * @typedef {Object} Box
 * @property {number} left
 * @property {number} right
 * @property {number} top
 * @property {number} bottom
 */

/**
 * A value written on a bar, rotated: it starts at `x`, `start` and runs up
 * from there for a bar that grows up, down for one that grows down, within
 * the box it extends.
 *
 * @typedef {Box & Object} ValueLabel
 * @property {string} text
 * @property {number} x
 * @property {number} start
 * @property {boolean} up
 * @property {number} anchor - Where the value would have started had nothing been in its way.
 */

/** Room between a value written on a bar and what it is moved past. */
const VALUE_LABEL_PAD = 2;
/** How far a value must have moved from its bar to get a leader line. */
const VALUE_LEADER_MIN = 6;

/**
 * Places the values written on bars, each starting at its `anchor`. A value
 * that would overlap one placed before it or a bar in `obstacles` moves away
 * from its bar, past what it overlaps, so values of bars close in height
 * sit above each other instead of on top of each other.
 */
function placeValueLabels(ctx, labels, obstacles) {
  setFont(ctx, VALUE_FONT_PX);
  // How far the rotated glyphs reach left and right of `x`.
  const halfW = VALUE_FONT_PX * 0.45;
  const placed = [];
  for (const { text, x, anchor, up } of labels) {
    const length = ctx.measureText(text).width;
    const box = (start) => ({
      left: x - halfW,
      right: x + halfW,
      top: up ? start - length : start,
      bottom: up ? start : start + length,
    });
    let start = anchor;
    for (;;) {
      const b = box(start);
      const hit = [...obstacles, ...placed].find(
        (o) =>
          o.left < b.right &&
          o.right > b.left &&
          o.top < b.bottom + VALUE_LABEL_PAD &&
          o.bottom > b.top - VALUE_LABEL_PAD,
      );
      if (hit === undefined) break;
      start = up ? hit.top - VALUE_LABEL_PAD : hit.bottom + VALUE_LABEL_PAD;
    }
    placed.push({ text, x, start, up, anchor, ...box(start) });
  }
  return placed;
}

/**
 * A value placed by `placeValueLabels`, rotated to fit narrow bars. A value
 * that was moved away from its bar gets a thin leader line back to it, down
 * the middle of the bar's column.
 */
function drawBarValue(ctx, label) {
  if (Math.abs(label.start - label.anchor) > VALUE_LEADER_MIN) {
    const x = Math.round(label.x) + 0.5;
    const toward = label.up ? 1 : -1;
    ctx.strokeStyle = COLORS.axis;
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(x, label.start + toward);
    ctx.lineTo(x, label.anchor + toward);
    ctx.stroke();
  }
  ctx.save();
  // The glyphs sit above their baseline, which is left of it once rotated.
  ctx.translate(label.x + VALUE_FONT_PX * 0.35, label.start);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = COLORS.inkSecondary;
  setFont(ctx, VALUE_FONT_PX);
  ctx.textAlign = label.up ? 'left' : 'right';
  ctx.fillText(label.text, 0, 0);
  ctx.restore();
}

/**
 * A bar from `baseY` to `valueY`, with the corners at the data end rounded.
 * Bars below the baseline (a speed-up) grow downwards.
 */
function drawBar(ctx, x, w, baseY, valueY, color) {
  const h = Math.abs(baseY - valueY);
  if (h < 0.5) return;
  const r = Math.min(4, w / 2, h);
  const up = valueY < baseY;
  ctx.beginPath();
  if (up) {
    ctx.moveTo(x, baseY);
    ctx.lineTo(x, valueY + r);
    ctx.arcTo(x, valueY, x + r, valueY, r);
    ctx.lineTo(x + w - r, valueY);
    ctx.arcTo(x + w, valueY, x + w, valueY + r, r);
    ctx.lineTo(x + w, baseY);
  } else {
    ctx.moveTo(x, baseY);
    ctx.lineTo(x, valueY - r);
    ctx.arcTo(x, valueY, x + r, valueY, r);
    ctx.lineTo(x + w - r, valueY);
    ctx.arcTo(x + w, valueY, x + w, valueY - r, r);
    ctx.lineTo(x + w, baseY);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** The distance between the lines of a legend that wraps. */
const LEGEND_LINE_H = 20;

/**
 * An entry of a legend: a sample drawn at `x`, `y`, then its text.
 *
 * @typedef {Object} LegendItem
 * @property {string} text
 * @property {number} sampleW
 * @property {(ctx: CanvasRenderingContext2D, x: number, y: number) => void} drawSample
 */

/** The tools by colour, the whisker, and the letters of the missing bars. */
function comparisonLegend(
  series,
  missingLabel,
  timeoutMinutes,
  showMinMax = true,
) {
  const items = series.map((bar) => ({
    text: bar.label,
    sampleW: 10,
    drawSample: (ctx, x, y) => drawBar(ctx, x, 10, y + 2, y - 11, bar.color),
  }));

  if (showMinMax) {
    items.push({
      text: 'min to max',
      sampleW: 11,
      drawSample: (ctx, x, y) => {
        ctx.strokeStyle = COLORS.ink;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 5.5, y - 12);
        ctx.lineTo(x + 5.5, y + 2);
        ctx.moveTo(x + 2.5, y - 12);
        ctx.lineTo(x + 8.5, y - 12);
        ctx.moveTo(x + 2.5, y + 2);
        ctx.lineTo(x + 8.5, y + 2);
        ctx.stroke();
      },
    });
  }

  for (const [kind, marker] of Object.entries(MISSING_MARKERS)) {
    items.push({
      text:
        kind === 'missing'
          ? missingLabel
          : kind === 'timeout' && timeoutMinutes !== undefined
            ? `${marker.label} (${timeoutMinutes} min)`
            : marker.label,
      sampleW: 10,
      drawSample: (ctx, x, y) => {
        ctx.fillStyle = COLORS.inkSecondary;
        setFont(ctx, 11, 'bold');
        ctx.textAlign = 'center';
        ctx.fillText(marker.symbol, x + 5, y);
      },
    });
  }
  return items;
}

/** The items of a legend per line, each with its offset, within `maxW`. */
function layoutLegend(ctx, items, maxW) {
  setFont(ctx, 12);
  const lines = [[]];
  let dx = 0;
  for (const item of items) {
    const w = item.sampleW + 8 + ctx.measureText(item.text).width;
    if (dx > 0 && dx + w > maxW) {
      lines.push([]);
      dx = 0;
    }
    lines[lines.length - 1].push({ item, dx });
    dx += w + 26;
  }
  return lines;
}

/** Draws `items` from `x`, `y` on, wrapped onto more lines within `maxW`. */
function drawComparisonLegend(ctx, items, x, y, maxW) {
  layoutLegend(ctx, items, maxW).forEach((line, i) => {
    const ly = y + i * LEGEND_LINE_H;
    for (const { item, dx } of line) {
      item.drawSample(ctx, x + dx, ly);
      setFont(ctx, 12);
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.inkSecondary;
      ctx.fillText(item.text, x + dx + item.sampleW + 8, ly);
    }
  });
}

/** Renders the comparison of the baselines and writes it to `outputPath`. */
export function writeBaselineComparisonPlot(tools, opts, outputPath) {
  fs.writeFileSync(outputPath, renderBaselineComparisonPlot(tools, opts));
}

/** Renders the per-module comparison and writes it to `outputPath`. */
export function writeModuleComparisonPlot(tools, pairs, opts, outputPath) {
  fs.writeFileSync(outputPath, renderModuleComparisonPlot(tools, pairs, opts));
}

// ---------------------------------------------------------------------------
// The phases that make up the total time of wasmito
// ---------------------------------------------------------------------------

/** The phases of a wasmito run, in the order they happen; they add up to total_ms. */
export const PHASES = [
  'parsing_ms',
  'spawn_ms',
  'register_ms',
  'deploy_ms',
  'run_ms',
];
/**
 * @typedef {(typeof PHASES)[number]} Phase
 */

/**
 * The first five categorical hues in their validated order, bottom to top of
 * a stack.
 */
const PHASE_COLORS = {
  parsing_ms: '#2a78d6',
  spawn_ms: '#eb6834',
  register_ms: '#1baf7a',
  deploy_ms: '#eda100',
  run_ms: '#e87ba4',
};

/** How the phases are named in the plot. */
export const PHASE_LABELS = {
  parsing_ms: 'parse wasm',
  spawn_ms: 'spawn',
  register_ms: 'register advices',
  deploy_ms: 'deploy hooks',
  run_ms: 'run analysis',
};

/**
 * The mean time of every phase of the runs of one analysis on one Wasm module.
 *
 * @typedef {Object} PhaseBreakdown
 * @property {number} runs
 * @property {Partial<Record<Phase, number>>} means - The mean of every phase the CSV has a column for.
 * @property {number} total - Mean total_ms.
 * @property {number} unattributed - The part of `total` that no phase accounts for (rounding, bookkeeping).
 */

/**
 * Per analysis and Wasm module, the phase breakdown, or why every run failed.
 *
 * @typedef {Map<string, Map<string, PhaseBreakdown | FailureKind>>} PhaseBreakdowns
 */

/** The phases of `breakdowns`, in order: those the CSV has a column for. */
export function breakdownPhases(breakdowns) {
  const present = new Set();
  for (const perAnalysis of breakdowns.values()) {
    for (const b of perAnalysis.values()) {
      if (typeof b === 'object')
        Object.keys(b.means).forEach((p) => present.add(p));
    }
  }
  return PHASES.filter((p) => present.has(p));
}

/**
 * The mean time of phase `p` of `phases`. The few ms no phase accounts for
 * count as spawning, or without it as running, so the phases add up to the
 * total exactly.
 */
export function phaseTime(b, p, phases) {
  const catchAll = phases.includes('spawn_ms')
    ? 'spawn_ms'
    : phases[phases.length - 1];
  return (b.means[p] ?? 0) + (p === catchAll ? b.unattributed : 0);
}

/**
 * Means are used, not medians, because the means of the phases add up to the
 * mean total time while their medians do not. Phases without a column in the
 * CSV, e.g. `spawn_ms` after `withoutSpawn`, are left out.
 */
export function computePhaseBreakdowns(content) {
  const total = parseBenchmarkCsv(content, 'total_ms');
  const header = (content.replace(/^\uFEFF/, '').split(/\r?\n/)[0] ?? '')
    .split(',')
    .map((h) => h.trim());
  const present = PHASES.filter((phase) => header.includes(phase));
  const phases = present.map((phase) => parseBenchmarkCsv(content, phase));
  const mean = (values) =>
    values.reduce((sum, v) => sum + v, 0) / values.length;

  const result = new Map();
  const wasms = new Set([...total.samples.keys(), ...total.failures.keys()]);
  for (const wasm of wasms) {
    const analyses = new Set([
      ...(total.samples.get(wasm)?.keys() ?? []),
      ...(total.failures.get(wasm)?.keys() ?? []),
    ]);
    for (const analysis of analyses) {
      const perAnalysis = result.get(analysis) ?? new Map();
      const totals = total.samples.get(wasm)?.get(analysis);
      if (totals === undefined) {
        perAnalysis.set(
          wasm,
          total.failureKinds.get(wasm)?.get(analysis) ?? 'error',
        );
      } else {
        const means = Object.fromEntries(
          present.map((phase, i) => [
            phase,
            mean(phases[i].samples.get(wasm).get(analysis)),
          ]),
        );
        const totalMean = mean(totals);
        const attributed = present.reduce((sum, p) => sum + means[p], 0);
        perAnalysis.set(wasm, {
          runs: totals.length,
          means,
          total: totalMean,
          unattributed: Math.max(0, totalMean - attributed),
        });
      }
      result.set(analysis, perAnalysis);
    }
  }
  return result;
}

/** CSV with the mean time of every phase, and their sum, per analysis and module. */
export function formatPhaseBreakdownsCsv(breakdowns) {
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
  for (const analysis of orderAnalyses(breakdowns.keys())) {
    const perAnalysis = breakdowns.get(analysis);
    for (const wasm of [...perAnalysis.keys()].sort()) {
      const b = perAnalysis.get(wasm);
      lines.push(
        typeof b === 'string'
          ? [analysis, wasm, '0', b, ...phases.map(() => ''), '', ''].join(',')
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
  return lines.join('\n') + '\n';
}

const PHASE_PLOT_H = 190;
/** Room above a panel's plot area for the total written over each bar. */
const TOTAL_LABEL_H = 16;
const MAX_STACK_W = 20;
/** Room right of a stack for the share of every phase. */
const OUTSIDE_LABEL_W = 20;
/** Vertical distance between two shares written next to a stack. */
const OUTSIDE_LABEL_H = 9;
/** Surface gap between the segments of a stack. */
const SEGMENT_GAP = 1;

/**
 * One panel per analysis, the baseline left out, with a stacked bar per Wasm
 * module: the share of every phase in the mean total_ms, bottom to top in the
 * order the phases happen, with the mean total written above the bar. The
 * stack always fills the bar, so the phases visibly add up to the total.
 * With `opts.isolateSpawn` spawning is a bar of its own right of the stack,
 * which then fills the rest: the two together add up to the total.
 */
export function renderPhasePlot(breakdowns, opts) {
  // Only the analyses: without one there is nothing to register or deploy.
  const analyses = orderAnalyses(breakdowns.keys()).filter(
    (analysis) => analysis !== BASELINE_ANALYSIS,
  );
  const wasms = [
    ...new Set([...breakdowns.values()].flatMap((m) => [...m.keys()])),
  ].sort((a, b) => wasmDisplayName(a).localeCompare(wasmDisplayName(b)));
  if (analyses.length === 0) throw new Error('There is no data to plot');
  const phases = breakdownPhases(breakdowns);
  const isolateSpawn =
    opts.isolateSpawn === true && phases.includes('spawn_ms');
  const stacked = isolateSpawn
    ? phases.filter((p) => p !== 'spawn_ms')
    : phases;

  const width = opts.width;
  const scratch = createCanvas(1, 1).getContext('2d');
  setFont(scratch, 11);
  const longestLabel = Math.max(
    ...wasms.map((w) => scratch.measureText(wasmDisplayName(w)).width),
  );
  const xLabelH = Math.ceil(longestLabel * Math.sin(X_LABEL_ANGLE)) + 22;

  const title = plotTitle(
    opts.title,
    `Share of every phase in ${phaseTotalName(phases)} per Wasm module and analysis, wasmito`,
  );
  const columns = Math.min(COMPARISON_COLUMNS, analyses.length);
  const panelRows = Math.ceil(analyses.length / columns);
  const panelW = (width - 2 * MARGIN - (columns - 1) * COLUMN_GAP) / columns;
  const plotW = panelW - Y_AXIS_W;
  const panelH = PANEL_TITLE_H + TOTAL_LABEL_H + 8 + PHASE_PLOT_H + xLabelH;
  // The title, then the legend.
  const headerH = title === undefined ? 52 : 88;
  const height =
    headerH + panelRows * panelH + (panelRows - 1) * PANEL_GAP + MARGIN;

  const { canvas, ctx } = createPlotCanvas(opts.format, width, height);
  if (title !== undefined) {
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.ink;
    setFont(ctx, 20, 'bold');
    ctx.fillText(title, MARGIN, MARGIN + 18);
  }
  drawPhaseLegend(
    ctx,
    phases,
    MARGIN,
    headerH - 16,
    opts.timeoutMinutes,
    isolateSpawn,
  );

  const groupW = plotW / wasms.length;
  // The stack, its shares and, isolated, the spawn bar after a gap.
  const barW = isolateSpawn
    ? Math.min(MAX_STACK_W, (groupW - OUTSIDE_LABEL_W - SPAWN_BAR_GAP - 8) / 2)
    : Math.min(MAX_STACK_W, groupW - OUTSIDE_LABEL_W - 8);
  const groupBarsW =
    barW + OUTSIDE_LABEL_W + (isolateSpawn ? SPAWN_BAR_GAP + barW : 0);
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  analyses.forEach((analysis, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    const x0 = MARGIN + col * (panelW + COLUMN_GAP) + Y_AXIS_W;
    const y0 = headerH + row * (panelH + PANEL_GAP);
    const plotTop = y0 + PANEL_TITLE_H + TOTAL_LABEL_H + 8;
    const plotBottom = plotTop + PHASE_PLOT_H;
    const py = (share) => plotBottom - share * PHASE_PLOT_H;

    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.ink;
    setFont(ctx, 13, 'bold');
    ctx.fillText(analysis, x0 - Y_AXIS_W, y0 + 14);

    ctx.lineWidth = 1;
    setFont(ctx, 10);
    ctx.textAlign = 'right';
    for (const t of ticks) {
      const y = Math.round(py(t)) + 0.5;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + plotW, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(`${Math.round(t * 100)}%`, x0 - 6, y + 3);
    }
    drawYAxisTitle(
      ctx,
      `Share of ${phaseTotalName(phases)} (%)`,
      x0 - Y_AXIS_W + 8,
      plotTop,
      plotBottom,
    );

    const perAnalysis = breakdowns.get(analysis);
    wasms.forEach((wasm, i) => {
      const center = x0 + (i + 0.5) * groupW;
      // The stack, the column of shares next to it and the spawn bar,
      // centred together.
      const left = center - groupBarsW / 2;
      const barCenter = left + barW / 2;
      const b = perAnalysis.get(wasm);
      if (b === undefined || typeof b === 'string') {
        ctx.fillStyle = COLORS.inkSecondary;
        setFont(ctx, 10, 'bold');
        ctx.textAlign = 'center';
        const marker =
          b === undefined ? MISSING_MARKERS.missing : MISSING_MARKERS[b];
        ctx.fillText(
          marker.symbol,
          isolateSpawn ? center : barCenter,
          plotBottom - MARKER_LIFT,
        );
      } else {
        const segments = stacked
          .map((p) => ({
            value: phaseTime(b, p, phases),
            color: PHASE_COLORS[p],
          }))
          .filter((s) => s.value > 0);
        const top = segments.length - 1;
        const spawnShare = isolateSpawn
          ? phaseTime(b, 'spawn_ms', phases) / b.total
          : 0;
        // The share of every phase, written next to the stack.
        const outside = [];
        let share = 0;
        segments.forEach((s, k) => {
          const from = py(share);
          share += s.value / b.total;
          // The last segment closes the stack at 100%, or at what spawning
          // leaves of it, whatever the rounding.
          const to = k === top ? py(1 - spawnShare) : py(share);
          if (k === top) {
            drawBar(ctx, left, barW, from, to, s.color);
          } else if (from - to > SEGMENT_GAP) {
            ctx.fillStyle = s.color;
            ctx.fillRect(left, to + SEGMENT_GAP, barW, from - to - SEGMENT_GAP);
          }
          // Its share, in a column next to the stack.
          const percent = (s.value / b.total) * 100;
          outside.push({
            y: (from + to) / 2,
            label: percent < 0.5 ? '<1%' : `${Math.round(percent)}%`,
          });
        });
        drawOutsideShares(ctx, outside, left + barW, py(1), plotBottom);
        if (isolateSpawn) {
          drawSpawnBar(
            ctx,
            left + barW + OUTSIDE_LABEL_W + SPAWN_BAR_GAP,
            barW,
            spawnShare,
            py,
          );
        }
        // The total the stack (and the spawn bar) add up to.
        ctx.fillStyle = COLORS.inkSecondary;
        setFont(ctx, 10);
        ctx.textAlign = 'center';
        ctx.fillText(
          barSeconds(b.total),
          isolateSpawn ? center : barCenter,
          py(1) - 5,
        );
      }

      ctx.save();
      ctx.translate(center, plotBottom + 12);
      ctx.rotate(-X_LABEL_ANGLE);
      ctx.fillStyle = COLORS.inkSecondary;
      setFont(ctx, 11);
      ctx.textAlign = 'right';
      ctx.fillText(wasmDisplayName(wasm), 0, 4);
      ctx.restore();
    });

    ctx.strokeStyle = COLORS.inkSecondary;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0, plotBottom + 0.5);
    ctx.lineTo(x0 + plotW, plotBottom + 0.5);
    ctx.stroke();
  });

  return encodePlot(canvas, opts.format);
}

/** Room between the shares next to a stack and the spawn bar after them. */
const SPAWN_BAR_GAP = 3;

/**
 * The bar of spawning at `x`, from 0 to its `share` of the total, with the
 * share written up from its top, or down from inside it when there is no
 * room above.
 */
function drawSpawnBar(ctx, x, w, share, py) {
  drawBar(ctx, x, w, py(0), py(share), PHASE_COLORS.spawn_ms);
  const percent = share * 100;
  const label = percent < 0.5 ? '<1%' : `${Math.round(percent)}%`;
  setFont(ctx, VALUE_FONT_PX, 'bold');
  const length = ctx.measureText(label).width;
  const inside = py(share) - 3 - length < py(1);
  ctx.save();
  // The glyphs sit above their baseline, which is left of it once rotated.
  ctx.translate(
    x + w / 2 + VALUE_FONT_PX * 0.35,
    inside ? py(share) + 3 : py(share) - 3,
  );
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = inside ? COLORS.surface : COLORS.inkSecondary;
  ctx.textAlign = inside ? 'right' : 'left';
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

/** What the phases add up to: `total_ms`, less `spawn_ms` without it. */
export function phaseTotalName(phases) {
  return phases.includes('spawn_ms') ? 'total_ms' : 'total_ms − spawn_ms';
}

/**
 * The phases by colour in stack order, then the letters of failed runs.
 */
function drawPhaseLegend(
  ctx,
  phases,
  x,
  y,
  timeoutMinutes,
  isolateSpawn = false,
) {
  setFont(ctx, 12);
  ctx.textAlign = 'left';
  let cx = x;
  const item = (text, sampleW, lineY) => {
    ctx.fillStyle = COLORS.inkSecondary;
    ctx.fillText(text, cx + sampleW + 8, lineY);
    cx += sampleW + 8 + ctx.measureText(text).width + 26;
  };

  for (const phase of phases) {
    drawBar(ctx, cx, 10, y + 2, y - 11, PHASE_COLORS[phase]);
    item(
      isolateSpawn && phase === 'spawn_ms'
        ? `${PHASE_LABELS[phase]} (bar of its own, right of the stack)`
        : PHASE_LABELS[phase],
      10,
      y,
    );
  }

  for (const [kind, marker] of Object.entries(MISSING_MARKERS)) {
    ctx.fillStyle = COLORS.inkSecondary;
    setFont(ctx, 11, 'bold');
    ctx.textAlign = 'center';
    ctx.fillText(marker.symbol, cx + 5, y);
    ctx.textAlign = 'left';
    setFont(ctx, 12);
    item(
      kind === 'timeout' && timeoutMinutes !== undefined
        ? `${marker.label} (${timeoutMinutes} min)`
        : marker.label,
      10,
      y,
    );
  }
}

/**
 * Writes `shares` in a column right of a stack whose right edge is at `x`,
 * each as close to the middle `y` of its segment as the others allow, with a
 * leader line to the segment.
 */
function drawOutsideShares(ctx, shares, x, top, bottom) {
  if (shares.length === 0) return;
  const sorted = [...shares].sort((a, b) => a.y - b.y);
  // Push overlapping labels down, then back up if they run past the bottom.
  const ys = sorted.map((s) => s.y);
  for (let i = 0; i < ys.length; i++) {
    ys[i] = Math.max(
      ys[i],
      top + 4,
      i > 0 ? ys[i - 1] + OUTSIDE_LABEL_H : -Infinity,
    );
  }
  for (let i = ys.length - 1; i >= 0; i--) {
    ys[i] = Math.min(
      ys[i],
      bottom - 4,
      i < ys.length - 1 ? ys[i + 1] - OUTSIDE_LABEL_H : Infinity,
    );
  }

  setFont(ctx, 8.5, 'bold');
  ctx.textAlign = 'left';
  sorted.forEach((share, i) => {
    ctx.strokeStyle = COLORS.muted;
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(x, share.y);
    ctx.lineTo(x + 3, ys[i]);
    ctx.stroke();
    ctx.fillStyle = COLORS.inkSecondary;
    ctx.fillText(share.label, x + 4, ys[i] + 3);
  });
}

/** Renders the phase breakdown of wasmito and writes it to `outputPath`. */
export function writePhasePlot(breakdowns, opts, outputPath) {
  fs.writeFileSync(outputPath, renderPhasePlot(breakdowns, opts));
}

function failedRunsNote(count) {
  return count === 1
    ? '1 failed run is not plotted.'
    : `${count} failed runs are not plotted.`;
}

/** Width needed left of the plots for the longest row label. */
function labelGutter(ctx, panels) {
  const widths = panels.flatMap((p) =>
    p.rows.map(
      (row) => ctx.measureText(row.label).width + (p.swatches ? SWATCH_W : 0),
    ),
  );
  return Math.max(0, ...widths) + LABEL_GUTTER_PAD;
}

function wrapNotes(ctx, notes, width) {
  return notes.length > 0
    ? wrapText(ctx, notes.join(' '), width - 2 * MARGIN)
    : [];
}

function drawRowLabels(ctx, panel, rowH, x, panelY) {
  const offsets = rowOffsets(panel.rows, rowH);
  setFont(ctx, 12);
  ctx.textAlign = 'left';
  panel.rows.forEach((row, i) => {
    const cy = panelY + PANEL_TITLE_H + offsets[i] + rowH / 2;
    if (panel.swatches) {
      // Identity comes from the dot; the text stays in a text colour.
      ctx.fillStyle = row.color;
      ctx.beginPath();
      ctx.arc(x + 4, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = COLORS.inkSecondary;
    ctx.fillText(row.label, x + (panel.swatches ? SWATCH_W : 0), cy + 4);
  });
}

function drawPanel(ctx, panel, layout) {
  const { rowH, x0, y0, plotW, kind, logScale, axisTitle, formatValue } =
    layout;
  const { rows } = panel;
  const offsets = rowOffsets(rows, rowH);

  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.ink;
  setFont(ctx, 13, 'bold');
  ctx.fillText(panel.title, x0, y0 + 14);
  const nameW = ctx.measureText(panel.title).width;
  ctx.fillStyle = COLORS.muted;
  setFont(ctx, 11);
  ctx.fillText(panel.detail, x0 + nameW + 8, y0 + 14);

  const axis = layout.axis ?? axisFor([...panel.stats.values()], logScale);
  const px = (v) => x0 + axis.position(v) * plotW;

  const plotTop = y0 + PANEL_TITLE_H;
  const plotBottom = plotTop + plotAreaHeight(rows, rowH);

  // Recessive grid, axis line, tick labels, and the axis title with the unit.
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.muted;
  setFont(ctx, 10);
  ctx.textAlign = 'center';
  for (const t of axis.ticks) {
    const x = Math.round(px(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
    ctx.fillText(formatValue(t), x, plotBottom + 15);
  }
  ctx.strokeStyle = COLORS.axis;
  ctx.beginPath();
  ctx.moveTo(x0, plotBottom + 0.5);
  ctx.lineTo(x0 + plotW, plotBottom + 0.5);
  ctx.stroke();
  ctx.fillStyle = COLORS.inkSecondary;
  setFont(ctx, 11);
  ctx.fillText(axisTitle, x0 + plotW / 2, plotBottom + 34);

  // A hairline in the middle of the gap that sets a group of rows apart.
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  rows.forEach((row, i) => {
    if (i === 0 || row.gapBefore === 0) return;
    const y = Math.round(plotTop + offsets[i] - row.gapBefore / 2) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + plotW, y);
    ctx.stroke();
  });

  if (layout.referenceValue !== undefined) {
    const x = Math.round(px(layout.referenceValue)) + 0.5;
    ctx.strokeStyle = COLORS.inkSecondary;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
  }

  // Only the slowest row gets a value label; the axis carries the rest.
  const peak = rows.reduce(
    (best, row) =>
      panel.stats.has(row.key) &&
      (best === undefined ||
        panel.stats.get(row.key).mean > panel.stats.get(best).mean)
        ? row.key
        : best,
    undefined,
  );

  rows.forEach((row, i) => {
    const s = panel.stats.get(row.key);
    const cy = plotTop + offsets[i] + rowH / 2;
    if (s === undefined) {
      if (panel.failed.has(row.key)) {
        ctx.fillStyle = COLORS.muted;
        setFont(ctx, 11, 'italic');
        ctx.textAlign = 'left';
        // Keep clear of the reference line, which is near the left edge.
        const failedX =
          layout.referenceValue === undefined
            ? x0 + 8
            : Math.max(x0 + 8, px(layout.referenceValue) + 8);
        ctx.fillText('× failed', failedX, cy + 4);
      }
      return;
    }

    if (kind === 'violin') {
      drawViolinRow(
        ctx,
        panel.values.get(row.key),
        s,
        px,
        cy,
        rowH,
        logScale,
        row.color,
      );
    } else {
      drawRangeRow(ctx, s, px, cy, row.color);
    }

    if (row.key === peak) {
      const label = `mean ${formatValue(s.mean)}`;
      setFont(ctx, 11, 'bold');
      ctx.fillStyle = COLORS.ink;
      const w = ctx.measureText(label).width;
      const right = px(s.max) + 8;
      if (right + w <= x0 + plotW + LABEL_PAD) {
        ctx.textAlign = 'left';
        ctx.fillText(label, right, cy + 4);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText(label, px(s.min) - 8, cy + 4);
      }
    }
  });
}

/** min - max whisker, mean +/- 1 stdev band, median tick and mean dot. */
function drawRangeRow(ctx, s, px, cy, color) {
  ctx.strokeStyle = COLORS.muted;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (s.count > 1) {
    ctx.moveTo(px(s.min), cy);
    ctx.lineTo(px(s.max), cy);
    ctx.moveTo(px(s.min), cy - 4);
    ctx.lineTo(px(s.min), cy + 4);
    ctx.moveTo(px(s.max), cy - 4);
    ctx.lineTo(px(s.max), cy + 4);
  }
  ctx.stroke();

  if (s.stdev > 0) {
    const left = px(s.mean - s.stdev);
    const right = px(s.mean + s.stdev);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;
    roundedRect(ctx, left, cy - 5, Math.max(right - left, 1), 10, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  if (s.count > 1) drawMedianTick(ctx, px(s.median), cy, 7);
  drawDot(ctx, px(s.mean), cy, color);
}

/**
 * The density of the runs as a mirrored shape between their min and max, with
 * a thin mean +/- 1 stdev bar, the median tick and the mean dot inside. Rows
 * without a density (a single run, or equal runs) show the mean only.
 */
function drawViolinRow(ctx, values, s, px, cy, rowH, logScale, color) {
  // On a log axis the shape is estimated in log space so it is not distorted.
  const canDrawLog = values.every((v) => v > 0);
  const density =
    logScale && !canDrawLog
      ? undefined
      : kernelDensity(logScale ? values.map(Math.log10) : values);

  if (density === undefined) {
    drawDot(ctx, px(s.mean), cy, color);
    return;
  }

  const halfHeight = rowH / 2 - 3;
  const xs = density.xs.map((x) => px(logScale ? 10 ** x : x));
  ctx.beginPath();
  xs.forEach((x, i) => {
    const y = cy - density.ys[i] * halfHeight;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  for (let i = xs.length - 1; i >= 0; i--) {
    ctx.lineTo(xs[i], cy + density.ys[i] * halfHeight);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.25;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  if (s.stdev > 0) {
    const left = px(s.mean - s.stdev);
    const right = px(s.mean + s.stdev);
    ctx.fillStyle = COLORS.inkSecondary;
    ctx.globalAlpha = 0.6;
    roundedRect(ctx, left, cy - 2, Math.max(right - left, 1), 4, 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  drawMedianTick(ctx, px(s.median), cy, 6);
  drawDot(ctx, px(s.mean), cy, color);
}

function drawMedianTick(ctx, x, cy, halfHeight) {
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, cy - halfHeight);
  ctx.lineTo(x, cy + halfHeight);
  ctx.stroke();
}

function drawDot(ctx, x, y, color) {
  ctx.fillStyle = COLORS.surface;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawLegend(ctx, x, y, kind, showSpread, { accent, tools }) {
  setFont(ctx, 12);
  ctx.textAlign = 'left';

  // The tools by colour, on a line above the shapes.
  if (tools !== undefined) {
    let tx = x;
    for (const tool of tools) {
      const ty = y - TOOLS_LEGEND_H;
      drawDot(ctx, tx + 5, ty - 4, tool.color);
      ctx.fillStyle = COLORS.inkSecondary;
      ctx.fillText(tool.label, tx + 18, ty);
      tx += 18 + ctx.measureText(tool.label).width + 26;
    }
  }

  const cy = y - 4;
  const sample = 26;
  const gap = 8;
  const itemGap = 26;
  let cx = x;

  const label = (text) => {
    ctx.fillStyle = COLORS.inkSecondary;
    ctx.fillText(text, cx + sample + gap, y);
    cx += sample + gap + ctx.measureText(text).width + itemGap;
  };

  if (showSpread && kind === 'violin') {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.quadraticCurveTo(cx + sample / 2, cy - 10, cx + sample, cy);
    ctx.quadraticCurveTo(cx + sample / 2, cy + 10, cx, cy);
    ctx.closePath();
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.25;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    label('distribution of the runs (min to max)');

    ctx.fillStyle = COLORS.inkSecondary;
    ctx.globalAlpha = 0.6;
    roundedRect(ctx, cx, cy - 2, sample, 4, 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    label('mean ± 1 standard deviation');
  } else if (showSpread) {
    ctx.strokeStyle = COLORS.muted;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + sample, cy);
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx, cy + 4);
    ctx.moveTo(cx + sample, cy - 4);
    ctx.lineTo(cx + sample, cy + 4);
    ctx.stroke();
    label('min to max');

    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.3;
    roundedRect(ctx, cx, cy - 5, sample, 10, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    label('mean ± 1 standard deviation');
  }

  if (showSpread) {
    drawMedianTick(ctx, cx + sample / 2, cy, 7);
    label('median');
  }

  drawDot(ctx, cx + sample / 2, cy, accent);
  label('mean');
}

/** Renders the plot and writes it to `outputPath`. */
export function writeBenchmarkPlot(parsed, opts, outputPath) {
  fs.writeFileSync(outputPath, renderBenchmarkPlot(parsed, opts));
}

/** Renders the slowdown plot and writes it to `outputPath`. */
export function writeSlowdownPlot(
  groups,
  opts,
  outputPath,
  pairs = DEFAULT_ANALYSIS_PAIRS,
) {
  fs.writeFileSync(outputPath, renderSlowdownPlot(groups, opts, pairs));
}
