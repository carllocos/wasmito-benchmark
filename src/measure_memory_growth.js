/**
 * Measures how the linear memories of an instrumented MCU module grow while
 * the module runs, on a desktop (Node) with mocked MCU primitives.
 *
 * The MCU modules (bench_input_data/mcu_modules) run forever: `main` sets up
 * an interrupt handler with `subscribe_interrupt` and then loops, calling
 * `chip_delay` once per iteration. Here, every call to `chip_delay` is one
 * iteration of that loop: the mock fires the subscribed interrupt handler
 * once (as if the button was pressed), records the number of pages of every
 * linear memory at the checkpoints, and stops the module after the last
 * checkpoint by throwing.
 *
 * Linear memories and tables of the instrumented modules are not all
 * exported, so the module is first rewritten with wasm-tools (print, add an
 * export for every memory and table, parse) into a temporary file.
 *
 * Whamm modules import from whamm_core; pass its path with --whamm-core.
 * Other libraries they import (the user libraries of cache_sim and
 * loop_tracer) are passed with --lib <name>=<path>; their memories count
 * as well.
 *
 * Usage:
 *   node src/measure_memory_growth.js [--whamm-core <whamm_core.wasm>] [--lib <name>=<path>]...
 *     [--iterations <n>] [--framework <name>] [--variant <name>] [--analysis <name>]
 *     [--on-growth] [--max-bytes <n>] [--max-seconds <n>]
 *     <instrumented.wasm> >> out.csv
 *
 * Prints CSV rows (no header unless --header):
 *   framework,variant,analysis,module,iteration,total_pages,total_kib,pages_per_memory,status
 * With --on-growth, a row is also printed every time the total number of
 * pages changes (status 'grew'). With --max-bytes, the run stops as soon as
 * the memories take more than that many bytes (status 'exceeded'); with
 * --max-seconds, after that many seconds (status 'time limit').
 * where pages_per_memory lists the pages of every distinct memory, separated
 * by spaces (imported memories that are the same memory count once).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Command } from 'commander';

const PAGE = 65536;

/** Stops the module once the last checkpoint is reached. */
class Stop extends Error {}

/** 1, 2, 5, 10, 20, 50, ... up to and including `max`. */
function checkpoints(max) {
  const result = [0];
  for (let decade = 1; decade <= max; decade *= 10) {
    for (const step of [1, 2, 5]) {
      if (decade * step <= max) result.push(decade * step);
    }
  }
  if (result.at(-1) !== max) result.push(max);
  return result;
}

/**
 * The module with an export `__mem<i>` for every memory and `__table<i>` for
 * every table, compiled with wasm-tools.
 */
function withExports(path) {
  const wat = execFileSync('wasm-tools', ['print', path], {
    maxBuffer: 1 << 30,
  }).toString();
  const count = (kind) =>
    // '(memory (;0;) 1)', '(table $0 (;0;) 2 2 funcref)' or
    // '(import "m" "n" (memory (;0;) 0))'
    (wat.match(new RegExp(`\\(${kind}(?: \\$\\S+)? \\(;\\d+;\\)`, 'g')) ?? []).length;
  const exports = [];
  for (let i = 0; i < count('memory'); i++) {
    exports.push(`  (export "__mem${i}" (memory ${i}))`);
  }
  for (let i = 0; i < count('table'); i++) {
    exports.push(`  (export "__table${i}" (table ${i}))`);
  }
  const end = wat.lastIndexOf(')');
  const rewritten = `${wat.slice(0, end)}\n${exports.join('\n')}\n)\n`;

  const dir = mkdtempSync(join(tmpdir(), 'memgrowth-'));
  try {
    const watPath = join(dir, 'module.wat');
    const wasmPath = join(dir, 'module.wasm');
    writeFileSync(watPath, rewritten);
    execFileSync('wasm-tools', ['parse', watPath, '-o', wasmPath]);
    return readFileSync(wasmPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The pages of every distinct memory exported as `__mem<i>` by any of `instances`' exports. */
function memoryPages(...allExports) {
  const seen = new Set();
  const pages = [];
  for (const [name, value] of allExports.flatMap((e) => Object.entries(e))) {
    if (!name.startsWith('__mem') || !(value instanceof WebAssembly.Memory)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    pages.push(value.buffer.byteLength / PAGE);
  }
  return pages;
}

/**
 * The WASI functions that whamm_core imports, enough to run it as a library
 * (Node's WASI only supports modules started through `_start`): no
 * environment variables, no preopened directories, no other WASI functions (so the report on exit
 * cannot be written, which this measurement does not need) and stdout and
 * stderr discarded. `memory()` returns the memory of whamm_core.
 */
function wasiShim(memory, echo = () => false) {
  const ERRNO_BADF = 8;
  const ERRNO_NOTCAPABLE = 76;
  const ERRNO_NOSYS = 52;
  const view = () => new DataView(memory().buffer);
  const functions = {
    random_get: (ptr, len) => {
      crypto.getRandomValues(new Uint8Array(memory().buffer, ptr, len));
      return 0;
    },
    environ_sizes_get: (countPtr, sizePtr) => {
      view().setUint32(countPtr, 0, true);
      view().setUint32(sizePtr, 0, true);
      return 0;
    },
    environ_get: () => 0,
    fd_prestat_get: () => ERRNO_BADF,
    fd_prestat_dir_name: () => ERRNO_BADF,
    fd_write: (_fd, iovs, iovsLen, writtenPtr) => {
      let written = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view().getUint32(iovs + 8 * i, true);
        const len = view().getUint32(iovs + 8 * i + 4, true);
        if (echo()) process.stderr.write(new Uint8Array(memory().buffer, ptr, len));
        written += len;
      }
      view().setUint32(writtenPtr, written, true);
      return 0;
    },
    fd_close: () => 0,
    path_open: () => ERRNO_NOTCAPABLE,
    path_filestat_get: () => ERRNO_NOTCAPABLE,
    proc_exit: (code) => {
      throw new Error(`proc_exit(${code})`);
    },
  };
  // Builds with other Rust versions import other WASI functions (e.g.,
  // fd_fdstat_get); those report that they are not supported.
  return new Proxy(functions, {
    get: (target, name) => target[name] ?? (() => ERRNO_NOSYS),
  });
}

async function main(path, opts) {
  const iterations = Number(opts.iterations);
  const marks = new Set(checkpoints(iterations));
  const framework = opts.framework ?? '';
  const variant = opts.variant ?? '';
  const analysis = opts.analysis ?? '';
  const module = basename(path, '.wasm');
  const row = (iteration, pages, status) => {
    const total = pages.reduce((a, b) => a + b, 0);
    console.log(
      [framework, variant, analysis, module, iteration, total, total * 64, pages.join(' '), status].join(','),
    );
  };

  let instance;
  let handler; // table index of the subscribed interrupt handler
  let iteration = 0;
  let lastTotal;
  const started = Date.now();
  const maxBytes = opts.maxBytes === undefined ? Infinity : Number(opts.maxBytes);
  const maxMillis = opts.maxSeconds === undefined ? Infinity : Number(opts.maxSeconds) * 1000;
  const libs = [];
  const sample = () => memoryPages(instance.exports, ...libs.map((l) => l.exports));

  const env = {
    chip_pin_mode: () => {},
    chip_digital_write: () => {},
    subscribe_enable: () => {},
    subscribe_disable: () => {},
    subscribe_interrupt: (_pin, fn) => {
      handler = fn;
    },
    abort: () => {
      throw new Error('abort called');
    },
    chip_delay: () => {
      iteration += 1;
      if (handler !== undefined) {
        // The application's table is the first one.
        instance.exports.__table0.get(handler)(0, 0, 0, 0, 0);
      }
      const pages = sample();
      const total = pages.reduce((a, b) => a + b, 0);
      if (opts.onGrowth && total !== lastTotal) row(iteration, pages, 'grew');
      lastTotal = total;
      if (total * PAGE > maxBytes) {
        row(iteration, pages, 'exceeded');
        throw new Stop();
      }
      if (marks.has(iteration)) row(iteration, pages, 'ok');
      if (iteration >= iterations) throw new Stop();
      if (Date.now() - started > maxMillis) {
        row(iteration, pages, 'time limit');
        throw new Stop();
      }
    },
  };

  const imports = { env };
  let core;
  let echo = false;
  if (opts.whammCore !== undefined) {
    core = await WebAssembly.instantiate(readFileSync(opts.whammCore), {
      wasi_snapshot_preview1: wasiShim(() => core.instance.exports.memory, () => echo),
    });
    imports.whamm_core = core.instance.exports;
    libs.push(core.instance);
  }
  for (const spec of opts.lib) {
    const [name, libPath] = spec.split('=');
    const lib = await WebAssembly.instantiate(withExports(libPath), {
      wasi_snapshot_preview1: wasiShim(() => lib.instance.exports.__mem0),
    });
    imports[name] = lib.instance.exports;
    libs.push(lib.instance);
  }

  const bytes = withExports(path);
  ({ instance } = await WebAssembly.instantiate(bytes, imports));
  row(0, sample(), 'ok');
  lastTotal = sample().reduce((a, b) => a + b, 0);
  try {
    instance.exports.main();
    row(iteration, sample(), 'returned');
  } catch (e) {
    if (!(e instanceof Stop)) {
      row(iteration, sample(), `error: ${String(e.message).replaceAll(',', ';')}`);
      process.exitCode = 1;
    }
  }
  // The report of the Whamm script (wasm:report does not run, as the loop
  // of the MCU program never ends): print the given maps to stderr.
  if (opts.whammReport !== undefined && core !== undefined) {
    echo = true;
    for (const id of opts.whammReport.split(/[ ,]+/).filter((x) => x !== '')) {
      process.stderr.write(`# map ${id}\n`);
      core.instance.exports.print_map_as_csv(Number(id));
    }
    echo = false;
  }
}

const program = new Command()
  .argument('<instrumented-wasm>')
  .option('--whamm-core <path>', 'whamm_core.wasm to link Whamm modules with')
  .option('--iterations <n>', 'loop iterations (chip_delay calls) to run', '100000')
  .option('--lib <name=path>', 'a library the module imports as <name>, repeatable', (v, acc) => [...acc, v], [])
  .option('--whamm-report <ids>', "print these maps of the Whamm script to stderr at the end, e.g. '0 1'")
  .option('--framework <name>', 'framework column of the CSV')
  .option('--variant <name>', 'variant column of the CSV, e.g. the stack size')
  .option('--analysis <name>', 'analysis column of the CSV')
  .option('--on-growth', 'also print a row every time the memories grow')
  .option('--max-bytes <n>', 'stop once the memories take more bytes than this')
  .option('--max-seconds <n>', 'stop after this many seconds')
  .option('--header', 'print the CSV header first')
  .action(async (path, opts) => {
    if (opts.header) {
      console.log(
        'framework,variant,analysis,module,iteration,total_pages,total_kib,pages_per_memory,status',
      );
    }
    await main(path, opts);
  });

await program.parseAsync();
