/**
 * Overview of the memory that every analysis needs on the four MCU modules
 * of the concurrency bug evaluation, per framework and stack size, and how
 * much of the RAM of an M5StickC running WARDuino would remain.
 *
 * Inputs:
 *   - the instrumented modules (their memories, pages and size, read with
 *     wasm-tools):
 *       bench_output/wastrumentation_stack/<size>/wastrumentation/<analysis>/<module>.wasm
 *       whamm_mcu_modules/<analysis>/<module>.wasm, linked with
 *       bench_output/whamm_core_stack/whamm_core_<size>.wasm
 *   - --growth: the CSV of measure_memory_growth_mcu.sh (pages while running)
 *   - --heap: the heap CSV of Wasmito (bench_output/heap_usage/heap.csv), for
 *     the heap that deploying Wasmito's hooks takes
 *
 * The RAM budget comes from compiling WARDuino's Arduino sketch for the
 * M5StickC (esp32:esp32:m5stack_stickc, arduino-cli, esp32 core 3.1.0-RC1);
 * see the constants below. Every free-RAM figure is an upper bound: it does
 * not subtract the stacks of the FreeRTOS tasks, WARDuino's own runtime
 * structures (functions, globals, tables, ...) or heap fragmentation.
 *
 * Usage:
 *   node src/mcu_memory_overview.js --growth <csv> --heap <csv> --output <dir>
 *
 * Writes:
 *   <dir>/mcu_memory_overview.csv  one row per framework, variant, analysis and module
 *   <dir>/mcu_memory_overview.md   per framework, variant and analysis, the
 *                                  ranges over the four modules
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIB = 1024;
const PAGE = 64 * KIB;

/**
 * Static RAM (.data + .bss) of the WARDuino firmware for the M5StickC
 * without the embedded module: arduino-cli reports 119716 bytes of global
 * variables with a 57728-byte module (and 63620 with a 1625-byte one).
 */
const FIRMWARE_STATIC = 61988;
/**
 * The most static RAM the linker can place: a 65124-byte module overflows
 * region dram0_0_seg by 2536 bytes, an 85044-byte one by 22456 bytes, so
 * 61988 + 65124 - 2536 = 124576. WARDuino embeds the module as a non-const
 * array, i.e. in static RAM, so the module can be at most
 * STATIC_LIMIT - FIRMWARE_STATIC = 62588 bytes.
 */
const STATIC_LIMIT = 124576;
/**
 * The data RAM that arduino-cli reports for static RAM and the heap
 * together ("Maximum is 327680 bytes"); the heap gets what static RAM
 * leaves.
 */
const DATA_RAM = 327680;
/** The modules of the concurrency bug evaluation. */
const MCU_MODULES = ['data_race', 'multi_variable', 'order_violation', 'single_variable'];

/** Lines of `wasm-tools print --skeleton` that declare or import a memory. */
function memories(path) {
  const wat = execFileSync('wasm-tools', ['print', '--skeleton', path], {
    maxBuffer: 1 << 30,
  }).toString();
  const result = [];
  for (const line of wat.split('\n')) {
    const m = line.match(/\(memory(?: \$\S+)? \(;(\d+);\)(?: i64)? (\d+)/);
    if (!m || !/^\s*\((memory|import )/.test(line)) continue;
    const imported = /^\s*\(import /.test(line);
    const from = imported ? line.match(/^\s*\(import "([^"]*)"/)[1] : undefined;
    result.push({ index: Number(m[1]), pages: Number(m[2]), imported, from });
  }
  return result;
}

const bytesOf = (path) => statSync(path).size;
const list = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

/** The static description of one instrumented module. */
function describe(framework, variant, analysis, module, path, core) {
  const mems = memories(path);
  const own = mems.filter((m) => !m.imported);
  const imported = mems.filter((m) => m.imported);
  // Imports of the same library memory are one memory; its pages are the
  // ones the library declares.
  const importedFrom = [...new Set(imported.map((m) => m.from))];
  const corePages = core ? memories(core).filter((m) => !m.imported)[0].pages : 0;
  const appPages = own.length > 0 ? own[0].pages : 0;
  return {
    framework,
    variant,
    analysis,
    module,
    module_bytes: bytesOf(path),
    library_bytes: core ? bytesOf(core) : 0,
    memories_declared: own.length,
    memories_imported: imported.length,
    distinct_memories: own.length + importedFrom.length,
    app_pages: appPages,
    added_pages: own.slice(1).reduce((a, m) => a + m.pages, 0) + (core ? corePages : 0),
    start_pages: own.reduce((a, m) => a + m.pages, 0) + (core ? corePages : 0),
  };
}

function readCsv(path) {
  const [header, ...lines] = readFileSync(path, 'utf8').trim().split('\n');
  const cols = header.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
}

/** Adds the RAM budget of `row`, with `heapBytes` of other heap use. */
function budget(row, startBytes, endBytes) {
  const code = row.module_bytes + row.library_bytes;
  const embeds = FIRMWARE_STATIC + code <= STATIC_LIMIT;
  // WARDuino as is: the module (and library) in static RAM.
  const heapRam = DATA_RAM - FIRMWARE_STATIC - code;
  // Best case: the code in flash, all data RAM left for the heap.
  const heapFlash = DATA_RAM - FIRMWARE_STATIC;
  const kib = (b) => Math.round(b / KIB);
  const verdict = (heap, staticOk) => {
    if (!staticOk) return 'no: module does not fit in static RAM';
    if (startBytes > heap) return 'no: initial pages exceed RAM';
    if (endBytes > heap) return 'no: state outgrows RAM while running';
    return 'yes (upper bound)';
  };
  return {
    ...row,
    code_bytes: code,
    embeds_in_static_ram: embeds,
    start_kib: kib(startBytes),
    end_kib: kib(endBytes),
    free_start_kib_code_in_ram: kib(heapRam - startBytes),
    free_end_kib_code_in_ram: kib(heapRam - endBytes),
    free_start_kib_code_in_flash: kib(heapFlash - startBytes),
    free_end_kib_code_in_flash: kib(heapFlash - endBytes),
    fits_code_in_ram: verdict(heapRam, embeds),
    fits_code_in_flash: verdict(heapFlash, true),
  };
}

function overview(opts) {
  const growth = readCsv(opts.growth);
  const iterations = Math.max(...growth.map((r) => Number(r.iteration)));
  /** Pages at the start and at the end of the run, and its status. */
  const run = (framework, variant, analysis, module) => {
    const rows = growth.filter(
      (r) =>
        r.framework === framework && r.variant === variant && r.analysis === analysis && r.module === module,
    );
    if (rows.length === 0) return { end_pages: '', status: 'not run' };
    const last = rows.at(-1);
    return {
      end_pages: Number(last.total_pages),
      iterations: Number(last.iteration),
      status: last.status,
    };
  };

  const rows = [];
  // Wastrumentation, per stack size.
  const wastrDir = join(ROOT, 'bench_output/wastrumentation_stack');
  for (const variant of list(wastrDir)) {
    const dir = join(wastrDir, variant, 'wastrumentation');
    for (const analysis of list(dir)) {
      for (const module of MCU_MODULES) {
        const path = join(dir, analysis, `${module}.wasm`);
        if (!existsSync(path)) continue;
        const row = describe('wastrumentation', variant, analysis, module, path);
        rows.push({ ...row, ...run('wastrumentation', variant, analysis, module) });
      }
    }
  }
  // Whamm, per stack size of whamm_core.
  const whammDir = join(ROOT, 'whamm_mcu_modules');
  const coreDir = join(ROOT, 'bench_output/whamm_core_stack');
  for (const file of list(coreDir).filter((f) => /^whamm_core_.*\.wasm$/.test(f))) {
    const variant = basename(file, '.wasm').replace('whamm_core_', '');
    for (const analysis of list(whammDir)) {
      for (const module of MCU_MODULES) {
        const path = join(whammDir, analysis, `${module}.wasm`);
        if (!existsSync(path)) continue;
        const row = describe('whamm', variant, analysis, module, path, join(coreDir, file));
        rows.push({ ...row, ...run('whamm', variant, analysis, module) });
      }
    }
  }

  const result = rows.map((row) =>
    budget(
      row,
      row.start_pages * PAGE,
      (row.end_pages === '' ? row.start_pages : row.end_pages) * PAGE,
    ),
  );

  // Wasmito: the module is unchanged (one page) and the hooks take heap.
  for (const h of readCsv(opts.heap)) {
    const module = h.wasm.replace(/\.wasm$/, '');
    if (!MCU_MODULES.includes(module) || h.analysis === 'no-analysis') continue;
    const original = join(
      ROOT,
      'bench_input_data/mcu_modules',
      module === 'order_violation' ? 'toggle_led_bug' : module,
      'wasm',
      `${module}.wasm`,
    );
    const pages = memories(original)[0].pages;
    const hooks = Number(h.deploy_delta);
    const row = {
      framework: 'wasmito',
      variant: '-',
      analysis: h.analysis,
      module,
      module_bytes: bytesOf(original),
      library_bytes: 0,
      memories_declared: 1,
      memories_imported: 0,
      distinct_memories: 1,
      app_pages: pages,
      added_pages: 0,
      start_pages: pages,
      end_pages: pages,
      iterations: '',
      status: 'hooks only; state on the desktop',
    };
    // The hooks are allocated once, when they are deployed.
    result.push(budget(row, pages * PAGE + hooks, pages * PAGE + hooks));
  }
  return { result, iterations };
}

/** min-max of the values, or the value when they are all equal. */
function range(values) {
  const nums = values.filter((v) => v !== '' && v !== undefined).map(Number);
  if (nums.length === 0) return '';
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
}

function summarise(result, iterations) {
  const groups = new Map();
  for (const r of result) {
    const key = `${r.framework}|${r.variant}|${r.analysis}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const fits = (rows, column) => {
    const counts = {};
    for (const r of rows) counts[r[column]] = (counts[r[column]] ?? 0) + 1;
    return Object.entries(counts)
      .map(([k, n]) => `${n}× ${k}`)
      .join('; ');
  };
  const lines = [
    `Ranges over the four MCU modules. Pages are 64 KiB; "end" is after ${iterations} iterations of the main loop (about ${Math.round(iterations / 3600)} h at 1 s per iteration on the MCU).`,
    `RAM budget of WARDuino on the M5StickC (compiled with arduino-cli): ${DATA_RAM} B of data RAM, of which the firmware takes ${FIRMWARE_STATIC} B of static RAM; an embedded module can be at most ${STATIC_LIMIT - FIRMWARE_STATIC} B. Free RAM is an upper bound (no task stacks, VM structures or fragmentation).`,
    '',
    '| Framework | Stack | Analysis | Code (KB) | Memories (own + imported) | Distinct memories | Added pages | Pages at start | Pages at end | Free KiB, code in RAM (start / end) | Free KiB, code in flash (start / end) | Fits, code in RAM | Fits, code in flash |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const rows of groups.values()) {
    const r = rows[0];
    lines.push(
      `| ${r.framework} | ${r.variant} | ${r.analysis} | ${range(rows.map((x) => (x.code_bytes / 1000).toFixed(1)))} | ${range(rows.map((x) => x.memories_declared))} + ${range(rows.map((x) => x.memories_imported))} | ${range(rows.map((x) => x.distinct_memories))} | ${range(rows.map((x) => x.added_pages))} | ${range(rows.map((x) => x.start_pages))} | ${range(rows.map((x) => x.end_pages))} | ${range(rows.map((x) => x.free_start_kib_code_in_ram))} / ${range(rows.map((x) => x.free_end_kib_code_in_ram))} | ${range(rows.map((x) => x.free_start_kib_code_in_flash))} / ${range(rows.map((x) => x.free_end_kib_code_in_flash))} | ${fits(rows, 'fits_code_in_ram')} | ${fits(rows, 'fits_code_in_flash')} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const program = new Command()
  .requiredOption('--growth <csv>', 'CSV of measure_memory_growth_mcu.sh')
  .requiredOption('--heap <csv>', "Wasmito's heap CSV (bench_output/heap_usage/heap.csv)")
  .requiredOption('--output <dir>', 'directory to write the overview to')
  .action((opts) => {
    const { result, iterations } = overview(opts);
    mkdirSync(opts.output, { recursive: true });
    const cols = Object.keys(result[0]);
    const csv = [cols.join(','), ...result.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n');
    writeFileSync(join(opts.output, 'mcu_memory_overview.csv'), `${csv}\n`);
    writeFileSync(join(opts.output, 'mcu_memory_overview.md'), summarise(result, iterations));
    console.log(`Wrote ${result.length} rows to ${opts.output}`);
  });

program.parse();
