// memory_use_util.js
//
// Reads the memory use CSVs of the three frameworks for
// latex_table_memory_use.js and plot_memory_use.js:
//
//   Whamm (wei)      scripts/measure_memory_use_wei.sh
//                    (bench_output/memory_use/wizard_memory_use.csv)
//   Wastrumentation  scripts/measure_memory_use_wastrumentation.sh
//                    (bench_output/memory_use/wizard_memory_use_wastrumentation.csv)
//   Wasmito          `wasmito analysis ... --vm-memory <csv>`, one or more
//                    CSVs (columns analysis, wasm, status, max_rss_kbytes),
//                    e.g. the runs on the Wasm-R3 modules and those on the MCU
//                    modules
//
// In every CSV, max_rss_kbytes is the maximum resident set size (KiB) of the
// VM (Wizard or WARDuino), and the rows with analysis "no-analysis" are the
// baseline: the VM running the original module. For every analysis and
// module, the value is
//   max_rss(analysis, module) - max_rss(no-analysis, module)
// (with several runs, the median per module first), or with `absolute` the
// max_rss itself (and the baseline is kept as analysis "no-analysis").
//
// Which modules count:
//   - the concurrency bug analyses (order, variable-atomicity and multi-word
//     violation) only count for the frameworks of includeConcurrency (by
//     default only Wasmito); for Wasmito only on the MCU modules of the
//     concurrency bug evaluation (bench_input_data/mcu_modules/), which only
//     Wasmito runs;
//   - otherwise, only the Wasm-R3 modules count: the MCU modules are ignored
//     (always for Whamm (wei) and Wastrumentation).
// Only runs with status ok count, and only modules whose baseline is ok too,
// unless `anyStatus`. What is left out is reported on stderr.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE = 'no-analysis';
export const HLINE = 'hline';

const MCU_DIR = join(dirname(fileURLToPath(import.meta.url)), '../bench_input_data/mcu_modules');

/**
 * The MCU modules of the concurrency bug evaluation, by the name of their
 * .wasm file (e.g. order_violation for toggle_led_bug/wasm/order_violation.wasm).
 */
export const MCU_MODULES = new Set(
  readdirSync(MCU_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(MCU_DIR, e.name, 'wasm')))
    .flatMap((e) => readdirSync(join(MCU_DIR, e.name, 'wasm')).filter((f) => f.endsWith('.wasm')))
    .map((f) => basename(f, '.wasm')),
);

// The analyses, one entry per analysis, in the order of the paper's tables:
//   [<name in Wasmito>, <name in Whamm (wei)>, <name in Wastrumentation>,
//    <name in the plot and table>]
// The names in the frameworks are those of the analysis column of their CSVs
// ('' if the framework does not have the analysis); as in plot_runtimes.js,
// e.g. Wasmito's and Whamm's imix is the instruction-mix.
export const ANALYSES = [
  ['imix', 'imix', 'imix', 'instruction-mix'],
  ['basic-block', 'basic_blocks', 'basic_blocks', 'basic-block'],
  ['instr-coverage', 'instr_coverage', 'instr_coverage', 'instr-coverage'],
  ['branches', 'branches', 'branches', 'branches'],
  ['call-graph', 'call_graph', 'call_graph', 'call-graph'],
  ['taint', '', 'taint', 'taint'],
  ['mem_access', 'mem_access', 'mem_access', 'mem_access'],
  ['cryptomining', '', 'crypto', 'cryptomining'],
  ['forward', '', 'forward', 'forward'],
  ['denan', '', 'denan', 'denan'],
  ['safe-heap', '', 'safe_heap', 'safe-heap'],
  ['icount', 'icount', '', 'icount'],
  ['hotness', 'hotness', '', 'hotness'],
  ['cache_sim', 'cache_sim', '', 'cache_sim'],
  ['loop_tracer', 'loop_tracer', '', 'loop_tracer'],
];

/** The concurrency bug analyses (same columns), which only count on the MCU modules for Wasmito. */
export const CONCURRENCY_ANALYSES = [
  ['order-violation', 'order_violation', 'order_violation', 'order violation'],
  ['variable-violation', 'variable_violation', 'variable_violation', 'variable-atomicity violation'],
  ['data-race-violation', 'data_race_violation', 'data_race_violation', 'multi-word violation'],
];

/** The column of a framework of FRAMEWORKS in the entries of ANALYSES. */
const COLUMN = { Wasmito: 0, 'Whamm (wei)': 1, Wastrumentation: 2 };
/** The name of the analysis of `row` in `framework` ('' if it does not have it). */
export const nameIn = (row, framework) => row[COLUMN[framework]];
/** The name of the analysis of `row` in the plot and table: the last column. */
export const labelOf = (row) => row[row.length - 1];

const CONCURRENCY_NAMES = new Set(CONCURRENCY_ANALYSES.flatMap((row) => row.slice(0, -1)).filter(Boolean));
export const isConcurrency = (analysis) => CONCURRENCY_NAMES.has(analysis);

/** The framework keys of --include-concurrency. */
export const FRAMEWORK_KEYS = ['wei', 'wastrumentation', 'wasmito'];
export const DEFAULT_CONCURRENCY = 'wasmito';

/**
 * Parses the value of --include-concurrency: a comma- or space-separated list
 * of FRAMEWORK_KEYS, "all" (or true) for all of them, or "none".
 */
export function parseFrameworkKeys(value) {
  if (value === true || value === 'all') return new Set(FRAMEWORK_KEYS);
  if (value === 'none') return new Set();
  const keys = String(value).split(/[\s,]+/).filter(Boolean);
  for (const k of keys) {
    if (!FRAMEWORK_KEYS.includes(k)) throw new Error(`unknown framework '${k}' (expected ${FRAMEWORK_KEYS.join(', ')}, all or none)`);
  }
  return new Set(keys);
}

/** The frameworks (keys) whose concurrency bug analyses count. */
function concurrencyFrameworks(opts) {
  const v = opts.includeConcurrency ?? DEFAULT_CONCURRENCY;
  if (!v) return new Set();
  return v instanceof Set ? v : parseFrameworkKeys(v);
}

/** The analyses to show, in order, with HLINE between the groups. */
export function analysisRows(opts = {}) {
  return concurrencyFrameworks(opts).size > 0 ? [...ANALYSES, HLINE, ...CONCURRENCY_ANALYSES] : ANALYSES;
}

export const FRAMEWORKS = ['Whamm (wei)', 'Wastrumentation', 'Wasmito'];

function readCsv(file) {
  if (!existsSync(file)) throw new Error(`'${file}' does not exist`);
  const [header, ...lines] = readFileSync(file, 'utf8').trim().split('\n');
  const cols = header.split(',');
  return lines.filter(Boolean).map((l) => {
    const v = l.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']));
  });
}

/** The CSVs of `paths`: files, or directories whose .csv files are all read. */
function csvFiles(paths) {
  return [paths].flat().flatMap((p) => {
    if (!existsSync(p)) throw new Error(`'${p}' does not exist`);
    return statSync(p).isDirectory()
      ? readdirSync(p).filter((f) => f.endsWith('.csv')).sort().map((f) => join(p, f))
      : [p];
  });
}

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const kibOf = (v) => (v === '' || v === undefined ? NaN : Number(v));

/**
 * Whether module `m` counts for analysis `a`: for Wasmito (mcu), the
 * concurrency analyses on the MCU modules and the others on the rest; for
 * Wizard, every analysis on the rest.
 */
const inScope = (a, m, mcu) => (mcu && isConcurrency(a) ? MCU_MODULES.has(m) : !MCU_MODULES.has(m));

/** Per analysis, per module, the value (KiB) of one framework. */
function valuesPerAnalysis(name, rows, opts, includeConcurrency, mcu) {
  const warn = opts.quiet ? () => {} : (m) => console.error(m);
  rows = rows.filter((r) => r.analysis === BASELINE || includeConcurrency || !isConcurrency(r.analysis));
  // The median of the runs that count, per analysis and module.
  const runs = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.kib) || (!opts.anyStatus && r.status !== 'ok')) continue;
    if (!runs.has(r.analysis)) runs.set(r.analysis, new Map());
    const m = runs.get(r.analysis);
    if (!m.has(r.module)) m.set(r.module, []);
    m.get(r.module).push(r.kib);
  }
  const base = new Map([...(runs.get(BASELINE) ?? new Map())].map(([m, xs]) => [m, median(xs)]));
  const all = [...new Set(rows.map((r) => r.module))];

  const out = new Map();
  for (const a of new Set(rows.map((r) => r.analysis))) {
    if (a === BASELINE && !opts.absolute) continue;
    // The baseline is shown (with --absolute) on the Wasm-R3 modules.
    const scope = all.filter((m) => inScope(a, m, mcu));
    const mods = runs.get(a) ?? new Map();
    const values = new Map();
    const noBase = [];
    const left = [];
    for (const m of scope) {
      if (!base.has(m)) { noBase.push(m); continue; }
      if (!mods.has(m)) { left.push(m); continue; }
      const v = median(mods.get(m));
      values.set(m, opts.absolute ? v : v - base.get(m));
      opts.collect?.push({ framework: name, analysis: a, module: m, baseline: base.get(m), measured: v, value: opts.absolute ? v : v - base.get(m) });
    }
    if (noBase.length && a !== BASELINE) warn(`${name} ${a}: no baseline for ${noBase.join(' ')} (left out)`);
    if (left.length) warn(`${name} ${a}: no measurement for ${left.join(' ')} (left out)`);
    out.set(a, values);
  }
  return out;
}

/**
 * Reads the CSVs (wasmitoCsvs: one or more files or directories of CSVs).
 * Returns, per framework of FRAMEWORKS, a map from the analysis (its name in
 * the CSV) to a map from module to value (KiB).
 * opts: { absolute, anyStatus, includeConcurrency, quiet, collect }; collect, an
 * array, receives one { framework, analysis, module, baseline, measured, value }
 * (KiB) per value used; includeConcurrency
 * is a Set or list of FRAMEWORK_KEYS, "all" or "none" (default "wasmito");
 * quiet does not report what is left out.
 */
export function readMemoryUse(weiCsv, wastrCsv, wasmitoCsvs, opts = {}) {
  const concurrency = concurrencyFrameworks(opts);
  const wizard = (file, mode) => readCsv(file)
    .filter((r) => r.mode === mode || r.analysis === BASELINE)
    .map((r) => ({ analysis: r.analysis, module: r.module, status: r.status, kib: kibOf(r.max_rss_kbytes) }));
  const wasmito = csvFiles(wasmitoCsvs).flatMap(readCsv)
    .map((r) => ({ analysis: r.analysis, module: r.wasm.replace(/\.wasm$/, ''), status: r.status, kib: kibOf(r.max_rss_kbytes) }));
  return new Map([
    ['Whamm (wei)', valuesPerAnalysis('wei', wizard(weiCsv, 'wei'), opts, concurrency.has('wei'), false)],
    ['Wastrumentation', valuesPerAnalysis('wastrumentation', wizard(wastrCsv, 'wastrumentation'), opts, concurrency.has('wastrumentation'), false)],
    ['Wasmito', valuesPerAnalysis('wasmito', wasmito, opts, concurrency.has('wasmito'), true)],
  ]);
}

/**
 * The values of `framework` for the analysis of `row` (an entry of
 * ANALYSES), or undefined if the framework does not have it or has no rows for it.
 */
export function lookup(data, framework, row) {
  const name = nameIn(row, framework);
  return name ? data.get(framework).get(name) : undefined;
}

/** Warns about analyses of the CSVs that are not in `rows`. */
export function warnUnknown(data, rows) {
  const shown = rows.filter((r) => r !== HLINE);
  for (const [fw, per] of data) {
    const known = new Set(shown.map((r) => nameIn(r, fw)));
    for (const a of per.keys()) {
      if (a !== BASELINE && !known.has(a)) console.error(`${fw}: analysis '${a}' is not shown`);
    }
  }
}
