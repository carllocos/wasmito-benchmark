// Wastrumentation port of Wasmito's
// tool_examples/concurrency_guard/order_violation.ts.
//
// Reports reads of state that was never initialised:
// - a global.get of a global that was not set before and whose initial value
//   is not positive (reported once per global);
// - a load from a memory range that is not contained in a range written by
//   an earlier store (reported on every such load).
//
// Wasmito reads the initial values of the globals from the module. A
// Wastrumentation analysis cannot, but until a global is first set its value
// is its initial value, so the first global.get of a global that was never
// set sees that initial value.
//
// Hooks: global load store
use std::cell::RefCell;
use std::collections::HashSet;
use wastrumentation_rs_stdlib::*;

#[path = "../../common.rs"]
#[allow(dead_code)]
mod common;
use common::*;

#[derive(Default)]
struct State {
    initialised_globals: HashSet<i64>,
    // Globals whose initial value was already checked on a global.get.
    checked_initial_globals: HashSet<i64>,
    reported_globals: HashSet<i64>,
    initialised_memory: Vec<MemRange>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn is_positive(value: &WasmValue) -> bool {
    match value {
        WasmValue::I32(v) => *v > 0,
        WasmValue::I64(v) => *v > 0,
        WasmValue::F32(v) => *v > 0.0,
        WasmValue::F64(v) => *v > 0.0,
    }
}

fn is_range_initialised(range: MemRange, initialised_memory: &[MemRange]) -> bool {
    initialised_memory
        .iter()
        .any(|(start, end)| *start <= range.0 && range.1 <= *end)
}

advice! {
    global (value: WasmValue, index: GlobalIndex, op: GlobalOp, location: Location) {
        let index = index.value();
        STATE.with_borrow_mut(|state| match op {
            GlobalOp::Set => {
                state.initialised_globals.insert(index);
            }
            GlobalOp::Get => {
                if state.checked_initial_globals.insert(index) && is_positive(&value) {
                    state.initialised_globals.insert(index);
                }
                if state.initialised_globals.contains(&index) || state.reported_globals.contains(&index) {
                    return;
                }
                state.reported_globals.insert(index);
                println!(
                    "[Order Violation Detected] Global #{index} was accessed without initialisation at {}",
                    location_to_string(&location),
                );
            }
        });
        value
    }

    store (store_index: StoreIndex, value: WasmValue, offset: StoreOffset, operation: StoreOperation, location: Location) {
        let _ = location;
        let start = effective_address(store_index.value(), offset.value());
        let range = (start, start + bytes_stored(&operation));
        STATE.with_borrow_mut(|state| state.initialised_memory.push(range));

        operation.perform(&store_index, &value, &offset);
    }

    load (load_index: LoadIndex, offset: LoadOffset, operation: LoadOperation, location: Location) {
        let start = effective_address(load_index.value(), offset.value());
        let range = (start, start + bytes_loaded(&operation));
        let initialised =
            STATE.with_borrow(|state| is_range_initialised(range, &state.initialised_memory));
        if !initialised {
            println!(
                "[Order Violation Detected] instruction '{operation:?}' reads uninitialised memory range [{},{}] at {}",
                range.0,
                range.1,
                location_to_string(&location),
            );
        }

        operation.perform(&load_index, &offset)
    }
}
