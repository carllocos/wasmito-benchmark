#!/usr/bin/env node
// Aggregates the module sizes measured by measure_module_sizes.js per
// (framework, analysis) and writes a CSV with the header:
//   framework,analysis,module_size_sum,instrumented_size_sum,aggregate,
//   module_count,overhead_mean,overhead_geomean,overhead_median,
//   overhead_min,overhead_max,overhead_stddev
//
// Usage: node aggregate_module_sizes.js <module_sizes_csv> <output_csv>
//   module_sizes_csv  CSV written by measure_module_sizes.js
//   output_csv        path of the CSV file to write (overwritten if it exists)
//
// module_size_sum and instrumented_size_sum are the sums (in bytes) over all
// modules the analysis was applied to, and aggregate is
// instrumented_size_sum / module_size_sum. The overhead_* columns are
// statistics over the per-module overhead values (instrumented_size /
// module_size); overhead_stddev is the sample standard deviation (0 for a
// single module).

import fs from 'node:fs';
import path from 'node:path';

const HEADER = [
  'framework',
  'analysis',
  'module_size_sum',
  'instrumented_size_sum',
  'aggregate',
  'module_count',
  'overhead_mean',
  'overhead_geomean',
  'overhead_median',
  'overhead_min',
  'overhead_max',
  'overhead_stddev',
].join(',');

function readRows(csvPath) {
  const [header, ...lines] = fs
    .readFileSync(csvPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const columns = header.split(',');
  return lines.map((line) => {
    const values = line.split(',');
    return Object.fromEntries(columns.map((c, i) => [c, values[i]]));
  });
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function metrics(rows) {
  const moduleSizeSum = rows.reduce((s, r) => s + Number(r.module_size), 0);
  const instrumentedSizeSum = rows.reduce(
    (s, r) => s + Number(r.instrumented_size),
    0,
  );
  const overheads = rows.map((r) => Number(r.overhead)).sort((a, b) => a - b);
  const n = overheads.length;
  const mean = overheads.reduce((s, o) => s + o, 0) / n;
  const geomean = Math.exp(overheads.reduce((s, o) => s + Math.log(o), 0) / n);
  const variance =
    n > 1 ? overheads.reduce((s, o) => s + (o - mean) ** 2, 0) / (n - 1) : 0;
  return [
    moduleSizeSum,
    instrumentedSizeSum,
    instrumentedSizeSum / moduleSizeSum,
    n,
    mean,
    geomean,
    median(overheads),
    overheads[0],
    overheads[n - 1],
    Math.sqrt(variance),
  ];
}

function main() {
  const [moduleSizesCsv, outputCsv] = process.argv.slice(2);
  if (outputCsv === undefined) {
    console.error(
      'Usage: node aggregate_module_sizes.js <module_sizes_csv> <output_csv>',
    );
    process.exit(1);
  }

  // Groups in order of first appearance, keyed by framework and analysis.
  const groups = new Map();
  for (const row of readRows(moduleSizesCsv)) {
    const key = `${row.framework},${row.analysis}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const lines = [HEADER];
  for (const [key, rows] of groups) {
    lines.push([key, ...metrics(rows)].join(','));
  }

  fs.mkdirSync(path.dirname(path.resolve(outputCsv)), { recursive: true });
  fs.writeFileSync(outputCsv, lines.join('\n') + '\n');
  console.log(`Wrote ${groups.size} rows to ${outputCsv}`);
}

main();
