// Wastrumentation port of Wasmito's
// tool_examples/concurrency_guard/data_race_violation.ts.
//
// Before every store, the written memory range is compared with the ranges
// written by earlier stores. A store that writes right next to an earlier
// range (one ends where the other starts) is reported as a possible data
// race. Every distinct report is printed once.
//
// Hooks: store
use std::cell::RefCell;
use std::collections::HashSet;
use wastrumentation_rs_stdlib::*;

#[path = "../../common.rs"]
#[allow(dead_code)]
mod common;
use common::*;

#[derive(Default)]
struct State {
    ranges: Vec<MemRange>,
    already_logged: HashSet<String>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn neighbour_range(ranges: &[MemRange], range: MemRange) -> Option<MemRange> {
    let (mem_start, mem_end) = range;
    ranges
        .iter()
        .find(|(start, end)| *end == mem_start || *start == mem_end)
        .copied()
}

fn log_possible_data_race(
    state: &mut State,
    location: &Location,
    operation: &StoreOperation,
    range1: MemRange,
    range2: MemRange,
) {
    let r1 = if range1.0 < range2.0 { range1 } else { range2 };
    let r2 = if range1.0 > range2.0 { range1 } else { range2 };
    let log_str = format!(
        "[Data Race Detected] instruction '{operation:?}' causes possible data race in memory ranges [{},{}] and [{},{}] at {}",
        r1.0,
        r1.1,
        r2.0,
        r2.1,
        location_to_string(location),
    );
    if !state.already_logged.contains(&log_str) {
        println!("{log_str}");
        state.already_logged.insert(log_str);
    }
}

advice! {
    store (store_index: StoreIndex, value: WasmValue, offset: StoreOffset, operation: StoreOperation, location: Location) {
        let start = effective_address(store_index.value(), offset.value());
        let range = (start, start + bytes_stored(&operation));
        STATE.with_borrow_mut(|state| {
            if let Some(neighbour) = neighbour_range(&state.ranges, range) {
                log_possible_data_race(state, &location, &operation, range, neighbour);
            }
            state.ranges.push(range);
        });

        operation.perform(&store_index, &value, &offset);
    }
}
