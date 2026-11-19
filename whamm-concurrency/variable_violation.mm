// Whamm port of Wasmito's tool_examples/analyses/variable_violation.ts
// (the variable-atomicity violation analysis of the paper).
//
// Every global.get and load is recorded. A global.set of a global read
// earlier, or a store whose range [start, start + size] contains the start
// address of an earlier load, is reported: an interrupt handler may overwrite
// a variable that the main program read but did not yet act upon.
//
// Wasmito keeps every read in a list and checks writes only inside interrupt
// handlers, which it learns from WARDuino at run time. Whamm has no lists and
// no loops and does not know the interrupt handlers, so:
// - the reads are kept as sets (maps to 1) of global indices and of start
//   addresses of loads, and a store checks every address of its range, which
//   is unrolled for the access sizes of the MCU modules (1, 2, 4 and 8 bytes);
// - writes in every function are checked (as in the Wastrumentation port
//   with an empty HANDLER_FUNCTIONS).
// The state grows with the number of distinct globals and addresses read,
// not with the number of executed reads.
//
// Reports: global index -> how often a read global was written, and
// (function index, instruction offset) of a store that overwrote read memory
// -> how often that happened.
// The report variables are flushed by Whamm when the program ends.
use whamm_core;

report var global_violations: map<u32, u32>;
report var memory_violations: map<(u32, u32), u32>;
var read_globals: map<u32, u32>;
var read_starts: map<u32, u32>;
var overwrites: bool;

wasm:opcode:global.get:before {
    read_globals[imm0] = 1;
}

wasm:opcode:*load*:before {
    read_starts[effective_addr] = 1;
}

wasm:opcode:global.set:before {
    if (read_globals[imm0] == 1) {
        global_violations[imm0]++;
    }
}

wasm:opcode:*store*:before {
    overwrites = read_starts[effective_addr] == 1 || read_starts[effective_addr + 1] == 1;
    if (data_size > 1) {
        overwrites = overwrites || read_starts[effective_addr + 2] == 1;
    }
    if (data_size > 2) {
        overwrites = overwrites || read_starts[effective_addr + 3] == 1 || read_starts[effective_addr + 4] == 1;
    }
    if (data_size > 4) {
        overwrites = overwrites || read_starts[effective_addr + 5] == 1 || read_starts[effective_addr + 6] == 1
            || read_starts[effective_addr + 7] == 1 || read_starts[effective_addr + 8] == 1;
    }
    if (overwrites) {
        memory_violations[(fid, pc)]++;
    }
}
