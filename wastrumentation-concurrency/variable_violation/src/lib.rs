// Wastrumentation port of Wasmito's
// tool_examples/concurrency_guard/variable_violation.ts.
//
// Every global.get and load is recorded. A global.set or store inside an
// interrupt handler that writes a global or memory range read earlier is
// reported as a single-variable violation. Every distinct report is printed
// once.
//
// Wasmito learns the interrupt handlers from WARDuino at run time; a
// Wastrumentation analysis has no such notion. List the function indices of
// the handlers in HANDLER_FUNCTIONS. If it is empty, writes in every function
// are checked.
//
// Hooks: global load store
use std::cell::RefCell;
use std::collections::HashSet;
use wastrumentation_rs_stdlib::*;

#[path = "../../common.rs"]
#[allow(dead_code)]
mod common;
use common::*;

/// Function indices of the interrupt handlers. Empty: every function.
const HANDLER_FUNCTIONS: &[i64] = &[];

#[derive(Default)]
struct State {
    // (global index, location of the global.get)
    globals_get: Vec<(i64, Location)>,
    // (location of the load, read range)
    memory_read: Vec<(Location, MemRange)>,
    already_reported: HashSet<String>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn in_handler(location: &Location) -> bool {
    // See location_to_string in common.rs: instruction_index() is the
    // function index.
    HANDLER_FUNCTIONS.is_empty() || HANDLER_FUNCTIONS.contains(&location.instruction_index())
}

fn log_global_violation(state: &mut State, index: i64, read: &Location, write: &Location) {
    if !state.already_reported.insert(format!("{index},{index}")) {
        return;
    }
    println!(
        "[Variable Violation Detected] Global #{index}\n\tread at {}\n\twritten at {}",
        location_to_string(read),
        location_to_string(write),
    );
}

fn log_memory_violation(state: &mut State, write: &Location, write_range: MemRange, read: &Location, read_range: MemRange) {
    let key = format!("{},{},{},{}", read_range.0, read_range.1, write_range.0, write_range.1);
    if !state.already_reported.insert(key) {
        return;
    }
    println!(
        "[Single Variable Violation Detected] Write at memory location {} range [{},{}] overwrites read location {} range [{},{}]",
        location_to_string(write),
        write_range.0,
        write_range.1,
        location_to_string(read),
        read_range.0,
        read_range.1,
    );
}

fn check_global_violation(state: &mut State, index: i64, write: &Location) {
    let reads: Vec<Location> = state
        .globals_get
        .iter()
        .filter(|(g, _)| *g == index)
        .map(|(_, l)| *l)
        .collect();
    for read in reads {
        log_global_violation(state, index, &read, write);
    }
}

fn check_memory_violation(state: &mut State, write: &Location, (start_write, end_write): MemRange) {
    let reads: Vec<(Location, MemRange)> = state
        .memory_read
        .iter()
        .filter(|(_, (start_read, _))| start_write <= *start_read && *start_read <= end_write)
        .copied()
        .collect();
    for (read, read_range) in reads {
        log_memory_violation(state, write, (start_write, end_write), &read, read_range);
    }
}

advice! {
    global (value: WasmValue, index: GlobalIndex, op: GlobalOp, location: Location) {
        let index = index.value();
        STATE.with_borrow_mut(|state| match op {
            GlobalOp::Get => state.globals_get.push((index, location)),
            GlobalOp::Set => {
                if in_handler(&location) {
                    check_global_violation(state, index, &location);
                }
            }
        });
        value
    }

    load (load_index: LoadIndex, offset: LoadOffset, operation: LoadOperation, location: Location) {
        let start = effective_address(load_index.value(), offset.value());
        let range = (start, start + bytes_loaded(&operation));
        STATE.with_borrow_mut(|state| state.memory_read.push((location, range)));

        operation.perform(&load_index, &offset)
    }

    store (store_index: StoreIndex, value: WasmValue, offset: StoreOffset, operation: StoreOperation, location: Location) {
        if in_handler(&location) {
            let start = effective_address(store_index.value(), offset.value());
            let range = (start, start + bytes_stored(&operation));
            STATE.with_borrow_mut(|state| check_memory_violation(state, &location, range));
        }

        operation.perform(&store_index, &value, &offset);
    }
}
