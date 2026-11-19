#!/usr/bin/env node
/**
 * Measures the memory (maximum resident set size) that the Wizard engine
 * (wizeng) uses to run every Wasm module, without and with the wei monitors
 * that Whamm compiled (scripts/build_wei_modules_whamm.sh).
 *
 * For every module it runs
 *   1. wizeng without monitors (analysis "no-analysis"), and
 *   2. for every analysis in --monitors, wizeng with the analysis' wei monitor:
 *        wizeng --env=TO_CONSOLE=true --expose=wizeng \
 *          --monitors=<monitor>+<dir>/whamm_core.wasm[+<dir>/<lib>.wasm] <module>
 *      with, per analysis, the smallest whamm_core.wasm (and user library) of
 *      --stacks (min_stacks.csv of src/find_min_stacks_mcu.js). If the
 *      analysis traps with it (e.g. !trap[MEMORY_OOB] when its stack is too
 *      small), the run is retried with the next larger whamm_core.wasm; the
 *      whamm_core.wasm that was used is written to the CSV.
 * each under the time command, whose "Maximum resident set size" is stored
 * in KiB:
 *   - Linux: /usr/bin/time -v   ("Maximum resident set size (kbytes): N")
 *   - macOS: /usr/bin/time -l   ("N  maximum resident set size", in bytes),
 *     only to test the script with the JVM build of Wizard (--target jvm).
 *
 * On x86-64 (Linux), wizeng runs with --mode=jit; the JVM build has no
 * --mode.
 *
 * Wizard names each linked module after its file name, so whamm_core.wasm and
 * the user libraries are copied to a temporary directory under the names that
 * the monitors import (whamm_core.wasm, cache.wasm, tracer.wasm).
 *
 * Usage:
 *   node src/measure_memory_use.js [--target x86-64|jvm] [--modules <dir|file>]
 *     [--monitors <dir>] [--stacks <min_stacks.csv>] [--analyses "<a> <b> ..."]
 *     [--runs <n>] [--timeout <seconds>] [--output <csv>] [--no-baseline]
 *
 * Output CSV (rows are appended as they are measured, so an interrupted run
 * keeps what it measured; the file is recreated at the start):
 *   target, mode, analysis, module, whamm_core_stack, user_library, run,
 *   exit_code, status, max_rss_kbytes
 * mode is "wizeng" (no monitors) or "wei"; status is ok, trap, timeout or
 * error (non-zero exit or an error message of wizeng, e.g. a missing import).
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIZARD_BIN = join(ROOT, 'wizard/bin');
const CORE_DIR = join(ROOT, 'bench_output/whamm_core_stack/mcu');
const LIB_DIR = join(ROOT, 'bench_output/whamm_user_libs');

// From the smallest to the largest: the retry order when an analysis traps.
const CORE_STACKS = ['256', '512', '1024', '2048', '4096', '8192', '16384', '65536', 'default'];
// The user library each analysis imports (file <lib>_<size>.wasm in LIB_DIR).
const USER_LIBS = { cache_sim: 'cache', loop_tracer: 'tracer' };
const DEFAULT_LIB_SIZES = { cache: '256', tracer: '16K' };

const HEADER = 'target,mode,analysis,module,whamm_core_stack,user_library,run,exit_code,status,max_rss_kbytes';

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

/** Per analysis, the smallest whamm_core stack and user library size of min_stacks.csv. */
function readStacks(file) {
  const stacks = {};
  if (!existsSync(file)) {
    console.warn(`warning: '${file}' does not exist; starting every analysis from the smallest whamm_core`);
    return stacks;
  }
  for (const line of readFileSync(file, 'utf8').trim().split('\n').slice(1)) {
    const [framework, analysis, component, size] = line.split(',');
    if (framework !== 'Whamm') continue;
    stacks[analysis] ??= {};
    stacks[analysis][component] = size;
  }
  return stacks;
}

/** The wei monitor of an analysis for a module (the monitor does not depend on the module). */
function monitorOf(monitorsDir, analysis, module) {
  const dir = join(monitorsDir, analysis);
  const own = join(dir, basename(module));
  if (existsSync(own)) return own;
  const any = wasmFiles(dir)[0];
  if (any === undefined) throw new Error(`no wei monitor in '${dir}'`);
  return any;
}

/** Whether a Wasm module imports from the module named `name` (its name appears in the import section). */
const importsFrom = (wasm, name) => readFileSync(wasm).includes(Buffer.from(name));

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
  const analyses = opts.analyses
    ? opts.analyses.split(/\s+/).filter(Boolean)
    : readdirSync(opts.monitors, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const stacks = readStacks(opts.stacks);

  mkdirSync(dirname(resolve(opts.output)), { recursive: true });
  writeFileSync(opts.output, `${HEADER}\n`);
  const tmp = mkdtempSync(join(tmpdir(), 'measure_memory_use-'));

  /** A directory holding whamm_core.wasm (and <lib>.wasm), as the monitors import them. */
  const libsDir = (coreStack, lib, libSize) => {
    const dir = join(tmp, `core_${coreStack}${lib ? `_${lib}_${libSize}` : ''}`);
    if (!existsSync(dir)) {
      mkdirSync(dir);
      if (coreStack) copyFileSync(join(CORE_DIR, `whamm_core_${coreStack}.wasm`), join(dir, 'whamm_core.wasm'));
      if (lib) copyFileSync(join(LIB_DIR, `${lib}_${libSize}.wasm`), join(dir, `${lib}.wasm`));
    }
    return dir;
  };

  /** Runs wizeng with `args` under time and timeout; returns the exit code, status and max RSS (KiB). */
  const measure = (args) => {
    const r = spawnSync(timeout, [String(opts.timeout), '/usr/bin/time', ...time.args, wizeng, ...args], {
      encoding: 'utf8',
      maxBuffer: 1 << 30,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const code = r.status ?? 1;
    return { code, status: statusOf(code, out), maxRss: time.maxRss(r.stderr ?? '') };
  };

  const write = (row) => appendFileSync(opts.output, `${row.join(',')}\n`);

  try {
    for (const module of modules) {
      const name = basename(module, '.wasm');
      for (let run = 1; run <= opts.runs; run++) {
        if (opts.baseline) {
          const r = measure([...modeFlags, module]);
          write([opts.target, 'wizeng', 'no-analysis', name, '', '', run, r.code, r.status, r.maxRss ?? '']);
          console.log(`${name} no-analysis run ${run}: ${r.status}, ${r.maxRss} KiB`);
        }
        for (const analysis of analyses) {
          const monitor = monitorOf(opts.monitors, analysis, module);
          const lib = USER_LIBS[analysis];
          const libSize = lib ? stacks[analysis]?.[lib] ?? DEFAULT_LIB_SIZES[lib] : '';
          const usesCore = importsFrom(monitor, 'whamm_core');
          const first = stacks[analysis]?.whamm_core ?? CORE_STACKS[0];
          const candidates = usesCore ? CORE_STACKS.slice(Math.max(0, CORE_STACKS.indexOf(first))) : [''];
          let r;
          let coreStack;
          for (coreStack of candidates) {
            const dir = libsDir(coreStack, lib, libSize);
            const linked = [monitor];
            if (coreStack) linked.push(join(dir, 'whamm_core.wasm'));
            if (lib) linked.push(join(dir, `${lib}.wasm`));
            r = measure(['--env=TO_CONSOLE=true', '--expose=wizeng', ...modeFlags,
              `--monitors=${linked.join('+')}`, module]);
            // A trap means whamm_core's stack (or memory) is too small: retry with the next one.
            if (r.status !== 'trap') break;
            console.log(`${name} ${analysis}: traps with whamm_core_${coreStack}, retrying with a larger one`);
          }
          write([opts.target, 'wei', analysis, name, coreStack, lib ? `${lib}_${libSize}` : '', run, r.code, r.status,
            r.maxRss ?? '']);
          console.log(`${name} ${analysis} run ${run} (whamm_core_${coreStack || '-'}): ${r.status}, ${r.maxRss} KiB`);
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`Wrote ${opts.output}`);
}

new Command()
  .option('--target <target>', 'the wizeng build: x86-64 (Linux, --mode=jit) or jvm', 'x86-64')
  .option('--wizeng <path>', 'the wizeng binary (default: wizard/bin/wizeng.<target>)')
  .option('--modules <dir|file>', 'a .wasm module or a directory of them', join(ROOT, 'bench_input_data/wasmr3_modules'))
  .option('--monitors <dir>', 'the wei monitors, one subdirectory per analysis',
    join(ROOT, 'bench_output/modules_overhead/whamm-wei'))
  .option('--stacks <csv>', 'min_stacks.csv with the smallest whamm_core per analysis',
    join(ROOT, 'bench_output/mcu_analyses_memory/min_stacks.csv'))
  .option('--analyses <names>', 'space-separated analyses (default: every subdirectory of --monitors)')
  .option('--runs <n>', 'runs per module and analysis', (v) => Number.parseInt(v, 10), 1)
  .option('--timeout <seconds>', 'timeout per run', (v) => Number.parseInt(v, 10), 600)
  .option('--output <csv>', 'the CSV to write', join(ROOT, 'bench_output/memory_use/wizard_memory_use.csv'))
  .option('--no-baseline', 'skip the runs of wizeng without monitors')
  .action((opts) => {
    if (!['x86-64', 'jvm'].includes(opts.target)) throw new Error(`unknown target '${opts.target}'`);
    main(opts);
  })
  .parse();
