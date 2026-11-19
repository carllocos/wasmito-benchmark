#!/usr/bin/env node
/**
 * Instruments the Wasm-R3 modules with every Wastrumentation analysis such
 * that the instrumented modules declare the fewest memory pages with which the
 * analysis still works.
 *
 * The pages that Wastrumentation adds are those of the analysis, which do not
 * depend on the instrumented module, but on the stack size the analysis is
 * compiled with (rustc -C link-arg=-zstack-size=N, passed through
 * CARGO_TARGET_<TRIPLE>_RUSTFLAGS as in
 * scripts/build_mcu_modules_wastrumentation_stack_sizes.sh). The pages per
 * stack size are read from the MCU builds of that script
 * (bench_output/wastrumentation_stack/<stack>/wastrumentation/<analysis>/).
 *
 * Per analysis, the candidates are, for every page count from the fewest to
 * the most, the largest stack with that page count (the safest stack among
 * those that take as many pages). For every candidate, from the first:
 *   1. the Wasm-R3 modules are instrumented with that stack
 *      (scripts/build_portable_modules_wastrumentation.sh) into
 *      bench_output/wastrumentation_stack_wasmr3/<stack>/wastrumentation/,
 *   2. every module not settled yet is run in Node.js (its _start export).
 *      It works if it does not trap, or if it traps in the same way as the
 *      module instrumented with the default stack
 *      (bench_output/modules_overhead/wastrumentation/). Otherwise it is
 *      retried with the next candidate.
 *
 * Results:
 *   bench_output/modules_overhead/wastrumentation_min_pages/<analysis>/<module>.wasm
 *     the chosen instrumented module
 *   bench_output/modules_overhead/wastrumentation_min_pages.csv
 *     analysis,module,stack,analysis_pages,total_pages,result
 *     with result ok, same_as_default (traps as with the default stack),
 *     timeout (did not finish within --timeout; kept unverified) or failed
 *     (no candidate works or could be built).
 *
 * Usage:
 *   node src/build_min_pages_wastrumentation_wasmr3.js [--analyses "<a> ..."]
 *     [--timeout <seconds>] [--skip-build]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANALYSES_CSV = join(ROOT, 'bench_config/wastrumentation_analyses.csv');
const WASMR3 = join(ROOT, 'bench_input_data/wasmr3_modules');
const MCU_BUILDS = join(ROOT, 'bench_output/wastrumentation_stack');
const BUILDS = join(ROOT, 'bench_output/wastrumentation_stack_wasmr3');
const DEFAULT_BUILD = join(ROOT, 'bench_output/modules_overhead/wastrumentation');
const OUT_DIR = join(ROOT, 'bench_output/modules_overhead/wastrumentation_min_pages');
const OUT_CSV = join(ROOT, 'bench_output/modules_overhead/wastrumentation_min_pages.csv');
const STACKS = ['128', '256', '512', '1024', '2048', '4096', '8192', '16384', '65536', 'default'];
const MCU_MODULE = 'data_race';

/** The pages of every memory a module declares (their minimum sizes). */
function memoryPages(wasm) {
  const wat = execFileSync('wasm-tools', ['print', '--skeleton', wasm], { maxBuffer: 1 << 30 }).toString();
  return [...wat.matchAll(/^\s*\(memory(?: \$\S+)? \(;\d+;\)(?: i64)? (\d+)/gm)].map((m) => Number(m[1]));
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Per stack, the pages the analysis adds, from its MCU builds. */
function analysisPagesPerStack(analysis) {
  const appPages = sum(memoryPages(join(ROOT, 'bench_input_data/mcu_modules/data_race/wasm/data_race.wasm')));
  const pages = new Map();
  for (const stack of STACKS) {
    const f = join(MCU_BUILDS, stack, 'wastrumentation', analysis, `${MCU_MODULE}.wasm`);
    if (existsSync(f)) pages.set(stack, sum(memoryPages(f)) - appPages);
  }
  return pages;
}

/** Per page count (fewest first), the largest stack with that page count. */
function candidates(pagesPerStack) {
  const best = new Map();
  for (const stack of STACKS) {
    const p = pagesPerStack.get(stack);
    if (p !== undefined) best.set(p, stack); // STACKS is ascending: the last one wins
  }
  return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([pages, stack]) => ({ pages, stack }));
}

/** Instruments the Wasm-R3 modules with `analyses` (rows of ANALYSES_CSV) and stack `stack`. */
function build(stack, rows, header) {
  const tmp = mkdtempSync(join(tmpdir(), 'wastr-min-pages-'));
  const csv = join(tmp, 'analyses.csv');
  writeFileSync(csv, `${header}\n${rows.join('\n')}\n`);
  const flags = stack === 'default' ? '' : `-C link-arg=-zstack-size=${stack}`;
  console.log(`> Instrumenting with stack ${stack}: ${rows.map((r) => r.split(',')[1]).join(' ')}`);
  spawnSync(join(ROOT, 'scripts/build_portable_modules_wastrumentation.sh'),
    ['--analyses', csv, '--modules', WASMR3, '--output', join(BUILDS, stack)], {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: {
        ...process.env,
        CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: flags,
        CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS: flags,
      },
    });
  rmSync(tmp, { recursive: true, force: true });
}

const RUNNER = `
import { readFileSync } from 'node:fs';
const { instance } = await WebAssembly.instantiate(readFileSync(process.argv[1]), {});
const f = instance.exports._start ?? instance.exports.main;
try { f(); console.log('ok'); } catch (e) { console.log('trap: ' + e.message); }
`;

/** Runs a module's _start in Node.js: 'ok', 'trap: <message>' or 'timeout'. */
function run(wasm, timeoutS) {
  const r = spawnSync(process.execPath, ['--stack-size=65500', '--input-type=module', '-e', RUNNER, wasm], {
    encoding: 'utf8',
    timeout: timeoutS * 1000,
    maxBuffer: 1 << 30,
  });
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') return 'timeout';
  const last = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  if (last === 'ok' || last.startsWith('trap:')) return last;
  return `trap: exit ${r.status} ${(r.stderr ?? '').trim().split('\n').pop()}`;
}

function main(opts) {
  const [header, ...rows] = readFileSync(ANALYSES_CSV, 'utf8').trim().split('\n');
  const rowOf = new Map(rows.map((r) => [r.split(',')[1], r]));
  const analyses = opts.analyses ? opts.analyses.split(/\s+/).filter(Boolean) : [...rowOf.keys()];
  const modules = readdirSync(WASMR3).filter((f) => f.endsWith('.wasm')).sort().map((f) => basename(f, '.wasm'));

  // Per analysis: its candidates and the modules not settled yet.
  const state = new Map();
  for (const a of analyses) {
    if (!rowOf.has(a)) throw new Error(`unknown analysis '${a}'`);
    const cands = candidates(analysisPagesPerStack(a));
    if (cands.length === 0) throw new Error(`no MCU builds of '${a}' in ${MCU_BUILDS} (run build_mcu_modules_wastrumentation_stack_sizes.sh)`);
    state.set(a, { cands, next: 0, pending: new Set(modules) });
  }

  const results = [];
  const settle = (a, m, stack, pages, result, wasm) => {
    const total = wasm ? sum(memoryPages(wasm)) : '';
    if (wasm) {
      mkdirSync(join(OUT_DIR, a), { recursive: true });
      copyFileSync(wasm, join(OUT_DIR, a, `${m}.wasm`));
    }
    results.push([a, m, stack, pages, total, result]);
    console.log(`  ${a} ${m}: stack ${stack} (${pages} analysis pages): ${result}`);
  };

  // Rounds: every analysis with pending modules tries its next candidate.
  for (;;) {
    const round = [...state.entries()].filter(([, s]) => s.pending.size > 0 && s.next < s.cands.length);
    if (round.length === 0) break;
    const byStack = new Map();
    for (const [a, s] of round) {
      const { stack } = s.cands[s.next];
      if (!byStack.has(stack)) byStack.set(stack, []);
      byStack.get(stack).push(a);
    }
    if (!opts.skipBuild) {
      for (const [stack, as] of byStack) build(stack, as.map((a) => rowOf.get(a)), header);
    }
    for (const [a, s] of round) {
      const { stack, pages } = s.cands[s.next];
      s.next++;
      const last = s.next === s.cands.length;
      for (const m of [...s.pending]) {
        const wasm = join(BUILDS, stack, 'wastrumentation', a, `${m}.wasm`);
        if (!existsSync(wasm)) {
          if (last) { settle(a, m, stack, pages, 'failed', undefined); s.pending.delete(m); }
          continue;
        }
        const r = run(wasm, opts.timeout);
        if (r === 'ok' || r === 'timeout') {
          settle(a, m, stack, pages, r, wasm);
          s.pending.delete(m);
          continue;
        }
        // It traps: fine if it traps in the same way with the default stack.
        const ref = join(DEFAULT_BUILD, a, `${m}.wasm`);
        const refResult = existsSync(ref) ? run(ref, opts.timeout) : 'missing';
        if (refResult === r) {
          settle(a, m, stack, pages, 'same_as_default', wasm);
          s.pending.delete(m);
        } else if (last) {
          settle(a, m, stack, pages, 'failed', undefined);
          s.pending.delete(m);
        } else {
          console.log(`  ${a} ${m}: stack ${stack} ${r}; retrying with a larger stack`);
        }
      }
    }
  }

  results.sort((x, y) => (x[0] + x[1]).localeCompare(y[0] + y[1]));
  writeFileSync(OUT_CSV, `analysis,module,stack,analysis_pages,total_pages,result\n${results.map((r) => r.join(',')).join('\n')}\n`);
  console.log(`Wrote ${OUT_CSV} and the modules to ${OUT_DIR}`);
}

new Command()
  .option('--analyses <names>', 'space-separated analyses (default: all of bench_config/wastrumentation_analyses.csv)')
  .option('--timeout <seconds>', 'timeout per run of a module', (v) => Number.parseInt(v, 10), 600)
  .option('--skip-build', 'reuse the builds in bench_output/wastrumentation_stack_wasmr3/')
  .action(main)
  .parse();
