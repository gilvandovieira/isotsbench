//! Plain C ABI over `isotsbench-core`, for runtime FFI (bun:ffi, Deno.dlopen).
//!
//! ```c
//! void    isotsbench_noop(void);
//! int32_t isotsbench_add_i32(int32_t a, int32_t b);
//! int32_t isotsbench_sum_i32(const int32_t *data, uint32_t len);
//! uint32_t isotsbench_string_len(const uint8_t *utf8, uint32_t len);
//! uint32_t isotsbench_bytes_len(const uint8_t *data, uint32_t len);
//! uint32_t isotsbench_checksum_bytes(const uint8_t *data, uint32_t len);
//!
//! double   isotsbench_return_f64(void);
//! uint32_t isotsbench_fill_string_ascii(uint8_t *out, uint32_t len);
//! uint32_t isotsbench_fill_string_utf8(uint8_t *out, uint32_t len);
//! uint32_t isotsbench_fill_bytes(uint8_t *out, uint32_t len);
//! uint32_t isotsbench_fill_rows_packed(uint8_t *out, uint32_t len);
//! ```
//!
//! Return path: a C function cannot create JS strings, buffers or objects.
//! The `fill_*` functions write exactly `len` bytes into memory the caller
//! owns (a JS `Uint8Array`) and return how much they produced. No pointer
//! to native memory is ever returned, so nothing JS holds can outlive it.
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

/// Borrows `len` bytes at `data`; null is accepted only when `len` is 0.
unsafe fn bytes<'a>(data: *const u8, len: u32) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        assert!(
            !data.is_null(),
            "isotsbench: null data with non-zero length"
        );
        std::slice::from_raw_parts(data, len as usize)
    }
}

/// UTF-8 byte length of a string the caller has already encoded as UTF-8.
/// A C function cannot read a JS string, so the caller encodes it (e.g.
/// `TextEncoder.encodeInto`) and passes the bytes.
///
/// # Safety
/// `utf8` must point to `len` readable bytes, or be null with `len` 0.
#[no_mangle]
pub unsafe extern "C" fn isotsbench_string_len(utf8: *const u8, len: u32) -> u32 {
    // Fits: the input length is itself a u32.
    isotsbench_core::string_len(bytes(utf8, len)) as u32
}

/// Length of a borrowed byte buffer.
///
/// # Safety
/// `data` must point to `len` readable bytes, or be null with `len` 0.
#[no_mangle]
pub unsafe extern "C" fn isotsbench_bytes_len(data: *const u8, len: u32) -> u32 {
    isotsbench_core::bytes_len(bytes(data, len)) as u32
}

/// 32-bit FNV-1a hash of a borrowed byte buffer.
///
/// # Safety
/// `data` must point to `len` readable bytes, or be null with `len` 0.
#[no_mangle]
pub unsafe extern "C" fn isotsbench_checksum_bytes(data: *const u8, len: u32) -> u32 {
    isotsbench_core::checksum_bytes(bytes(data, len))
}

/// Mutable view of `len` caller-owned bytes; null is accepted only when `len` is 0.
unsafe fn bytes_mut<'a>(out: *mut u8, len: u32) -> &'a mut [u8] {
    if len == 0 {
        &mut []
    } else {
        assert!(
            !out.is_null(),
            "isotsbench: null output with non-zero length"
        );
        std::slice::from_raw_parts_mut(out, len as usize)
    }
}

#[no_mangle]
pub extern "C" fn isotsbench_return_f64() -> f64 {
    isotsbench_core::return_f64()
}

/// Writes `len` bytes of ASCII text into `out`; returns `len`.
///
/// # Safety
/// `out` must point to `len` writable bytes, or be null with `len` 0.
#[no_mangle]
pub unsafe extern "C" fn isotsbench_fill_string_ascii(out: *mut u8, len: u32) -> u32 {
    isotsbench_core::fill_ascii(bytes_mut(out, len));
    len
}

/// Writes `len` bytes of valid UTF-8 into `out`; returns `len`.
///
/// # Safety
/// `out` must point to `len` writable bytes, or be null with `len` 0.
#[no_mangle]
pub unsafe extern "C" fn isotsbench_fill_string_utf8(out: *mut u8, len: u32) -> u32 {
    isotsbench_core::fill_utf8(bytes_mut(out, len));
    len
}

/// Writes `len` deterministic bytes into `out`; returns `len`.
///
/// # Safety
/// `out` must point to `len` writable bytes, or be null with `len` 0.
#[no_mangle]
pub unsafe extern "C" fn isotsbench_fill_bytes(out: *mut u8, len: u32) -> u32 {
    isotsbench_core::fill_bytes(bytes_mut(out, len));
    len
}

/// Writes `len / 32` packed rows into `out`; returns the row count.
/// `len` must be a multiple of 32; otherwise this aborts.
///
/// # Safety
/// `out` must point to `len` writable bytes, or be null with `len` 0.
#[no_mangle]
pub unsafe extern "C" fn isotsbench_fill_rows_packed(out: *mut u8, len: u32) -> u32 {
    // Fits: at most len / 32 rows, and len is a u32.
    isotsbench_core::fill_rows_packed(bytes_mut(out, len)) as u32
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
    fn return_functions() {
        assert_eq!(isotsbench_return_f64(), 1.5);
        let mut out = [0u8; 12];
        assert_eq!(
            unsafe { isotsbench_fill_string_utf8(out.as_mut_ptr(), 12) },
            12
        );
        assert_eq!(std::str::from_utf8(&out).unwrap(), "aé€😀xx");
        assert_eq!(
            unsafe { isotsbench_fill_string_ascii(std::ptr::null_mut(), 0) },
            0
        );
        let mut rows = [0u8; 64];
        assert_eq!(
            unsafe { isotsbench_fill_rows_packed(rows.as_mut_ptr(), 64) },
            2
        );
    }

    #[test]
    fn byte_functions() {
        let data = b"xxfoobar";
        assert_eq!(unsafe { isotsbench_string_len(std::ptr::null(), 0) }, 0);
        assert_eq!(unsafe { isotsbench_bytes_len(data[2..].as_ptr(), 6) }, 6);
        assert_eq!(
            unsafe { isotsbench_checksum_bytes(data[2..].as_ptr(), 6) },
            0xbf9c_f968
        );
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
