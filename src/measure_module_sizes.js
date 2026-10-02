#!/usr/bin/env node
// Measures how much instrumentation grows Wasm modules and writes a CSV with
// the header: framework,analysis,module,module_size,instrumented_size,overhead
//
// Usage: node measure_module_sizes.js <modules_dir> <framework_dir> <output_csv>
//   modules_dir    directory with the original .wasm modules
//   framework_dir  directory with one subdirectory per analysis, each holding
//                  the instrumented .wasm modules under the same file names
//                  (e.g. bench_output/modules_overhead/whamm). Its name is used as
//                  the framework.
//   output_csv     path of the CSV file to write. If it already exists, the
//                  rows are appended to it (without repeating the header).
//
// Sizes are in bytes; overhead is instrumented_size / module_size.

import fs from 'node:fs';
import path from 'node:path';

const HEADER =
  'framework,analysis,module,module_size,instrumented_size,overhead';

function wasmFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.wasm'))
    .map((entry) => entry.name)
    .sort();
}

function main() {
  const [modulesDir, frameworkDir, outputCsv] = process.argv.slice(2);
  if (outputCsv === undefined) {
    console.error(
      'Usage: node measure_module_sizes.js <modules_dir> <framework_dir> <output_csv>',
    );
    process.exit(1);
  }

  const framework = path.basename(path.resolve(frameworkDir));
  const moduleSizes = new Map(
    wasmFiles(modulesDir).map((name) => [
      name,
      fs.statSync(path.join(modulesDir, name)).size,
    ]),
  );

  const analyses = fs
    .readdirSync(frameworkDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const rows = [];
  for (const analysis of analyses) {
    const analysisDir = path.join(frameworkDir, analysis);
    for (const name of wasmFiles(analysisDir)) {
      const moduleSize = moduleSizes.get(name);
      if (moduleSize === undefined) {
        console.warn(
          `Skipping ${path.join(analysisDir, name)}: no module named ${name} in ${modulesDir}`,
        );
        continue;
      }
      const instrumentedSize = fs.statSync(path.join(analysisDir, name)).size;
      const overhead = instrumentedSize / moduleSize;
      rows.push(
        [framework, analysis, path.basename(name, '.wasm'), moduleSize, instrumentedSize, overhead].join(','),
      );
    }
  }

  const existing = fs.existsSync(outputCsv)
    ? fs.readFileSync(outputCsv, 'utf8')
    : '';
  let prefix = '';
  if (existing === '') {
    prefix = HEADER + '\n';
  } else if (!existing.endsWith('\n')) {
    prefix = '\n';
  }

  fs.mkdirSync(path.dirname(path.resolve(outputCsv)), { recursive: true });
  fs.appendFileSync(outputCsv, prefix + rows.map((row) => row + '\n').join(''));
  console.log(
    `${existing === '' ? 'Wrote' : 'Appended'} ${rows.length} rows to ${outputCsv}`,
  );
}

main();
