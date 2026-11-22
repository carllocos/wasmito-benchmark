/**
 * Writes the sizes in bytes of the modules that Wastrumentation and Whamm
 * produce for every analysis on the four MCU modules of the concurrency bug
 * evaluation, with the stacks of min_stacks.csv (src/find_min_stacks_mcu.js),
 * next to the size of the original module.
 *
 * Usage:
 *   node src/mcu_module_sizes.js --stacks <min_stacks.csv> --output <csv>
 *
 * Columns:
 *   framework, analysis, module, stack (of the analysis or whamm_core),
 *   original_bytes      the uninstrumented module
 *   instrumented_bytes  the instrumented module (for Wastrumentation the
 *                       analysis is merged into it)
 *   whamm_core_bytes    whamm_core.wasm, if the instrumented module imports it
 *   user_library, user_library_size, user_library_bytes
 *                       the user library of cache_sim / loop_tracer
 *   total_bytes         instrumented + whamm_core + user library
 */
import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { MODULES, USER_LIBS, wastrPath, whammPath, corePath, libPath, usesCore } from './find_min_stacks_mcu.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_DIRS = {
  data_race: 'data_race',
  multi_variable: 'multi_variable',
  order_violation: 'toggle_led_bug',
  single_variable: 'single_variable',
};
const originalPath = (m) => join(ROOT, 'bench_input_data/mcu_modules', MODULE_DIRS[m], 'wasm', `${m}.wasm`);
const size = (p) => statSync(p).size;

function main(opts) {
  const lines = readFileSync(opts.stacks, 'utf8').trim().split('\n').slice(1);
  const stacks = {};
  for (const l of lines) {
    const [framework, analysis, component, s] = l.split(',');
    stacks[`${framework}/${analysis}/${component}`] = s;
  }
  const rows = [];
  const wastrAnalyses = readdirSync(join(ROOT, 'bench_output/wastrumentation_stack/default/wastrumentation')).sort();
  for (const analysis of wastrAnalyses) {
    const stack = stacks[`Wastrumentation/${analysis}/analysis`] ?? 'default';
    for (const m of MODULES) {
      const p = wastrPath(stack, analysis, m);
      if (!existsSync(p)) continue;
      const bytes = size(p);
      rows.push(['Wastrumentation', analysis, m, stack, size(originalPath(m)), bytes, 0, '', '', 0, bytes]);
    }
  }
  const scripts = [
    ...readdirSync(join(ROOT, 'whamm_mcu_modules')),
    ...readdirSync(join(ROOT, 'bench_output/whamm_concurrency')),
  ].sort();
  for (const script of scripts) {
    for (const m of MODULES) {
      const p = whammPath(script, m);
      if (!existsSync(p)) continue;
      const coreStack = usesCore(p) ? stacks[`Whamm/${script}/whamm_core`] ?? 'default' : '';
      const coreBytes = coreStack === '' ? 0 : size(corePath(coreStack));
      const lib = USER_LIBS[script] ?? '';
      const libSize = lib === '' ? '' : stacks[`Whamm/${script}/${lib}`] ?? 'default';
      const libBytes = lib === '' ? 0 : size(libPath(lib, libSize));
      const bytes = size(p);
      rows.push(['Whamm', script, m, coreStack, size(originalPath(m)), bytes, coreBytes, lib, libSize, libBytes,
        bytes + coreBytes + libBytes]);
    }
  }
  const header = 'framework,analysis,module,stack,original_bytes,instrumented_bytes,whamm_core_bytes,' +
    'user_library,user_library_size,user_library_bytes,total_bytes';
  mkdirSync(dirname(opts.output), { recursive: true });
  writeFileSync(opts.output, `${[header, ...rows.map((r) => r.join(','))].join('\n')}\n`);
  console.log(`Wrote ${rows.length} rows to ${opts.output}`);
}

new Command()
  .requiredOption('--stacks <csv>', 'min_stacks.csv of src/find_min_stacks_mcu.js')
  .requiredOption('--output <csv>', 'the CSV to write')
  .action(main)
  .parse();
