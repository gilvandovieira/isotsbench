//! WebAssembly ABI over the shared Rust core. The caller copies i32 input
//! into linear memory before calling `isotsbench_sum_i32`.

#[no_mangle]
pub extern "C" fn isotsbench_noop() {
    isotsbench_core::noop();
}

#[no_mangle]
pub extern "C" fn isotsbench_add_i32(a: i32, b: i32) -> i32 {
    isotsbench_core::add_i32(a, b)
}

/// Reserves one zeroed input buffer for a benchmark case. It lives until the
/// WebAssembly instance is dropped; allocation is outside timed calls.
#[no_mangle]
pub extern "C" fn isotsbench_alloc_i32(len: u32) -> *mut i32 {
    Box::into_raw(vec![0i32; len as usize].into_boxed_slice()) as *mut i32
}

/// Sums `len` i32 elements already copied into linear memory.
///
/// # Safety
/// `data` must point to `len` readable, aligned i32 values in this module's
/// linear memory, or `len` must be zero.
#[no_mangle]
pub unsafe extern "C" fn isotsbench_sum_i32(data: *const i32, len: u32) -> i32 {
    let input = if len == 0 {
        &[][..]
    } else {
        assert!(!data.is_null(), "isotsbench_sum_i32: null input");
        std::slice::from_raw_parts(data, len as usize)
    };
    isotsbench_core::sum_i32(input)
}
