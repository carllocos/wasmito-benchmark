#!/usr/bin/env node
// table_memory_overhead.js
//
// Writes the memory overhead table of the paper (tab:memory_overhead) as a
// LaTeX table: per dynamic analysis, the geometric mean of the per-module
// overhead (the overhead_geomean column) of every framework.
// A JavaScript port of scripts/latex_memory_overhead_table.sh.
//
// Usage:
//   node src/table_memory_overhead.js --output <table.tex> \
//        <whamm-csv> <wastrumentation-csv> <wasmito-csv>
// e.g.
//   node src/table_memory_overhead.js \
//        --output bench_output/modules_overhead/memory_overhead.tex \
//        bench_output/modules_overhead/aggregated_metrics_whamm.csv \
//        bench_output/modules_overhead/aggregated_metrics_wastrumentation.csv \
//        bench_output/modules_overhead/aggregated_metrics_wasmito.csv
//
// Input: three aggregated metrics CSVs, each with (at least) the columns
// analysis and overhead_geomean:
//   <whamm-csv>            aggregated_metrics_whamm.csv
//                          (scripts/measure_sizes_whamm.sh)
//   <wastrumentation-csv>  aggregated_metrics_wastrumentation.csv
//                          (scripts/measure_sizes_wastrumentation.sh)
//   <wasmito-csv>          aggregated_metrics_wasmito.csv
//                          (scripts/aggregate_heap_wasmito.sh)
//
// The columns of the table:
//   static overhead   size of the instrumented module / size of the module
//     Whamm            overhead_geomean of <whamm-csv>
//     Wastr.           overhead_geomean of <wastrumentation-csv>
//     Wasmito          always 1: Wasmito leaves the module unchanged
//   dynamic overhead  (module size + heap taken by the hooks) / module size
//     Wasmito          overhead_geomean of <wasmito-csv>
// The geometric means are rounded to two decimals. The table uses the
// \wasmito macro of the paper and the multirow LaTeX package.

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
const ANALYSES = [
  ['', 'imix', 'instruction-mix', 'Instruction Mix'],
  ['basic_blocks', 'basic_blocks', 'basic-block', 'Basic Block Profiling'],
  ['instr_coverage', 'instr_coverage', 'instr-coverage', 'Instruction Coverage'],
  ['branches', 'branches', 'branches', 'Branch Coverage'],
  ['call_graph', 'call_graph', 'call-graph', 'Call Graph'],
  ['', 'taint', 'taint', 'Dynamic Taint'],
  ['mem_access', 'mem_access', 'mem_access', 'Memory Access Tracing'],
  ['', 'crypto', 'cryptomining', 'Cryptominer Detection'],
  ['', 'forward', 'forward', 'Forward'],
  ['', 'denan', 'denan', 'DeNaN'],
  ['', 'safe_heap', 'safe-heap', 'Safe Heap'],
  ['icount', '', 'icount', 'Instruction Count'],
  ['imix', '', 'imix', 'Instruction Categories'],
  ['hotness', '', 'hotness', 'Hotness'],
  ['cache_sim', '', 'cache_sim', 'Cache Simulator'],
  ['loop_tracer', '', 'loop_tracer', 'Loop Tracer'],
  HLINE,
  ['', 'order_violation', 'order-violation', 'Order Violation'],
  ['', 'variable_violation', 'variable-violation', 'Variable Atomicity Violation'],
  ['', 'data_race_violation', 'data-race-violation', 'Multi-Word Violation'],
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

// ---------------------------------------------------------------------------
// Writing the table
// ---------------------------------------------------------------------------

/**
 * The cell of `analysis` of a framework whose geometric means are
 * `geomeans`, read from `csvPath`: "--" without such an analysis, "tbd"
 * when it is still to be measured or missing from the CSV (with a warning),
 * and otherwise its geometric mean with two decimals.
 */
function cell(geomeans, csvPath, analysis) {
  if (analysis === '') return '--';
  if (analysis === TBD) return TBD;
  if (!geomeans.has(analysis)) {
    console.warn(
      `warning: analysis "${analysis}" is not in ${csvPath}, shown as tbd`,
    );
    return TBD;
  }
  return Number(geomeans.get(analysis)).toFixed(2);
}

/**
 * The lines of the LaTeX table. `frameworks` holds, for whamm, wastr and
 * wasmito, the geometric means of their CSV and the CSV's path (for the
 * warnings).
 */
function formatTable(frameworks) {
  const { whamm, wastr, wasmito } = frameworks;
  const lines = [
    '% Generated by src/table_memory_overhead.js -- do not edit by hand.',
    '% Per dynamic analysis, the geometric mean of the per-module overhead',
    '% (overhead_geomean of bench_output/modules_overhead/aggregated_metrics_*.csv).',
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
      cell(whamm.geomeans, whamm.csv, whammAnalysis).padEnd(5),
      cell(wastr.geomeans, wastr.csv, wastrAnalysis).padEnd(5),
      // Static overhead of Wasmito: it leaves the module unchanged, so 1,
      // unless it has no such analysis.
      wasmitoAnalysis === '' ? '--' : '1',
      // Dynamic overhead of Wasmito.
      cell(wasmito.geomeans, wasmito.csv, wasmitoAnalysis),
    ];
    // The row name is padded so that the columns line up in the .tex file.
    lines.push(`${rowName.padEnd(28)} & ${cells.join(' & ')} \\\\`);
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
  .name('table_memory_overhead')
  .description(
    'Write the memory overhead table of the paper (tab:memory_overhead) as LaTeX: per dynamic analysis, the geometric mean of the per-module overhead of Whamm, Wastrumentation and Wasmito.',
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
    '<wasmito-csv>',
    'the aggregated metrics of Wasmito (e.g. bench_output/modules_overhead/aggregated_metrics_wasmito.csv)',
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
      ['<wasmito-csv>', wasmitoCsv],
    ]) {
      if (!isFilePath(csv)) {
        program.error(`${name} '${csv}' does not exist`);
      }
    }

    try {
      const lines = formatTable({
        whamm: { csv: whammCsv, geomeans: readGeomeans(whammCsv) },
        wastr: { csv: wastrCsv, geomeans: readGeomeans(wastrCsv) },
        wasmito: { csv: wasmitoCsv, geomeans: readGeomeans(wasmitoCsv) },
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
