/**
 * The static and dynamic memory needs of every analysis of Wastrumentation,
 * Whamm and Wasmito on the four MCU modules of the concurrency bug
 * evaluation, against the RAM of an M5StickC running WARDuino, for the
 * paper: the MCU-specific concurrency analyses (category 'concurrency') and
 * the general analyses of the frameworks (category 'general'), to show how
 * well they can target existing MCU modules.
 *
 * Wastrumentation analyses and Whamm's whamm_core and user libraries (cache
 * for cache_sim, tracer for loop_tracer) use the smallest stack (or Virgil
 * heap) with which the modules behave as with the default one
 * (src/find_min_stacks_mcu.js, --stacks).
 *
 * Static: the size of the code (the instrumented module plus, for Whamm, the
 * libraries it links with) and the memories and pages declared, which the
 * VM allocates when it loads the module. The memory of whamm_core (which
 * Whamm modules import, sometimes twice) counts once, with the pages
 * whamm_core declares; the user libraries have a memory of their own.
 * WARDuino supports neither more than one memory nor imported memories or
 * functions from other modules (linking), which the needs_* columns flag.
 * Dynamic: the module is run with mocked MCU primitives
 * (src/measure_memory_growth.js), firing the interrupt handler once per
 * iteration of the main loop (which waits 1 s per iteration on the MCU,
 * hence minutes = iterations / 60), until the memories exceed the heap of
 * the M5StickC, --iterations or --max-seconds. Modules whose initial pages
 * already exceed the heap are not run.
 *
 * RAM budget (WARDuino's Arduino sketch for the M5StickC compiled with
 * arduino-cli, esp32 core 3.1.0-RC1; see src/mcu_memory_overview.js):
 * 327680 B of data RAM, of which the firmware takes 61988 B of static RAM;
 * WARDuino embeds the module in static RAM, which fits at most 62588 B of
 * it. The heap is 327680 - 61988 = 265692 B (259.5 KiB) with the code in
 * flash, and that minus the code with the code embedded. These are upper
 * bounds: task stacks, WARDuino's runtime structures and fragmentation are
 * not subtracted.
 *
 * Usage:
 *   node src/mcu_analyses_memory_table.js --stacks <min_stacks.csv>
 *     --heap <wasmito heap.csv> --output <csv> [--iterations <n>]
 *     [--max-seconds <n>] [--jobs <n>]
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import {
  MODULES,
  USER_LIBS,
  corePath,
  declaredPages,
  libPath,
  wastrPath,
  whammPath,
} from './find_min_stacks_mcu.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 65536;
const DATA_RAM = 327680;
const FIRMWARE_STATIC = 61988;
const STATIC_LIMIT = 124576;
const HEAP = DATA_RAM - FIRMWARE_STATIC;
const MAX_EMBEDDED = STATIC_LIMIT - FIRMWARE_STATIC;

/** Directory of the module in bench_input_data/mcu_modules. */
const MODULE_DIRS = {
  data_race: 'data_race',
  multi_variable: 'multi_variable',
  order_violation: 'toggle_led_bug',
  single_variable: 'single_variable',
};

/**
 * [category, analysis, label, Wastrumentation name, Whamm name, Wasmito name];
 * '' where the framework has no such analysis.
 */
const ANALYSES = [
  ['concurrency', 'order_violation', 'order violation', 'order_violation', 'order_violation', 'order-violation'],
  ['concurrency', 'variable_violation', 'variable-atomicity violation', 'variable_violation', 'variable_violation', 'variable-violation'],
  ['concurrency', 'data_race_violation', 'multi-word violation', 'data_race_violation', 'data_race_violation', 'data-race-violation'],
  ['general', 'basic_blocks', 'basic-block profiling', 'basic_blocks', 'basic_blocks', 'basic-block'],
  ['general', 'branches', 'branch profiling', 'branches', 'branches', 'branches'],
  ['general', 'call_graph', 'call graph', 'call_graph', 'call_graph', 'call-graph'],
  ['general', 'instr_coverage', 'instruction coverage', 'instr_coverage', 'instr_coverage', 'instr-coverage'],
  ['general', 'imix', 'instruction mix', 'imix', 'imix', 'imix'],
  ['general', 'mem_access', 'memory access tracing', 'mem_access', 'mem_access', 'mem_access'],
  ['general', 'icount', 'instruction count', '', 'icount', 'icount'],
  ['general', 'hotness', 'hotness', '', 'hotness', 'hotness'],
  ['general', 'cache_sim', 'cache simulation', '', 'cache_sim', 'cache_sim'],
  ['general', 'loop_tracer', 'loop tracing', '', 'loop_tracer', 'loop_tracer'],
  ['general', 'crypto', 'cryptominer detection', 'crypto', '', 'cryptomining'],
  ['general', 'denan', 'NaN detection (denan)', 'denan', '', 'denan'],
  ['general', 'forward', 'forward (all hooks)', 'forward', '', 'forward'],
  ['general', 'taint', 'taint analysis', 'taint', '', 'taint'],
  ['general', 'safe_heap', 'safe heap', 'safe_heap', '', 'safe-heap'],
];

/** The memories the module declares or imports: { pages, imported }. */
function memories(path) {
  const wat = execFileSync('wasm-tools', ['print', '--skeleton', path]).toString();
  return [...wat.matchAll(/^\s*\((import "[^"]*" "[^"]*" \()?memory(?: \$\S+)? \(;\d+;\)(?: i64)? (\d+)/gm)].map(
    (m) => ({ pages: Number(m[2]), imported: m[1] !== undefined }),
  );
}

/** The pages of the memory the module exports as "memory" (the app's). */
function appPages(path) {
  const wat = execFileSync('wasm-tools', ['print', '--skeleton', path]).toString();
  const index = Number(wat.match(/\(export "memory" \(memory (\d+)\)\)/)[1]);
  return memories(path)[index].pages;
}

function importsCore(path) {
  return execFileSync('wasm-tools', ['print', '--skeleton', path]).toString().includes('(import "whamm_core"');
}

/** Runs the module until its memories exceed the heap; { iteration, pages, status }. */
function run(path, opts, { core, lib } = {}) {
  const args = [
    '--no-warnings',
    join(ROOT, 'src/measure_memory_growth.js'),
    '--iterations',
    String(opts.iterations),
    '--max-bytes',
    String(HEAP),
    '--max-seconds',
    String(opts.maxSeconds),
  ];
  if (core !== undefined) args.push('--whamm-core', core);
  if (lib !== undefined) args.push('--lib', lib);
  args.push(path);
  return new Promise((resolve) => {
    execFile('node', args, { maxBuffer: 1 << 26 }, (_err, stdout, stderr) => {
      const last = stdout.trim().split('\n').at(-1)?.split(',') ?? [];
      // framework,variant,analysis,module,iteration,total_pages,total_kib,pages_per_memory,status
      resolve({
        iteration: Number(last[4]),
        pages: Number(last[5]),
        status: last[8] ?? `no output: ${stderr.split('\n')[0].replaceAll(',', ';')}`,
      });
    });
  });
}

async function pool(tasks, jobs) {
  let next = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < tasks.length) await tasks[next++]();
    }),
  );
}

const kib = (bytes) => (bytes / 1024).toFixed(1);
const yesNo = (b) => (b ? 'yes' : 'no');

/** The static columns of a row and whether it fits the heap at all. */
function staticColumns({ moduleBytes, libraryBytes, memoryCount, linking, app, initial, initialDefault }) {
  const code = moduleBytes + libraryBytes;
  const embeddable = code <= MAX_EMBEDDED;
  return {
    module_bytes: moduleBytes,
    library_bytes: libraryBytes,
    code_bytes: code,
    memories: memoryCount,
    needs_multi_memory: yesNo(memoryCount > 1),
    needs_linking: yesNo(linking),
    app_pages: app,
    analysis_pages: initial - app,
    initial_pages: initial,
    initial_kib: kib(initial * PAGE),
    initial_pages_default_stack: initialDefault,
    embeddable_in_warduino: yesNo(embeddable),
    deployable_warduino: yesNo(embeddable && initial * PAGE <= HEAP - code),
    heap_kib: kib(HEAP),
    free_initial_kib: kib(HEAP - initial * PAGE),
    deployable_static: yesNo(initial * PAGE <= HEAP),
  };
}

function dynamicColumns(dyn) {
  if (dyn === undefined) {
    return {
      iterations_run: '',
      pages_end: '',
      free_end_kib: '',
      out_of_heap: 'yes (at load)',
      iterations_until_out_of_heap: 0,
      minutes_until_out_of_heap: '0.0',
      run_status: 'not run: initial pages exceed the heap',
    };
  }
  const out = dyn.status === 'exceeded';
  return {
    iterations_run: dyn.iteration,
    pages_end: dyn.pages,
    free_end_kib: kib(HEAP - dyn.pages * PAGE),
    out_of_heap: yesNo(out),
    iterations_until_out_of_heap: out ? dyn.iteration : '',
    minutes_until_out_of_heap: out ? (dyn.iteration / 60).toFixed(1) : '',
    run_status: dyn.status.replaceAll(',', ';'),
  };
}

async function rows(opts) {
  const heapCsv = readFileSync(opts.heap, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
  const stacks = readFileSync(opts.stacks, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
  const stackOf = (framework, analysis, component) =>
    stacks.find((r) => r[0] === framework && r[1] === analysis && r[2] === component)?.[3];

  const result = [];
  const tasks = [];
  for (const [category, analysis, label, wastr, whamm, wasmito] of ANALYSES) {
    for (const module of MODULES) {
      const original = join(ROOT, 'bench_input_data/mcu_modules', MODULE_DIRS[module], 'wasm', `${module}.wasm`);
      const originalBytes = statSync(original).size;
      const base = { category, analysis, analysis_label: label, module, original_bytes: originalBytes };

      if (wastr !== '') {
        const stack = stackOf('Wastrumentation', wastr, 'analysis');
        const path = wastrPath(stack, wastr, module);
        const mems = memories(path);
        const initial = mems.reduce((a, m) => a + m.pages, 0);
        const row = {
          ...base,
          framework: 'Wastrumentation',
          framework_analysis: wastr,
          stack: stack,
          library_stack: '',
          ...staticColumns({
            moduleBytes: statSync(path).size,
            libraryBytes: 0,
            memoryCount: mems.length,
            linking: false,
            app: appPages(path),
            initial,
            initialDefault: memories(wastrPath('default', wastr, module)).reduce((a, m) => a + m.pages, 0),
          }),
        };
        result.push(row);
        tasks.push(async () => {
          Object.assign(row, dynamicColumns(initial * PAGE <= HEAP ? await run(path, opts) : undefined));
        });
      }

      if (whamm !== '') {
        const path = whammPath(whamm, module);
        const mems = memories(path);
        const own = mems.filter((m) => !m.imported);
        const core = importsCore(path);
        const coreStack = core ? stackOf('Whamm', whamm, 'whamm_core') : undefined;
        const lib = USER_LIBS[whamm];
        const libStack = lib === undefined ? undefined : stackOf('Whamm', whamm, lib);
        const ownPages = own.reduce((a, m) => a + m.pages, 0);
        const corePages = (s) => (core ? declaredPages(corePath(s)) : 0);
        const libPages = (s) => (lib === undefined ? 0 : declaredPages(libPath(lib, s)));
        const initial = ownPages + corePages(coreStack) + libPages(libStack);
        const libraryBytes =
          (core ? statSync(corePath(coreStack)).size : 0) + (lib === undefined ? 0 : statSync(libPath(lib, libStack)).size);
        const row = {
          ...base,
          framework: 'Whamm',
          framework_analysis: whamm,
          stack: coreStack ?? '',
          library_stack: libStack === undefined ? '' : `${lib}:${libStack}`,
          ...staticColumns({
            moduleBytes: statSync(path).size,
            libraryBytes,
            memoryCount: own.length + (core ? 1 : 0) + (lib === undefined ? 0 : 1),
            linking: core || lib !== undefined,
            app: appPages(path),
            initial,
            initialDefault: ownPages + corePages('default') + libPages('default'),
          }),
        };
        result.push(row);
        tasks.push(async () => {
          const env = {
            core: core ? corePath(coreStack) : undefined,
            lib: lib === undefined ? undefined : `${lib}=${libPath(lib, libStack)}`,
          };
          Object.assign(row, dynamicColumns(initial * PAGE <= HEAP ? await run(path, opts, env) : undefined));
        });
      }

      // Wasmito: the module is unchanged; the hooks take heap once, when they
      // are deployed, and the state of the analysis stays on the desktop.
      const h = heapCsv.find((r) => r[0] === wasmito && r[1] === `${module}.wasm`);
      const hooks = Number(h[4]);
      const app = appPages(original);
      const used = app * PAGE + hooks;
      result.push({
        ...base,
        framework: 'Wasmito',
        framework_analysis: wasmito,
        stack: '',
        library_stack: '',
        module_bytes: originalBytes,
        library_bytes: 0,
        code_bytes: originalBytes,
        memories: 1,
        needs_multi_memory: 'no',
        needs_linking: 'no',
        app_pages: app,
        analysis_pages: 0,
        initial_pages: app,
        initial_kib: kib(used),
        initial_pages_default_stack: app,
        embeddable_in_warduino: yesNo(originalBytes <= MAX_EMBEDDED),
        deployable_warduino: yesNo(originalBytes <= MAX_EMBEDDED && used <= HEAP - originalBytes),
        heap_kib: kib(HEAP),
        free_initial_kib: kib(HEAP - used),
        deployable_static: yesNo(used <= HEAP),
        iterations_run: '',
        pages_end: app,
        free_end_kib: kib(HEAP - used),
        out_of_heap: 'no',
        iterations_until_out_of_heap: '',
        minutes_until_out_of_heap: '',
        run_status: `hooks take ${hooks} B of heap; state on the desktop`,
      });
    }
  }
  await pool(tasks, Number(opts.jobs));
  return result;
}

const COLUMNS = [
  'category', 'framework', 'analysis', 'analysis_label', 'framework_analysis', 'module', 'stack', 'library_stack',
  'original_bytes', 'module_bytes', 'library_bytes', 'code_bytes', 'memories', 'needs_multi_memory',
  'needs_linking', 'app_pages', 'analysis_pages', 'initial_pages', 'initial_kib', 'initial_pages_default_stack',
  'embeddable_in_warduino', 'deployable_warduino', 'heap_kib', 'free_initial_kib', 'deployable_static',
  'iterations_run', 'pages_end', 'free_end_kib', 'out_of_heap', 'iterations_until_out_of_heap',
  'minutes_until_out_of_heap', 'run_status',
];

const program = new Command()
  .requiredOption('--stacks <csv>', 'the smallest stacks (src/find_min_stacks_mcu.js)')
  .requiredOption('--heap <csv>', "Wasmito's heap CSV (bench_output/heap_usage/heap.csv)")
  .requiredOption('--output <csv>', 'the CSV to write')
  .option('--iterations <n>', 'most iterations of the main loop to run', '1000000')
  .option('--max-seconds <n>', 'most seconds per run', '300')
  .option('--jobs <n>', 'runs at once', '8')
  .action(async (opts) => {
    const result = await rows(opts);
    mkdirSync(dirname(opts.output), { recursive: true });
    writeFileSync(
      opts.output,
      `${[COLUMNS.join(','), ...result.map((r) => COLUMNS.map((c) => r[c] ?? '').join(','))].join('\n')}\n`,
    );
    console.log(`Wrote ${result.length} rows to ${opts.output}`);
  });

program.parse();
