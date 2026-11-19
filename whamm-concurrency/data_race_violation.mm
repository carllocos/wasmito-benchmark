// Whamm port of Wasmito's tool_examples/analyses/data_race_violation.ts
// (the multi-word violation analysis of the paper).
//
// Wasmito keeps every range [start, end) written by a store in a list and
// reports a store whose range is adjacent to an earlier one (an earlier range
// ends where this one starts, or starts where this one ends): the two writes
// may update one multi-word value non-atomically.
//
// Whamm has no lists and no loops, so the ranges are kept as two sets
// (maps to 1): the start and the end addresses of all earlier stores. A range
// [s, e) has an earlier neighbour iff some earlier range ends at s or starts
// at e, which is one lookup in each set. The state grows with the number of
// distinct store addresses, not with the number of executed stores.
//
// Report: (function index, instruction offset) of a store that has an
// adjacent earlier store -> how often that happened.
// The report variables are flushed by Whamm when the program ends.
use whamm_core;

report var races: map<(u32, u32), u32>;
var starts: map<u32, u32>;
var ends: map<u32, u32>;

wasm:opcode:*store*:before {
    if (ends[effective_addr] == 1 || starts[effective_addr + data_size] == 1) {
        races[(fid, pc)]++;
    }
    starts[effective_addr] = 1;
    ends[effective_addr + data_size] = 1;
}
