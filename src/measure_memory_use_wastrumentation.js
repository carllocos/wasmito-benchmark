#!/usr/bin/env node
/**
 * Measures the memory (maximum resident set size) that the Wizard engine
 * (wizeng) uses to run every Wasm module, without instrumentation and once
 * instrumented by every Wastrumentation analysis
 * (scripts/build_portable_modules_wastrumentation.sh), in the same way as
 * src/measure_memory_use.js does for Whamm's wei monitors.
 *
 * For every module it runs
 *   1. wizeng on the original module (analysis "no-analysis"), and
 *   2. for every analysis in --instrumented, wizeng on the module that
 *      Wastrumentation instrumented with the analysis
 *      (<instrumented>/<analysis>/<module>.wasm), which imports nothing: the
 *      analysis is merged into it. By default these are the modules of
 *      src/build_min_pages_wastrumentation_wasmr3.js, which declare the fewest
 *      memory pages with which the analysis still works.
 * each under the time command, whose "Maximum resident set size" is stored
 * in KiB:
 *   - Linux: /usr/bin/time -v   ("Maximum resident set size (kbytes): N")
 *   - macOS: /usr/bin/time -l   ("N  maximum resident set size", in bytes),
 *     only to test the script with the JVM build of Wizard (--target jvm).
 *
 * On x86-64 (Linux), wizeng runs with --mode=jit; the JVM build has no
 * --mode.
 *
 * Usage:
 *   node src/measure_memory_use_wastrumentation.js [--target x86-64|jvm]
 *     [--modules <dir|file>] [--instrumented <dir>] [--analyses "<a> <b> ..."]
 *     [--stacks <csv>] [--runs <n>] [--timeout <seconds>] [--output <csv>]
 *     [--no-baseline]
 *
 * Output CSV (rows are appended as they are measured, so an interrupted run
 * keeps what it measured; the file is recreated at the start):
 *   target, mode, analysis, module, stack, run, exit_code, status,
 *   max_rss_kbytes
 * stack is the stack size (bytes, or "default") the analysis was compiled
 * with for that module, from --stacks (by default <instrumented>.csv, i.e.
 * the wastrumentation_min_pages.csv of
 * src/build_min_pages_wastrumentation_wasmr3.js, with columns analysis,
 * module, stack, ...); it is empty for the original modules and when
 * --stacks has no row for the analysis and module.
 * mode is "wizeng" (the original module) or "wastrumentation"; status is ok,
 * trap, timeout, missing (no instrumented module, e.g. Wastrumentation failed
 * to instrument it) or error (non-zero exit or an error message of wizeng).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIZARD_BIN = join(ROOT, 'wizard/bin');

const HEADER = 'target,mode,analysis,module,stack,run,exit_code,status,max_rss_kbytes';

/** The time command and how to read the maximum resident set size (KiB) from its output. */
function timeCommand() {
  if (platform() === 'linux') {
    return {
      args: ['-v'],
      maxRss: (out) => {
        const m = out.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
        return m ? Number(m[1]) : null;
      },
    };
  }
  if (platform() === 'darwin') {
    return {
      args: ['-l'],
      maxRss: (out) => {
        const m = out.match(/(\d+)\s+maximum resident set size/);
        return m ? Math.round(Number(m[1]) / 1024) : null;
      },
    };
  }
  throw new Error(`unsupported platform '${platform()}'`);
}

/** The timeout command (GNU coreutils), which kills the whole process group. */
function timeoutCommand() {
  for (const bin of ['timeout', 'gtimeout']) {
    if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0) return bin;
  }
  throw new Error("'timeout' not found (install GNU coreutils)");
}

const wasmFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.wasm')).sort().map((f) => join(dir, f));

function modulesOf(path) {
  if (!existsSync(path)) throw new Error(`modules '${path}' do not exist`);
  return statSync(path).isDirectory() ? wasmFiles(path) : [path];
}

/** Classifies a run of wizeng from its exit code and output. */
function statusOf(code, out) {
  if (code === 124 || code === 137) return 'timeout';
  if (/!trap/.test(out)) return 'trap';
  if (code !== 0 || /unknown module|unknown import|error:/i.test(out)) return 'error';
  return 'ok';
}

function main(opts) {
  const time = timeCommand();
  const timeout = timeoutCommand();
  const wizeng = opts.wizeng ?? join(WIZARD_BIN, opts.target === 'jvm' ? 'wizeng.jvm' : 'wizeng.x86-64-linux');
  if (!existsSync(wizeng)) throw new Error(`wizeng '${wizeng}' does not exist`);
  const modeFlags = opts.target === 'x86-64' ? ['--mode=jit'] : [];

  const modules = modulesOf(resolve(opts.modules));
  if (!existsSync(opts.instrumented)) throw new Error(`instrumented modules '${opts.instrumented}' do not exist`);
  const analyses = opts.analyses
    ? opts.analyses.split(/\s+/).filter(Boolean)
    : readdirSync(opts.instrumented, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

  // The stack size per analysis and module.
  const stacksCsv = opts.stacks ?? `${resolve(opts.instrumented)}.csv`;
  const stacks = new Map();
  if (existsSync(stacksCsv)) {
    const [header, ...lines] = readFileSync(stacksCsv, 'utf8').trim().split('\n');
    const cols = header.split(',');
    const [ia, im, is] = ['analysis', 'module', 'stack'].map((c) => cols.indexOf(c));
    if (ia < 0 || im < 0 || is < 0) throw new Error(`'${stacksCsv}' has no analysis, module and stack columns`);
    for (const l of lines) {
      const v = l.split(',');
      stacks.set(`${v[ia]}/${v[im]}`, v[is]);
    }
  } else {
    console.warn(`warning: no stack sizes ('${stacksCsv}' does not exist): the stack column stays empty`);
  }
  const stackOf = (analysis, name) => stacks.get(`${analysis}/${name}`) ?? '';

  mkdirSync(dirname(resolve(opts.output)), { recursive: true });
  writeFileSync(opts.output, `${HEADER}\n`);

  /** Runs wizeng on `module` under time and timeout; returns the exit code, status and max RSS (KiB). */
  const measure = (module) => {
    const r = spawnSync(timeout, [String(opts.timeout), '/usr/bin/time', ...time.args, wizeng, ...modeFlags, module], {
      encoding: 'utf8',
      maxBuffer: 1 << 30,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const code = r.status ?? 1;
    return { code, status: statusOf(code, out), maxRss: time.maxRss(r.stderr ?? '') };
  };

  const write = (row) => appendFileSync(opts.output, `${row.join(',')}\n`);

  for (const module of modules) {
    const name = basename(module, '.wasm');
    for (let run = 1; run <= opts.runs; run++) {
      if (opts.baseline) {
        const r = measure(module);
        write([opts.target, 'wizeng', 'no-analysis', name, '', run, r.code, r.status, r.maxRss ?? '']);
        console.log(`${name} no-analysis run ${run}: ${r.status}, ${r.maxRss} KiB`);
      }
      for (const analysis of analyses) {
        const instrumented = join(opts.instrumented, analysis, basename(module));
        if (!existsSync(instrumented)) {
          write([opts.target, 'wastrumentation', analysis, name, stackOf(analysis, name), run, '', 'missing', '']);
          console.log(`${name} ${analysis} run ${run}: missing (no ${instrumented})`);
          continue;
        }
        const r = measure(instrumented);
        write([opts.target, 'wastrumentation', analysis, name, stackOf(analysis, name), run, r.code, r.status, r.maxRss ?? '']);
        console.log(`${name} ${analysis} run ${run}: ${r.status}, ${r.maxRss} KiB`);
      }
    }
  }
  console.log(`Wrote ${opts.output}`);
}

new Command()
  .option('--target <target>', 'the wizeng build: x86-64 (Linux, --mode=jit) or jvm', 'x86-64')
  .option('--wizeng <path>', 'the wizeng binary (default: wizard/bin/wizeng.<target>)')
  .option('--modules <dir|file>', 'the original .wasm module or a directory of them',
    join(ROOT, 'bench_input_data/wasmr3_modules'))
  .option('--instrumented <dir>', 'the instrumented modules, one subdirectory per analysis',
    join(ROOT, 'bench_output/modules_overhead/wastrumentation_min_pages'))
  .option('--stacks <csv>', 'the stack size per analysis and module (default: <instrumented>.csv)')
  .option('--analyses <names>', 'space-separated analyses (default: every subdirectory of --instrumented)')
  .option('--runs <n>', 'runs per module and analysis', (v) => Number.parseInt(v, 10), 1)
  .option('--timeout <seconds>', 'timeout per run', (v) => Number.parseInt(v, 10), 600)
  .option('--output <csv>', 'the CSV to write',
    join(ROOT, 'bench_output/memory_use/wizard_memory_use_wastrumentation.csv'))
  .option('--no-baseline', 'skip the runs of wizeng on the original modules')
  .action((opts) => {
    if (!['x86-64', 'jvm'].includes(opts.target)) throw new Error(`unknown target '${opts.target}'`);
    main(opts);
  })
  .parse();
