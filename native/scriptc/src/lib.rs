//! Static archive for scriptc's native FFI (`scriptc build --ffi`).
//!
//! It contains the shared C ABI unchanged — the same source file as
//! `native/ffi`, compiled into this archive rather than linked from the
//! crate, so the `.so` used by Bun and Deno stays byte-for-byte identical —
//! plus thin adapters for one ABI difference:
//!
//! scriptc passes `string` and `bytes` parameters as the pair
//! `(const uint8_t *, size_t)`, borrowed for the call and read-only. The
//! shared ABI takes `uint32_t` lengths (a Bun/Deno fast-path decision, see
//! docs/methodology.md). The adapters convert the length and call the shared
//! functions; a length above `uint32_t` aborts rather than truncating.
//!
//! ```c
//! int32_t  isotsbench_scriptc_sum_i32(const uint8_t *bytes, size_t byte_len);
//! uint32_t isotsbench_scriptc_string_len(const uint8_t *utf8, size_t len);
//! uint32_t isotsbench_scriptc_bytes_len(const uint8_t *data, size_t len);
//! uint32_t isotsbench_scriptc_checksum_bytes(const uint8_t *data, size_t len);
//! ```
//!
//! scalar functions (`isotsbench_noop`, `isotsbench_add_i32`,
//! `isotsbench_return_f64`) are bound directly to the shared symbols.

#[path = "../../ffi/src/lib.rs"]
pub mod c_abi;

fn len32(len: usize) -> u32 {
    u32::try_from(len).expect("isotsbench: span longer than uint32_t")
}

/// `sum_i32` over an `Int32Array` passed as a byte view of the same memory:
/// scriptc's `bytes` class only accepts `Uint8Array`.
///
/// # Safety
/// `bytes` must point to `byte_len` readable bytes (null only when 0), aligned
/// for `i32`, with `byte_len` a multiple of 4; otherwise this aborts.
#[no_mangle]
pub unsafe extern "C" fn isotsbench_scriptc_sum_i32(bytes: *const u8, byte_len: usize) -> i32 {
    assert!(
        byte_len.is_multiple_of(4),
        "isotsbench: sum_i32 byte length is not a multiple of 4"
    );
    assert!(
        (bytes as usize).is_multiple_of(4),
        "isotsbench: sum_i32 data is not aligned for i32"
    );
    c_abi::isotsbench_sum_i32(bytes.cast(), len32(byte_len / 4))
}

/// # Safety
/// `utf8` must point to `len` readable bytes, or be null with `len` 0.
#[no_mangle]
pub unsafe extern "C" fn isotsbench_scriptc_string_len(utf8: *const u8, len: usize) -> u32 {
    c_abi::isotsbench_string_len(utf8, len32(len))
}

/// # Safety
/// `data` must point to `len` readable bytes, or be null with `len` 0.
#[no_mangle]
pub unsafe extern "C" fn isotsbench_scriptc_bytes_len(data: *const u8, len: usize) -> u32 {
    c_abi::isotsbench_bytes_len(data, len32(len))
}

/// # Safety
/// `data` must point to `len` readable bytes, or be null with `len` 0.
#[no_mangle]
pub unsafe extern "C" fn isotsbench_scriptc_checksum_bytes(data: *const u8, len: usize) -> u32 {
    c_abi::isotsbench_checksum_bytes(data, len32(len))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapters_call_the_shared_abi() {
        let words = [1i32, 2, 3, i32::MAX];
        let bytes = words.as_ptr().cast::<u8>();
        assert_eq!(unsafe { isotsbench_scriptc_sum_i32(bytes.add(4), 8) }, 5);
        assert_eq!(
            unsafe { isotsbench_scriptc_string_len(std::ptr::null(), 0) },
            0
        );
        assert_eq!(
            unsafe { isotsbench_scriptc_checksum_bytes(b"foobar".as_ptr(), 6) },
            0xbf9c_f968
        );
        assert_eq!(
            unsafe { isotsbench_scriptc_bytes_len(b"abc".as_ptr(), 3) },
            3
        );
    }
}
