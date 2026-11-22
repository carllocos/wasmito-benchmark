/**
 * Finds, for every Wastrumentation analysis and Whamm script, the smallest
 * stack (and, for the user libraries of Whamm, the smallest stack or heap)
 * with which the four MCU modules of the concurrency bug evaluation behave
 * as with the default one, so that the linear memories are as small as
 * possible.
 *
 * Every candidate runs every module for --iterations iterations of its main
 * loop (src/measure_memory_growth.js). A candidate behaves as the default
 * one if every module ends with the same status (e.g. 'ok', or the same
 * trap, as safe_heap traps on data_race) and, for Whamm, whamm_core holds
 * the same maps afterwards. The candidates are tried from large to small
 * and the search stops at the first that does not; the user libraries keep
 * no maps in whamm_core, so for them only the status is compared.
 *
 * Inputs (see scripts/find_min_stacks_mcu.sh):
 *   bench_output/wastrumentation_stack/<size>/wastrumentation/<analysis>/<module>.wasm
 *   whamm_mcu_modules/<script>/<module>.wasm and
 *   bench_output/whamm_concurrency/<script>/<module>.wasm
 *   bench_output/whamm_core_stack/mcu/whamm_core_<size>.wasm
 *   bench_output/whamm_user_libs/{cache,tracer}_<size>.wasm
 *
 * Usage:
 *   node src/find_min_stacks_mcu.js --output <csv> [--iterations <n>] [--jobs <n>]
 *
 * Writes framework,analysis,component,size,pages,result where component is
 * 'analysis' (Wastrumentation), 'whamm_core', 'cache' or 'tracer', pages the
 * initial pages of that component with the chosen size (for Wastrumentation,
 * all memories of the instrumented module of data_race, the app's included)
 * and result the statuses of the runs with it.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MODULES = ['data_race', 'multi_variable', 'order_violation', 'single_variable'];
export const WASTR_STACKS = ['default', '65536', '16384', '8192', '4096', '2048', '1024', '512', '256', '128'];
export const CORE_STACKS = ['default', '65536', '16384', '8192', '4096', '2048', '1024', '512', '256'];
export const LIB_SIZES = {
  cache: ['default', '16384', '4096', '1024', '256'],
  tracer: ['default', '1M', '256K', '64K', '16K'],
};
/** Whamm scripts that need a user library: script -> library. */
export const USER_LIBS = { cache_sim: 'cache', loop_tracer: 'tracer' };

export const wastrPath = (size, analysis, module) =>
  join(ROOT, 'bench_output/wastrumentation_stack', size, 'wastrumentation', analysis, `${module}.wasm`);
export const whammPath = (script, module) => {
  const concurrency = join(ROOT, 'bench_output/whamm_concurrency', script, `${module}.wasm`);
  return existsSync(concurrency) ? concurrency : join(ROOT, 'whamm_mcu_modules', script, `${module}.wasm`);
};
export const corePath = (size) => join(ROOT, 'bench_output/whamm_core_stack/mcu', `whamm_core_${size}.wasm`);
export const libPath = (lib, size) => join(ROOT, 'bench_output/whamm_user_libs', `${lib}_${size}.wasm`);

/** The initial pages of the first memory the module declares. */
export function declaredPages(path) {
  const wat = execFileSync('wasm-tools', ['print', '--skeleton', path]).toString();
  return Number(wat.match(/^\s*\(memory(?: \$\S+)? \(;\d+;\)(?: i64)? (\d+)/m)[1]);
}

/** The initial pages of all memories the module declares (not imports). */
export function totalPages(path) {
  const wat = execFileSync('wasm-tools', ['print', '--skeleton', path]).toString();
  return [...wat.matchAll(/^\s*\(memory(?: \$\S+)? \(;\d+;\)(?: i64)? (\d+)/gm)].reduce((a, m) => a + Number(m[1]), 0);
}

export function usesCore(path) {
  return execFileSync('wasm-tools', ['print', '--skeleton', path]).toString().includes('(import "whamm_core"');
}

/** Runs a module; resolves to its final status and the maps of whamm_core. */
function run(path, { core, lib }, iterations) {
  const args = ['--no-warnings', join(ROOT, 'src/measure_memory_growth.js'), '--iterations', String(iterations)];
  if (core !== undefined) args.push('--whamm-core', core, '--whamm-report', '0 1 2 3 4 5 6 7 8 9');
  if (lib !== undefined) args.push('--lib', lib);
  args.push(path);
  return new Promise((resolve) => {
    execFile('node', args, { maxBuffer: 1 << 26 }, (_err, stdout, stderr) => {
      const last = stdout.trim().split('\n').at(-1) ?? '';
      // Only the maps: drop the panic of asking for a map that does not exist.
      const maps = stderr
        .split('\n')
        .filter((l) => /^(# map|== map|key |\(|-?\d|empty map)/.test(l))
        .join('\n');
      resolve({ status: last.split(',')[8] ?? `no output: ${stderr.split('\n')[0]}`, maps });
    });
  });
}

/** Runs `tasks` (functions returning promises) with at most `jobs` at once. */
async function pool(tasks, jobs) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}

/**
 * The smallest candidate whose runs equal those of the first one.
 * `runsOf(candidate)` returns the runs of the four modules.
 */
async function smallest(candidates, runsOf, compareMaps) {
  const key = (rs) => rs.map((r) => r.status + (compareMaps ? `\n${r.maps}` : '')).join('\n---\n');
  const reference = key(await runsOf(candidates[0]));
  let chosen = candidates[0];
  for (const c of candidates.slice(1)) {
    if (key(await runsOf(c)) !== reference) break;
    chosen = c;
  }
  const statuses = [...new Set((await runsOf(chosen)).map((r) => r.status))].join(' ');
  return { size: chosen, result: statuses };
}

async function main(opts) {
  const iterations = Number(opts.iterations);
  const jobs = Number(opts.jobs);
  const cache = new Map();
  const runs = (paths, env) => {
    const k = JSON.stringify([paths, env]);
    if (!cache.has(k)) cache.set(k, pool(paths.map((p) => () => run(p, env, iterations)), jobs));
    return cache.get(k);
  };
  const rows = [];

  const wastrAnalyses = execFileSync('ls', [join(ROOT, 'bench_output/wastrumentation_stack/default/wastrumentation')])
    .toString()
    .trim()
    .split('\n');
  for (const analysis of wastrAnalyses) {
    const stacks = WASTR_STACKS.filter((s) => MODULES.every((m) => existsSync(wastrPath(s, analysis, m))));
    const r = await smallest(stacks, (s) => runs(MODULES.map((m) => wastrPath(s, analysis, m)), {}), false);
    // All memories of the instrumented module (the app's and the analysis').
    const pages = totalPages(wastrPath(r.size, analysis, MODULES[0]));
    rows.push(['Wastrumentation', analysis, 'analysis', r.size, pages, r.result]);
    console.error(rows.at(-1).join(','));
  }

  const scripts = [
    ...execFileSync('ls', [join(ROOT, 'whamm_mcu_modules')]).toString().trim().split('\n'),
    ...execFileSync('ls', [join(ROOT, 'bench_output/whamm_concurrency')]).toString().trim().split('\n'),
  ];
  for (const script of scripts) {
    const paths = MODULES.map((m) => whammPath(script, m));
    if (!paths.every(existsSync)) continue;
    const lib = USER_LIBS[script];
    const libArg = (size) => (lib === undefined ? undefined : `${lib}=${libPath(lib, size)}`);
    let core;
    if (usesCore(paths[0])) {
      const r = await smallest(
        CORE_STACKS,
        (s) => runs(paths, { core: corePath(s), lib: libArg('default') }),
        true,
      );
      core = r.size;
      rows.push(['Whamm', script, 'whamm_core', r.size, declaredPages(corePath(r.size)), r.result]);
      console.error(rows.at(-1).join(','));
    }
    if (lib !== undefined) {
      const r = await smallest(
        LIB_SIZES[lib],
        (s) => runs(paths, { core: core === undefined ? undefined : corePath(core), lib: libArg(s) }),
        false,
      );
      rows.push(['Whamm', script, lib, r.size, declaredPages(libPath(lib, r.size)), r.result]);
      console.error(rows.at(-1).join(','));
    }
  }

  mkdirSync(dirname(opts.output), { recursive: true });
  writeFileSync(
    opts.output,
    `${['framework,analysis,component,size,pages,result', ...rows.map((r) => r.join(','))].join('\n')}\n`,
  );
  console.log(`Wrote ${rows.length} rows to ${opts.output}`);
}

const program = new Command()
  .requiredOption('--output <csv>', 'the CSV to write')
  .option('--iterations <n>', 'iterations of the main loop per run', '10000')
  .option('--jobs <n>', 'runs at once', '8')
  .action(main);

if (process.argv[1] === fileURLToPath(import.meta.url)) program.parse();
