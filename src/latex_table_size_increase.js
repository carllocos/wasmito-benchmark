#!/usr/bin/env node
/**
 * Writes the LaTeX table of the size increase of the Wasm-R3 modules per
 * framework and analysis (tab:size_overhead): how many times bigger
 * everything that must be deployed is than the original module.
 *
 *   Whamm (wei)      (original + wei monitor + whamm_core.wasm + user library)
 *                    / original. The monitors are those of
 *                    scripts/build_wei_modules_whamm.sh
 *                    (bench_output/modules_overhead/whamm-wei/<analysis>/<module>.wasm);
 *                    whamm_core.wasm and the user library (cache_sim's
 *                    cache.wasm, loop_tracer's tracer.wasm, which loop_tracer
 *                    imports instead of whamm_core.wasm) are those that
 *                    src/measure_memory_use.js used for the module, from the
 *                    whamm_core_stack and user_library columns of its CSV
 *                    (bench_output/memory_use/wizard_memory_use.csv); without
 *                    a row there, the default whamm_core.wasm.
 *   Wastrumentation  instrumented module / original, the modules of
 *                    src/build_min_pages_wastrumentation_wasmr3.js
 *                    (bench_output/modules_overhead/wastrumentation_min_pages/<analysis>/<module>.wasm).
 *   Wasmito          1.0: Wasmito does not change the module.
 *
 * Every cell is the min--max over the Wasm-R3 modules (with --median, the
 * median (min--max)). The MCU modules and the concurrency bug analyses are
 * left out. Missing files are reported on stderr.
 *
 * Usage:
 *   node src/latex_table_size_increase.js [--output <table.tex>] [--median]
 *     [--modules <dir>] [--wei <dir>] [--wastrumentation <dir>] [--memory-use <csv>]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { ANALYSES, labelOf, median, nameIn } from './memory_use_util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIR = join(ROOT, 'bench_output/whamm_core_stack/mcu');
const LIB_DIR = join(ROOT, 'bench_output/whamm_user_libs');

const size = (f) => statSync(f).size;

/** Per analysis and module (wei names), the core stack and user library of the memory runs. */
function readCores(csv) {
  const cores = new Map();
  if (!existsSync(csv)) {
    console.error(`warning: '${csv}' does not exist: using the default whamm_core.wasm`);
    return cores;
  }
  const [header, ...lines] = readFileSync(csv, 'utf8').trim().split('\n');
  const cols = header.split(',');
  for (const l of lines) {
    const r = Object.fromEntries(l.split(',').map((v, i) => [cols[i], v]));
    if (r.mode === 'wei') cores.set(`${r.analysis}/${r.module}`, { stack: r.whamm_core_stack, lib: r.user_library });
  }
  return cores;
}

function fmt(x) {
  return x.toFixed(1);
}

function cell(ratios, withMedian) {
  if (ratios === undefined) return '--';
  if (ratios.length === 0) return 'n/a';
  const lo = fmt(Math.min(...ratios));
  const hi = fmt(Math.max(...ratios));
  const range = lo === hi ? lo : `${lo}--${hi}`;
  return withMedian ? `${fmt(median(ratios))} (${range})\\xtimes` : `${range}\\xtimes`;
}

function main(opts) {
  const modules = readdirSync(opts.modules).filter((f) => f.endsWith('.wasm')).sort().map((f) => basename(f, '.wasm'));
  const cores = readCores(opts.memoryUse);

  /** Wei: (original + monitor + core + library) / original per module. */
  const wei = (analysis) => {
    const ratios = [];
    for (const m of modules) {
      const monitor = join(opts.wei, analysis, `${m}.wasm`);
      if (!existsSync(monitor)) { console.error(`wei ${analysis} ${m}: no ${monitor} (left out)`); continue; }
      const { stack, lib } = cores.get(`${analysis}/${m}`) ?? { stack: analysis === 'loop_tracer' ? '' : 'default', lib: '' };
      const core = stack ? join(CORE_DIR, `whamm_core_${stack}.wasm`) : undefined;
      const library = lib ? join(LIB_DIR, `${lib}.wasm`) : undefined;
      const missing = [core, library].filter((f) => f && !existsSync(f));
      if (missing.length) { console.error(`wei ${analysis} ${m}: no ${missing.join(' ')} (left out)`); continue; }
      const original = size(join(opts.modules, `${m}.wasm`));
      const total = original + size(monitor) + (core ? size(core) : 0) + (library ? size(library) : 0);
      ratios.push(total / original);
    }
    return ratios;
  };

  /** Wastrumentation: instrumented / original per module. */
  const wastr = (analysis) => {
    const ratios = [];
    for (const m of modules) {
      const f = join(opts.wastrumentation, analysis, `${m}.wasm`);
      if (!existsSync(f)) { console.error(`wastrumentation ${analysis} ${m}: no ${f} (left out)`); continue; }
      ratios.push(size(f) / size(join(opts.modules, `${m}.wasm`)));
    }
    return ratios;
  };

  const lines = [
    '\\begin{table}',
    '\\centering',
    '\\small',
    '\\begin{tabular}{l|c@{\\hspace{6pt}}c@{\\hspace{6pt}}c}',
    '\\hline',
    '\\multirow{2}{*}{\\textbf{Analysis}}',
    '  & \\multicolumn{3}{c}{\\textbf{Size increase}} \\\\',
    '  & Whamm (wei) & Wastrumentation & \\wasmito \\\\',
    '\\hline',
  ];
  for (const row of ANALYSES) {
    const w = nameIn(row, 'Whamm (wei)');
    const s = nameIn(row, 'Wastrumentation');
    const cells = [
      w ? cell(wei(w), opts.median) : '--',
      s ? cell(wastr(s), opts.median) : '--',
      nameIn(row, 'Wasmito') ? '1.0\\xtimes' : '--',
    ];
    lines.push(`${labelOf(row).replace(/_/g, '\\_').padEnd(28)} & ${cells.join(' & ')} \\\\`);
  }
  lines.push(
    '\\hline',
    '\\end{tabular}',
    '\\caption{',
    `Size increase of the Wasm-R3 modules per analysis and framework, ${opts.median ? 'as median (min--max)' : 'from the least to the most'} over the modules:`,
    'the size of everything that must be deployed divided by the size of the original module.',
    'For Whamm (wei), this is the original module, the wei monitor, \\texttt{whamm\\_core.wasm}, and the user library of \\emph{cache\\_sim} and \\emph{loop\\_tracer};',
    'for Wastrumentation, the instrumented module, compiled with the fewest memory pages with which the analysis works;',
    '\\wasmito does not change the module.',
    '`--\' denotes that the analysis is not available in the framework.}',
    '\\label{tab:size_overhead}',
    '\\end{table}',
  );
  const tex = `${lines.join('\n')}\n`;
  if (opts.output) writeFileSync(opts.output, tex);
  else process.stdout.write(tex);
}

new Command()
  .option('--output <tex>', 'write the table there instead of to stdout')
  .option('--median', 'write median (min--max) instead of min--max')
  .option('--modules <dir>', 'the original Wasm-R3 modules', join(ROOT, 'bench_input_data/wasmr3_modules'))
  .option('--wei <dir>', 'the wei monitors, one subdirectory per analysis', join(ROOT, 'bench_output/modules_overhead/whamm-wei'))
  .option('--wastrumentation <dir>', 'the modules instrumented by Wastrumentation, one subdirectory per analysis',
    join(ROOT, 'bench_output/modules_overhead/wastrumentation_min_pages'))
  .option('--memory-use <csv>', 'the CSV of measure_memory_use.js, for the whamm_core.wasm and user library per module',
    join(ROOT, 'bench_output/memory_use/wizard_memory_use.csv'))
  .action(main)
  .parse();
