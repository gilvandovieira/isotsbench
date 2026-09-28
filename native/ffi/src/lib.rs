//! Plain C ABI over `isotsbench-core`, for runtime FFI (bun:ffi, Deno.dlopen).
//!
//! ```c
//! void    isotsbench_noop(void);
//! int32_t isotsbench_add_i32(int32_t a, int32_t b);
//! int32_t isotsbench_sum_i32(const int32_t *data, uint32_t len);
//! ```
//!
//! Unlike Node-API, a C function cannot inspect a JavaScript typed array,
//! so `sum_i32` takes the element pointer and length from the caller. The
//! memory is borrowed, never copied. The length is `uint32_t` because a
//! JS number maps to it on the fast path of both Bun and Deno FFI; `size_t`
//! needs a number in Bun but a BigInt in Deno to avoid a slow path
//! (see docs/methodology.md). Arrays are limited to 2^32 - 1 elements.

/// Does nothing; measures the bare call boundary.
#[no_mangle]
pub extern "C" fn isotsbench_noop() {
    isotsbench_core::noop();
}

/// Wrapping i32 addition.
#[no_mangle]
pub extern "C" fn isotsbench_add_i32(a: i32, b: i32) -> i32 {
    isotsbench_core::add_i32(a, b)
}

/// Wrapping sum of `len` i32 values starting at `data`.
///
/// # Safety
/// `data` must point to `len` readable, aligned `i32` values for the whole
/// call. It may be null only when `len` is 0 (runtimes may pass null for an
/// empty typed array); null with a non-zero length aborts.
#[no_mangle]
pub unsafe extern "C" fn isotsbench_sum_i32(data: *const i32, len: u32) -> i32 {
    let slice = if len == 0 {
        &[][..]
    } else {
        assert!(
            !data.is_null(),
            "isotsbench_sum_i32: null data with non-zero length"
        );
        std::slice::from_raw_parts(data, len as usize)
    };
    isotsbench_core::sum_i32(slice)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_wraps() {
        assert_eq!(isotsbench_add_i32(i32::MAX, 1), i32::MIN);
    }

    #[test]
    fn sum_accepts_null_when_empty() {
        assert_eq!(unsafe { isotsbench_sum_i32(std::ptr::null(), 0) }, 0);
    }

    #[test]
    fn sum_reads_len_elements() {
        let data = [1, 2, 3, i32::MAX, 10];
        assert_eq!(unsafe { isotsbench_sum_i32(data[1..].as_ptr(), 2) }, 5);
        assert_eq!(
            unsafe { isotsbench_sum_i32(data.as_ptr(), data.len() as u32) },
            isotsbench_core::sum_i32(&data)
        );
    }
}
