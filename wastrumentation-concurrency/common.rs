// Helpers shared by the concurrency analyses (included with #[path]).
use wastrumentation_rs_stdlib::*;

/// A memory range [start, end) touched by a load or store.
pub type MemRange = (i64, i64);

/// The function index and byte offset of the instruction at `location`.
/// wastrumentation-rs-stdlib builds a Location with its two fields swapped,
/// so `instruction_index()` is the function index and `function_index()` is
/// the byte offset of the instruction (on the include_byte_offset branch).
pub fn location_to_string(location: &Location) -> String {
    let function_index = location.instruction_index();
    let byte_offset = location.function_index();
    format!("function {function_index} byte offset 0x{byte_offset:x}")
}

/// The effective address of a load or store: its address operand (an
/// unsigned i32) plus its static offset.
pub fn effective_address(index: i32, offset: i64) -> i64 {
    index as u32 as i64 + offset
}

/// The number of bytes a store writes to memory.
pub fn bytes_stored(operation: &StoreOperation) -> i64 {
    use StoreOperation::*;
    match operation {
        I32Store8 | I64Store8 => 1,
        I32Store16 | I64Store16 => 2,
        I32Store | F32Store | I64Store32 => 4,
        I64Store | F64Store => 8,
    }
}

/// The number of bytes a load reads from memory.
pub fn bytes_loaded(operation: &LoadOperation) -> i64 {
    use LoadOperation::*;
    match operation {
        I32Load8S | I32Load8U | I64Load8S | I64Load8U => 1,
        I32Load16S | I32Load16U | I64Load16S | I64Load16U => 2,
        I32Load | F32Load | I64Load32S | I64Load32U => 4,
        I64Load | F64Load => 8,
    }
}
