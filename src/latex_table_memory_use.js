#!/usr/bin/env node
/**
 * Writes the LaTeX table of the dynamic memory use of every framework and
 * analysis (tab:memory_use), from the maximum resident set size (KiB) that
 * /usr/bin/time reported for the VM running each Wasm-R3 module (see
 * memory_use_util.js for the CSVs and how they are read):
 *
 *   Whamm (wei)      Wizard with the wei monitor of the analysis
 *   Wastrumentation  Wizard running the module instrumented by Wastrumentation
 *   Wasmito          the WARDuino VM spawned by `wasmito analysis --vm-memory`
 *
 * For every analysis and module, the memory increase is
 *   max_rss(analysis, module) - max_rss(no-analysis, module)
 * and every cell is the median (min--max) of the increases over the modules,
 * in MB (MiB), written once per cell: median (min--max) MB. With --absolute, the
 * cells are the max_rss of the analysis runs themselves instead, and the table
 * gets a "no analysis" row with the baselines.
 *
 * Only runs with status ok count, and only modules whose baseline is ok too
 * (--any-status counts every run with a measurement). The analyses count on
 * the Wasm-R3 modules, except Wasmito's concurrency bug analyses (order,
 * variable-atomicity and multi-word violation), which count on the MCU
 * modules of the concurrency bug evaluation (which only Wasmito runs).
 * The concurrency bug analyses are shown for the frameworks of
 * --include-concurrency (comma-separated wei, wastrumentation, wasmito, all or
 * none; default wasmito); the rows of the others are skipped. What is left out
 * is reported on stderr.
 *
 * <wasmito-csv...> is one or more CSVs (or directories of CSVs) of
 * `wasmito analysis --vm-memory`, e.g. the runs on the Wasm-R3 modules and
 * those on the MCU modules.
 *
 * Usage:
 *   node src/latex_table_memory_use.js [--output <table.tex>] [--absolute]
 *     [--any-status] [--include-concurrency <frameworks>] [--csv <file>]
 *     <wei-csv> <wastrumentation-csv> <wasmito-csv>...
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { analysisRows, CONCURRENCY_ANALYSES, labelOf, nameIn, parseFrameworkKeys, BASELINE, FRAMEWORKS, HLINE, lookup, median, readMemoryUse, warnUnknown } from './memory_use_util.js';

const HEADERS = { 'Whamm (wei)': 'Whamm (wei)', Wastrumentation: 'Wastrumentation', Wasmito: '\\wasmito' };

/** KiB as MB (MiB): two decimals below 1 MB (e.g. 0.02 for 16 KiB), one otherwise. */
function fmt(kib) {
  const mb = kib / 1024;
  return mb.toFixed(Math.abs(mb) < 1 ? 2 : 1);
}

/** median (min--max) MB over the modules. */
function cell(values) {
  if (values === undefined) return '--';
  const vals = [...values.values()];
  if (vals.length === 0) return 'n/a';
  return `${fmt(median(vals))} (${fmt(Math.min(...vals))}--${fmt(Math.max(...vals))})~MB`;
}

/** The rows of the table (analyses), including the concurrency ones, to label the CSV. */
function rowsOf(opts) {
  return [...analysisRows(opts), ...CONCURRENCY_ANALYSES].filter((r) => r !== HLINE);
}

/**
 * Writes the values behind the table and plot: per framework, analysis and
 * module, the max RSS without and with the analysis and their difference
 * (KiB), only for the analyses that are shown.
 */
function writeValues(csv, collect, rows) {
  const frameworkOf = { wei: 'Whamm (wei)', wastrumentation: 'Wastrumentation', wasmito: 'Wasmito' };
  const lines = ['framework,analysis,analysis_in_csv,module,baseline_kib,measured_kib,increase_kib'];
  for (const c of collect) {
    const fw = frameworkOf[c.framework];
    const row = rows.find((r) => nameIn(r, fw) === c.analysis);
    if (!row) continue;
    lines.push([fw, labelOf(row), c.analysis, c.module, c.baseline, c.measured, c.measured - c.baseline].join(','));
  }
  mkdirSync(dirname(csv), { recursive: true });
  writeFileSync(csv, `${lines.join('\n')}\n`);
  console.error(`Wrote ${lines.length - 1} values to ${csv}`);
}

function main(weiCsv, wastrCsv, wasmitoCsvs, opts) {
  const collect = [];
  const data = readMemoryUse(weiCsv, wastrCsv, wasmitoCsvs, { ...opts, collect });
  if (opts.csv) writeValues(opts.csv, collect, rowsOf(opts));
  const rows = opts.absolute ? [[BASELINE, BASELINE, BASELINE, 'no analysis'], HLINE, ...analysisRows(opts)] : analysisRows(opts);
  warnUnknown(data, rows);

  const lines = [
    '\\begin{table}',
    '\\centering',
    '\\small',
    '\\begin{tabular}{l|ccc}',
    '\\hline',
    '\\multirow{2}{*}{\\textbf{Analysis}}',
    `  & \\multicolumn{3}{c}{\\textbf{${opts.absolute ? 'Maximum resident set size' : 'Memory increase'}}} \\\\`,
    `  & ${FRAMEWORKS.map((f) => HEADERS[f]).join(' & ')} \\\\`,
    '\\hline',
  ];
  for (const row of rows) {
    if (row === HLINE) { lines.push('\\hline'); continue; }
    const label = labelOf(row);
    const cells = FRAMEWORKS.map((f) => cell(lookup(data, f, row)));
    if (cells.every((c) => c === '--')) continue;
    lines.push(`${label.replace(/_/g, '\\_').padEnd(28)} & ${cells.join(' & ')} \\\\`);
  }
  lines.push(
    '\\hline',
    '\\end{tabular}',
    '\\caption{',
    opts.absolute
      ? 'Maximum resident set size of the VM (Wizard for Whamm (wei) and Wastrumentation, WARDuino for \\wasmito) running the Wasm-R3 modules, per analysis, as median (min--max) over the modules.'
      : 'Increase of the maximum resident set size of the VM (Wizard for Whamm (wei) and Wastrumentation, WARDuino for \\wasmito) when running the Wasm-R3 modules with each analysis, compared to running them without analysis, as median (min--max) over the modules.',
    ...(analysisRows(opts).includes(HLINE)
      ? ['For \\wasmito, the concurrency bug analyses (below the line) run on the MCU modules of \\Cref{sec:concurrency-analyses} instead.']
      : []),
    '`--\' denotes that the analysis is not available in the framework.}',
    '\\label{tab:memory_use}',
    '\\end{table}',
  );
  const tex = `${lines.join('\n')}\n`;
  if (opts.output) writeFileSync(opts.output, tex);
  else process.stdout.write(tex);
}

new Command()
  .argument('<wei-csv>', 'CSV of scripts/measure_memory_use_wei.sh (wizard_memory_use.csv)')
  .argument('<wastrumentation-csv>', 'CSV of scripts/measure_memory_use_wastrumentation.sh')
  .argument('<wasmito-csv...>', 'CSVs (or directories of CSVs) of wasmito analysis --vm-memory')
  .option('--output <tex>', 'write the table there instead of to stdout')
  .option('--csv <file>', 'also write the values of the table (and plot) per framework, analysis and module to this CSV')
  .option('--absolute', 'report the max RSS itself instead of the increase over no-analysis')
  .option('--any-status', 'also count runs whose status is not ok')
  .option('--include-concurrency <frameworks>',
    'show the concurrency bug analyses of these frameworks: comma-separated wei, wastrumentation, wasmito, all or none',
    parseFrameworkKeys, parseFrameworkKeys('wasmito'))
  .action(main)
  .parse();
