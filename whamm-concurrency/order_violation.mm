// Whamm port of Wasmito's tool_examples/analyses/order_violation.ts.
//
// Reports reads of state that was never initialised:
// - a global.get of a global that was not set before (once per global);
// - a load from memory that was not written by an earlier store.
//
// Wasmito also skips globals whose initial value is positive. Whamm cannot
// read the value of a global.get (res0 is not bound for it), so this port
// also reports globals that are only read, such as constants. That state is
// bounded by the number of globals.
//
// Wasmito keeps every range written by a store in a list and checks that a
// load's range lies within one of them. Whamm has no lists and no loops, so
// every byte written by a store is marked in a map (byte address -> 1) and a
// load is initialised iff all the bytes it reads are marked. This is the
// same check except that the bytes may come from different stores. The marks
// are unrolled for the access sizes of the MCU modules (1, 2, 4 and 8
// bytes). The state grows with the number of distinct bytes written, not
// with the number of executed stores.
//
// Reports: global index -> 1 for globals read uninitialised, and
// (function index, instruction offset) of a load of uninitialised memory ->
// how often it executed.
// The report variables are flushed by Whamm when the program ends.
use whamm_core;

report var uninit_globals: map<u32, u32>;
report var uninit_loads: map<(u32, u32), u32>;
var set_globals: map<u32, u32>;
var written: map<u32, u32>;
var initialised: bool;

wasm:opcode:global.set:before {
    set_globals[imm0] = 1;
}

wasm:opcode:global.get:before {
    if (set_globals[imm0] == 0) {
        uninit_globals[imm0] = 1;
    }
}

wasm:opcode:*store*:before {
    written[effective_addr] = 1;
    if (data_size > 1) {
        written[effective_addr + 1] = 1;
    }
    if (data_size > 2) {
        written[effective_addr + 2] = 1;
        written[effective_addr + 3] = 1;
    }
    if (data_size > 4) {
        written[effective_addr + 4] = 1;
        written[effective_addr + 5] = 1;
        written[effective_addr + 6] = 1;
        written[effective_addr + 7] = 1;
    }
}

wasm:opcode:*load*:before {
    initialised = written[effective_addr] == 1;
    if (data_size > 1) {
        initialised = initialised && written[effective_addr + 1] == 1;
    }
    if (data_size > 2) {
        initialised = initialised && written[effective_addr + 2] == 1 && written[effective_addr + 3] == 1;
    }
    if (data_size > 4) {
        initialised = initialised && written[effective_addr + 4] == 1 && written[effective_addr + 5] == 1
            && written[effective_addr + 6] == 1 && written[effective_addr + 7] == 1;
    }
    if (!initialised) {
        uninit_loads[(fid, pc)]++;
    }
}
