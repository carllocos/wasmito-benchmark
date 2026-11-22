#!/usr/bin/env node
// latex_table_memory_overhead.js
//
// Writes the memory overhead table of the paper (tab:memory_overhead) as a
// LaTeX table: per dynamic analysis, the geometric mean over the Wasm
// modules of the overhead of every framework.
// A variant of table_memory_overhead.js whose dynamic overhead of Wasmito is
// computed from the heap measurements (heap.csv) instead of read from
// aggregated_metrics_wasmito.csv.
//
// Usage:
//   node src/latex_table_memory_overhead.js --output <table.tex> \
//        <whamm-csv> <wastrumentation-csv> <wasmito-heap-csv>
// e.g.
//   node src/latex_table_memory_overhead.js \
//        --output bench_output/modules_overhead/memory_overhead.tex \
//        bench_output/modules_overhead/aggregated_metrics_whamm.csv \
//        bench_output/modules_overhead/aggregated_metrics_wastrumentation.csv \
//        bench_output/heap_usage/heap.csv
//
// Input:
//   <whamm-csv>            aggregated_metrics_whamm.csv
//                          (scripts/measure_sizes_whamm.sh), with (at least)
//                          the columns analysis and overhead_geomean
//   <wastrumentation-csv>  aggregated_metrics_wastrumentation.csv
//                          (scripts/measure_sizes_wastrumentation.sh), with
//                          (at least) the columns analysis and
//                          overhead_geomean
//   <wasmito-heap-csv>     heap.csv (bench_output/heap_usage/heap.csv), one
//                          row per analysis and Wasm module, with (at least)
//                          the columns analysis, heap_used_before_deploy and
//                          deploy_delta (the heap taken by deploying the
//                          analysis' hooks, in bytes)
//
// The columns of the table:
//   static overhead   size of the instrumented module / size of the module,
//                     written as a factor, e.g. 1.23x
//     Whamm            overhead_geomean of <whamm-csv>
//     Wastr.           overhead_geomean of <wastrumentation-csv>
//     Wasmito          always 1x: Wasmito leaves the module unchanged
//   dynamic overhead  deploy_delta / heap_used_before_deploy, written as a
//                     percentage, e.g. 9.28%
//     Wasmito          per analysis, the geometric mean over the Wasm
//                      modules of <wasmito-heap-csv> of that ratio
// The numbers are rounded to two decimals. The table uses the \wasmito macro
// of the paper and the multirow LaTeX package.

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// The rows of the table
// ---------------------------------------------------------------------------

// Marks a horizontal line between two rows in ANALYSES.
const HLINE = '---';

// Marks an analysis that exists but is still to be measured; its cell is
// shown as "tbd".
const TBD = 'tbd';

// The rows of the table, in order. Every row is
//   [<whamm analysis>, <wastrumentation analysis>, <wasmito analysis>, <row name>]
// The first three are the names the frameworks give the analysis (the
// analysis column of their CSV; the frameworks name the same analysis
// differently, e.g. call_graph and call-graph). The last is the name of the
// row in the table. An empty name ('') means that the framework has no such
// analysis: its cells are shown as "--" (for Wasmito both its static and its
// dynamic overhead). An analysis that is named here but missing from its CSV
// is shown as "tbd", with a warning. HLINE draws a horizontal line.
/**
whamm, Wastrumentation,wasmito
basic_blocks, basic_blocks,basic-block
branches, branches,branches
cache_sim, _,cache_sim
call_graph,call_graph,call-graph
_, crypto,cryptomining
_,denan,denan
_,forward,forward
hotness,_,hotness
icount,_,icount
imix,imix, imix, instruction-mix
instr_coverage,instr_coverage, instr-coverage
loop_tracer,_,loop_tracer
mem_access,mem_access,mem_access
_,safe_heap, safe-heap
_,taint, taint

_,data_race_violation, data-race-violation
_,order_violation, order-violation
_,variable_violation, variable-violation
**/
//whamm, Wastrumentation,wasmito
const ANALYSES = [
  ['imix', 'imix', 'instruction-mix', 'instruction-mix'],
  ['basic_blocks', 'basic_blocks', 'basic-block', 'basic-block'],
  ['instr_coverage', 'instr_coverage', 'instr-coverage', 'instr-coverage'],
  ['branches', 'branches', 'branches', 'branches'],
  ['call_graph', 'call_graph', 'call-graph', 'call-graph'],
  ['', 'taint', 'taint', 'taint'],
  ['mem_access', 'mem_access', 'mem_access', 'mem_access'],
  ['', 'crypto', 'cryptomining', 'cryptomining'],
  ['', 'forward', 'forward', 'forward'],
  ['', 'denan', 'denan', 'denan'],
  ['', 'safe_heap', 'safe-heap', 'safe-heap'],
  ['icount', '', 'icount', 'icount'],
  ['hotness', '', 'hotness', 'hotness'],
  ['cache_sim', '', 'cache_sim', 'cache_sim'],
  ['loop_tracer', '', 'loop_tracer', 'loop_tracer'],
  HLINE,
  ['', 'order_violation', 'order-violation', 'order violation'],
  ['', 'variable_violation', 'variable-violation', 'variable-atomicity violation'],
  ['', 'data_race_violation', 'data-race-violation', 'multi-word violation'],
];

// ---------------------------------------------------------------------------
// Reading the CSVs
// ---------------------------------------------------------------------------

/** Whether `filePath` exists and is a regular file. */
function isFilePath(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Reads the overhead_geomean of every analysis of an aggregated metrics CSV,
 * as a Map from analysis name to the value (a string, as written in the
 * CSV). The CSVs contain no quoted fields, so splitting on ',' is enough.
 */
function readGeomeans(csvPath) {
  const lines = fs
    .readFileSync(csvPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const header = (lines[0] ?? '').split(',');
  const analysisIdx = header.indexOf('analysis');
  const geomeanIdx = header.indexOf('overhead_geomean');
  if (analysisIdx < 0 || geomeanIdx < 0) {
    throw new Error(
      `${csvPath} needs the columns analysis and overhead_geomean`,
    );
  }
  const geomeans = new Map();
  for (const line of lines.slice(1)) {
    const fields = line.split(',');
    geomeans.set(fields[analysisIdx], fields[geomeanIdx]);
  }
  return geomeans;
}

/**
 * Reads Wasmito's heap measurements (heap.csv) and returns, per analysis,
 * the geometric mean over its Wasm modules of
 *   deploy_delta / heap_used_before_deploy
 * as a Map from analysis name to that number (a fraction, not yet a
 * percentage). The geometric mean is exp(mean(log(ratio))), so every ratio
 * must be positive. The CSV contains no quoted fields, so splitting on ','
 * is enough.
 */
function readHeapGeomeans(csvPath) {
  const lines = fs
    .readFileSync(csvPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const header = (lines[0] ?? '').split(',');
  const analysisIdx = header.indexOf('analysis');
  const beforeIdx = header.indexOf('heap_used_before_deploy');
  const deltaIdx = header.indexOf('deploy_delta');
  if (analysisIdx < 0 || beforeIdx < 0 || deltaIdx < 0) {
    throw new Error(
      `${csvPath} needs the columns analysis, heap_used_before_deploy and deploy_delta`,
    );
  }

  // Per analysis: the sum of the logs of its ratios and how many there are.
  const logSums = new Map();
  for (const [i, line] of lines.slice(1).entries()) {
    const fields = line.split(',');
    const analysis = fields[analysisIdx];
    const before = Number(fields[beforeIdx]);
    const delta = Number(fields[deltaIdx]);
    if (!(before > 0) || !(delta > 0)) {
      throw new Error(
        `line ${i + 2} of ${csvPath}: heap_used_before_deploy and deploy_delta must be positive numbers`,
      );
    }
    const sum = logSums.get(analysis) ?? { logs: 0, count: 0 };
    sum.logs += Math.log(delta / before);
    sum.count += 1;
    logSums.set(analysis, sum);
  }

  const geomeans = new Map();
  for (const [analysis, { logs, count }] of logSums) {
    geomeans.set(analysis, Math.exp(logs / count));
  }
  return geomeans;
}

// ---------------------------------------------------------------------------
// Writing the table
// ---------------------------------------------------------------------------

// How the numbers are written in the table: the static overhead as a factor
// (1.23 -> 1.23$\times$, which LaTeX shows as 1.23x) and the dynamic
// overhead as a percentage (0.0928 -> 9.28\%).
const asFactor = (v) => `${Number(v).toFixed(2)}$\\times$`;
const asPercentage = (v) => `${(Number(v) * 100).toFixed(2)}\\%`;

/**
 * The cell of `analysis` of a framework whose geometric means are
 * `geomeans`, read from `csvPath`: "--" without such an analysis, "tbd"
 * when it is still to be measured or missing from the CSV (with a warning),
 * and otherwise its geometric mean written by `format` (asFactor or
 * asPercentage).
 */
function cell(geomeans, csvPath, analysis, format) {
  if (analysis === '') return '--';
  if (analysis === TBD) return TBD;
  if (!geomeans.has(analysis)) {
    console.warn(
      `warning: analysis "${analysis}" is not in ${csvPath}, shown as tbd`,
    );
    return TBD;
  }
  return format(geomeans.get(analysis));
}

/**
 * `text` with every underscore escaped as \_, so that LaTeX prints it
 * instead of treating it as a subscript (which fails outside math mode),
 * e.g. mem_access -> mem\_access. Underscores that are already escaped
 * (\_) are left as they are.
 */
function latexEscape(text) {
  return text.replace(/(?<!\\)_/g, '\\_');
}

/**
 * The lines of the LaTeX table. `frameworks` holds, for whamm, wastr and
 * wasmito, the geometric means of their CSV and the CSV's path (for the
 * warnings).
 */
function formatTable(frameworks) {
  const { whamm, wastr, wasmito } = frameworks;
  const lines = [
    '% Generated by src/latex_table_memory_overhead.js -- do not edit by hand.',
    '% Per dynamic analysis, the geometric mean of the per-module overhead:',
    '% static: overhead_geomean of aggregated_metrics_{whamm,wastrumentation}.csv,',
    '% dynamic: deploy_delta / heap_used_before_deploy of heap_usage/heap.csv.',
    '\\begin{table}',
    '\\centering',
    '\\small',
    '\\begin{tabular}{l|c@{\\hspace{6pt}}c@{\\hspace{6pt}}c|c}',
    '\\hline',
    '\\multirow{2}{*}{\\textbf{Analysis}}',
    '  & \\multicolumn{3}{c|}{\\textbf{Static overhead}}',
    '  & \\textbf{Dynamic overhead} \\\\',
    '  & Whamm & Wastr. & \\wasmito & \\wasmito \\\\',
    '\\hline',
  ];
  for (const row of ANALYSES) {
    if (row === HLINE) {
      lines.push('\\hline');
      continue;
    }
    const [whammAnalysis, wastrAnalysis, wasmitoAnalysis, rowName] = row;
    const cells = [
      // Static overhead of Whamm and of Wastrumentation.
      cell(whamm.geomeans, whamm.csv, whammAnalysis, asFactor).padEnd(13),
      cell(wastr.geomeans, wastr.csv, wastrAnalysis, asFactor).padEnd(13),
      // Static overhead of Wasmito: it leaves the module unchanged, so 1x,
      // unless it has no such analysis.
      wasmitoAnalysis === '' ? '--' : '1$\\times$',
      // Dynamic overhead of Wasmito, from the heap measurements.
      cell(wasmito.geomeans, wasmito.csv, wasmitoAnalysis, asPercentage),
    ];
    // The row name is padded so that the columns line up in the .tex file.
    lines.push(`${latexEscape(rowName).padEnd(28)} & ${cells.join(' & ')} \\\\`);
  }
  lines.push('\\hline', '\\end{tabular}', '\\label{tab:memory_overhead}', '\\end{table}');
  return lines;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

// `commander` parses the command line: it checks that the three CSV paths
// and --output are given, prints --help, and then calls the `.action`
// function below with the three paths and the parsed options.
const program = new Command();
program
  .name('latex_table_memory_overhead')
  .description(
    'Write the memory overhead table of the paper (tab:memory_overhead) as LaTeX: per dynamic analysis, the geometric mean of the per-module overhead of Whamm and Wastrumentation (static, as a factor) and of Wasmito (dynamic: deploy_delta / heap_used_before_deploy of heap.csv, as a percentage).',
  )
  .argument(
    '<whamm-csv>',
    'the aggregated metrics of Whamm (e.g. bench_output/modules_overhead/aggregated_metrics_whamm.csv)',
  )
  .argument(
    '<wastrumentation-csv>',
    'the aggregated metrics of Wastrumentation (e.g. bench_output/modules_overhead/aggregated_metrics_wastrumentation.csv)',
  )
  .argument(
    '<wasmito-heap-csv>',
    'the heap measurements of Wasmito, with the columns analysis, heap_used_before_deploy and deploy_delta (e.g. bench_output/heap_usage/heap.csv)',
  )
  .requiredOption(
    '-o, --output <table.tex>',
    'the file to write the LaTeX table to; its directory is created if it does not exist (required)',
  )
  .action((whammCsv, wastrCsv, wasmitoCsv, options) => {
    // program.error prints the message and exits the process.
    for (const [name, csv] of [
      ['<whamm-csv>', whammCsv],
      ['<wastrumentation-csv>', wastrCsv],
      ['<wasmito-heap-csv>', wasmitoCsv],
    ]) {
      if (!isFilePath(csv)) {
        program.error(`${name} '${csv}' does not exist`);
      }
    }

    try {
      const lines = formatTable({
        whamm: { csv: whammCsv, geomeans: readGeomeans(whammCsv) },
        wastr: { csv: wastrCsv, geomeans: readGeomeans(wastrCsv) },
        wasmito: { csv: wasmitoCsv, geomeans: readHeapGeomeans(wasmitoCsv) },
      });
      fs.mkdirSync(path.dirname(path.resolve(options.output)), {
        recursive: true,
      });
      fs.writeFileSync(options.output, lines.join('\n') + '\n');
      console.log(`> Wrote ${options.output}`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : e;
      program.error(`error: ${errMsg}`);
    }
  });

// Parse the command line and run the action above.
program.parse();
