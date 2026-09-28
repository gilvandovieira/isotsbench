//! Node-API binding over `isotsbench-core`.
//!
//! Written against the raw Node-API C ABI (no napi-rs) so the benchmark
//! measures Node-API itself rather than a binding framework. Only the
//! handful of functions used below are declared. The same `.node` file is
//! loaded by Node.js, Bun and Deno.

#![allow(non_camel_case_types)]

use std::cell::RefCell;
use std::ffi::{c_char, c_void};
use std::ptr;

type napi_env = *mut c_void;
type napi_value = *mut c_void;
type napi_callback_info = *mut c_void;
type napi_status = i32;
type napi_callback = unsafe extern "C" fn(napi_env, napi_callback_info) -> napi_value;

const NAPI_OK: napi_status = 0;
const NAPI_UINT8_ARRAY: i32 = 1;
const NAPI_INT32_ARRAY: i32 = 5;

extern "C" {
    fn napi_create_function(
        env: napi_env,
        utf8name: *const c_char,
        length: usize,
        cb: napi_callback,
        data: *mut c_void,
        result: *mut napi_value,
    ) -> napi_status;
    fn napi_set_named_property(
        env: napi_env,
        object: napi_value,
        utf8name: *const c_char,
        value: napi_value,
    ) -> napi_status;
    fn napi_get_cb_info(
        env: napi_env,
        cbinfo: napi_callback_info,
        argc: *mut usize,
        argv: *mut napi_value,
        this_arg: *mut napi_value,
        data: *mut *mut c_void,
    ) -> napi_status;
    fn napi_get_value_int32(env: napi_env, value: napi_value, result: *mut i32) -> napi_status;
    fn napi_create_int32(env: napi_env, value: i32, result: *mut napi_value) -> napi_status;
    fn napi_create_uint32(env: napi_env, value: u32, result: *mut napi_value) -> napi_status;
    fn napi_get_value_string_utf8(
        env: napi_env,
        value: napi_value,
        buf: *mut c_char,
        bufsize: usize,
        result: *mut usize,
    ) -> napi_status;
    fn napi_get_typedarray_info(
        env: napi_env,
        typedarray: napi_value,
        kind: *mut i32,
        length: *mut usize,
        data: *mut *mut c_void,
        arraybuffer: *mut napi_value,
        byte_offset: *mut usize,
    ) -> napi_status;
    fn napi_get_value_uint32(env: napi_env, value: napi_value, result: *mut u32) -> napi_status;
    fn napi_create_double(env: napi_env, value: f64, result: *mut napi_value) -> napi_status;
    fn napi_get_boolean(env: napi_env, value: bool, result: *mut napi_value) -> napi_status;
    fn napi_create_string_utf8(
        env: napi_env,
        str: *const c_char,
        length: usize,
        result: *mut napi_value,
    ) -> napi_status;
    fn napi_create_arraybuffer(
        env: napi_env,
        byte_length: usize,
        data: *mut *mut c_void,
        result: *mut napi_value,
    ) -> napi_status;
    fn napi_create_typedarray(
        env: napi_env,
        kind: i32,
        length: usize,
        arraybuffer: napi_value,
        byte_offset: usize,
        result: *mut napi_value,
    ) -> napi_status;
    fn napi_create_object(env: napi_env, result: *mut napi_value) -> napi_status;
    fn napi_create_array_with_length(
        env: napi_env,
        length: usize,
        result: *mut napi_value,
    ) -> napi_status;
    fn napi_set_element(
        env: napi_env,
        object: napi_value,
        index: u32,
        value: napi_value,
    ) -> napi_status;
    fn napi_throw_type_error(env: napi_env, code: *const c_char, msg: *const c_char)
        -> napi_status;
}

unsafe fn throw(env: napi_env, msg: &'static [u8]) -> napi_value {
    napi_throw_type_error(env, ptr::null(), msg.as_ptr().cast());
    ptr::null_mut()
}

unsafe fn int32(env: napi_env, value: i32) -> napi_value {
    let mut result = ptr::null_mut();
    if napi_create_int32(env, value, &mut result) != NAPI_OK {
        return throw(env, b"failed to create int32\0");
    }
    result
}

unsafe fn uint32(env: napi_env, value: usize) -> napi_value {
    let Ok(value) = u32::try_from(value) else {
        return throw(env, b"result does not fit in uint32\0");
    };
    let mut result = ptr::null_mut();
    if napi_create_uint32(env, value, &mut result) != NAPI_OK {
        return throw(env, b"failed to create uint32\0");
    }
    result
}

unsafe fn args<const N: usize>(env: napi_env, info: napi_callback_info) -> Option<[napi_value; N]> {
    let mut argc = N;
    let mut argv = [ptr::null_mut(); N];
    let status = napi_get_cb_info(
        env,
        info,
        &mut argc,
        argv.as_mut_ptr(),
        ptr::null_mut(),
        ptr::null_mut(),
    );
    (status == NAPI_OK && argc >= N).then_some(argv)
}

// Returning NULL from a callback yields `undefined` without an extra call.
unsafe extern "C" fn noop(_env: napi_env, _info: napi_callback_info) -> napi_value {
    isotsbench_core::noop();
    ptr::null_mut()
}

unsafe extern "C" fn add_i32(env: napi_env, info: napi_callback_info) -> napi_value {
    let Some([a, b]) = args::<2>(env, info) else {
        return throw(env, b"add_i32 expects 2 arguments\0");
    };
    let (mut x, mut y) = (0, 0);
    if napi_get_value_int32(env, a, &mut x) != NAPI_OK
        || napi_get_value_int32(env, b, &mut y) != NAPI_OK
    {
        return throw(env, b"add_i32 expects numbers\0");
    }
    int32(env, isotsbench_core::add_i32(x, y))
}

unsafe extern "C" fn sum_i32(env: napi_env, info: napi_callback_info) -> napi_value {
    let Some([array]) = args::<1>(env, info) else {
        return throw(env, b"sum_i32 expects 1 argument\0");
    };
    let mut kind = -1;
    let mut length = 0;
    let mut data = ptr::null_mut();
    let status = napi_get_typedarray_info(
        env,
        array,
        &mut kind,
        &mut length,
        &mut data,
        ptr::null_mut(),
        ptr::null_mut(),
    );
    if status != NAPI_OK || kind != NAPI_INT32_ARRAY {
        return throw(env, b"sum_i32 expects an Int32Array\0");
    }
    // Borrows the typed array's backing store; no copy is made.
    let slice = if length == 0 || data.is_null() {
        &[][..]
    } else {
        std::slice::from_raw_parts(data as *const i32, length)
    };
    int32(env, isotsbench_core::sum_i32(slice))
}

/// Borrows a Uint8Array's bytes (view offset applied by the engine); no copy.
unsafe fn uint8_slice<'a>(env: napi_env, value: napi_value) -> Option<&'a [u8]> {
    let mut kind = -1;
    let mut length = 0;
    let mut data = ptr::null_mut();
    let status = napi_get_typedarray_info(
        env,
        value,
        &mut kind,
        &mut length,
        &mut data,
        ptr::null_mut(),
        ptr::null_mut(),
    );
    if status != NAPI_OK || kind != NAPI_UINT8_ARRAY {
        return None;
    }
    Some(if length == 0 || data.is_null() {
        &[][..]
    } else {
        std::slice::from_raw_parts(data as *const u8, length)
    })
}

thread_local! {
    /// Reused destination for UTF-8 conversion, so string ingress measures
    /// transcoding and copying, not a native allocation per call. It only
    /// grows; its capacity after a run is the largest string seen.
    static UTF8_SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// The usual Node-API string ingress: one call for the UTF-8 length, one to
/// transcode and copy the string into native memory.
unsafe extern "C" fn string_len(env: napi_env, info: napi_callback_info) -> napi_value {
    let Some([value]) = args::<1>(env, info) else {
        return throw(env, b"string_len expects 1 argument\0");
    };
    let mut len = 0;
    if napi_get_value_string_utf8(env, value, ptr::null_mut(), 0, &mut len) != NAPI_OK {
        return throw(env, b"string_len expects a string\0");
    }
    UTF8_SCRATCH.with_borrow_mut(|buf| {
        if buf.len() < len + 1 {
            buf.resize(len + 1, 0);
        }
        let mut written = 0;
        let status =
            napi_get_value_string_utf8(env, value, buf.as_mut_ptr().cast(), len + 1, &mut written);
        if status != NAPI_OK {
            return throw(env, b"failed to copy string as UTF-8\0");
        }
        uint32(env, isotsbench_core::string_len(&buf[..written]))
    })
}

unsafe extern "C" fn bytes_len(env: napi_env, info: napi_callback_info) -> napi_value {
    let Some([value]) = args::<1>(env, info) else {
        return throw(env, b"bytes_len expects 1 argument\0");
    };
    let Some(bytes) = uint8_slice(env, value) else {
        return throw(env, b"bytes_len expects a Uint8Array\0");
    };
    uint32(env, isotsbench_core::bytes_len(bytes))
}

unsafe extern "C" fn checksum_bytes(env: napi_env, info: napi_callback_info) -> napi_value {
    let Some([value]) = args::<1>(env, info) else {
        return throw(env, b"checksum_bytes expects 1 argument\0");
    };
    let Some(bytes) = uint8_slice(env, value) else {
        return throw(env, b"checksum_bytes expects a Uint8Array\0");
    };
    uint32(env, isotsbench_core::checksum_bytes(bytes) as usize)
}

// ---- Return path (native → JS) -------------------------------------------
//
// Ownership: nothing returned to JS points at native memory.
// - Strings are written into OUT_SCRATCH (native, reused) and copied by the
//   engine into a new JS string inside napi_create_string_utf8.
// - Byte buffers are allocated by the engine (napi_create_arraybuffer, owned
//   by JS) and filled in place by native code; no intermediate copy.
// - Rows are either built as JS objects through Node-API, or packed into a
//   JS-owned buffer like the bytes above.

thread_local! {
    /// Reused native buffer for string results; it only grows.
    static OUT_SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

unsafe fn uint32_arg(env: napi_env, info: napi_callback_info) -> Option<u32> {
    let [value] = args::<1>(env, info)?;
    let mut out = 0;
    (napi_get_value_uint32(env, value, &mut out) == NAPI_OK).then_some(out)
}

unsafe extern "C" fn return_f64(env: napi_env, _info: napi_callback_info) -> napi_value {
    let mut result = ptr::null_mut();
    if napi_create_double(env, isotsbench_core::return_f64(), &mut result) != NAPI_OK {
        return throw(env, b"failed to create double\0");
    }
    result
}

unsafe fn return_string(
    env: napi_env,
    info: napi_callback_info,
    fill: fn(&mut [u8]),
) -> napi_value {
    let Some(len) = uint32_arg(env, info) else {
        return throw(env, b"return_string expects a uint32 byte length\0");
    };
    let len = len as usize;
    OUT_SCRATCH.with_borrow_mut(|buf| {
        if buf.len() < len {
            buf.resize(len, 0);
        }
        fill(&mut buf[..len]);
        let mut result = ptr::null_mut();
        if napi_create_string_utf8(env, buf.as_ptr().cast(), len, &mut result) != NAPI_OK {
            return throw(env, b"failed to create string\0");
        }
        result
    })
}

unsafe extern "C" fn return_string_ascii(env: napi_env, info: napi_callback_info) -> napi_value {
    return_string(env, info, isotsbench_core::fill_ascii)
}

unsafe extern "C" fn return_string_utf8(env: napi_env, info: napi_callback_info) -> napi_value {
    return_string(env, info, isotsbench_core::fill_utf8)
}

/// A new JS-owned Uint8Array of `len` bytes, filled in place by `fill`.
unsafe fn new_uint8array(env: napi_env, len: usize, fill: impl FnOnce(&mut [u8])) -> napi_value {
    let mut data = ptr::null_mut();
    let mut buffer = ptr::null_mut();
    if napi_create_arraybuffer(env, len, &mut data, &mut buffer) != NAPI_OK {
        return throw(env, b"failed to create ArrayBuffer\0");
    }
    if len > 0 {
        fill(std::slice::from_raw_parts_mut(data.cast::<u8>(), len));
    }
    let mut array = ptr::null_mut();
    if napi_create_typedarray(env, NAPI_UINT8_ARRAY, len, buffer, 0, &mut array) != NAPI_OK {
        return throw(env, b"failed to create Uint8Array\0");
    }
    array
}

unsafe extern "C" fn return_bytes(env: napi_env, info: napi_callback_info) -> napi_value {
    let Some(len) = uint32_arg(env, info) else {
        return throw(env, b"return_bytes expects a uint32 byte length\0");
    };
    new_uint8array(env, len as usize, isotsbench_core::fill_bytes)
}

unsafe extern "C" fn return_rows_packed(env: napi_env, info: napi_callback_info) -> napi_value {
    let Some(count) = uint32_arg(env, info) else {
        return throw(env, b"return_rows_packed expects a uint32 row count\0");
    };
    let Some(len) = (count as usize).checked_mul(isotsbench_core::PACKED_ROW_SIZE) else {
        return throw(env, b"return_rows_packed: too many rows\0");
    };
    new_uint8array(env, len, |out| {
        isotsbench_core::fill_rows_packed(out);
    })
}

/// Builds `{ id, score, active, name }` objects through Node-API: one
/// object, four properties and one string per row, plus the array.
unsafe extern "C" fn return_rows(env: napi_env, info: napi_callback_info) -> napi_value {
    let Some(count) = uint32_arg(env, info) else {
        return throw(env, b"return_rows expects a uint32 row count\0");
    };
    let mut array = ptr::null_mut();
    if napi_create_array_with_length(env, count as usize, &mut array) != NAPI_OK {
        return throw(env, b"failed to create array\0");
    }
    for index in 0..count {
        let r = isotsbench_core::row(index);
        let (mut object, mut id, mut score, mut active, mut name) = (
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
        );
        let name_bytes = r.name();
        let ok = napi_create_object(env, &mut object) == NAPI_OK
            && napi_create_int32(env, r.id, &mut id) == NAPI_OK
            && napi_create_double(env, r.score, &mut score) == NAPI_OK
            && napi_get_boolean(env, r.active, &mut active) == NAPI_OK
            && napi_create_string_utf8(
                env,
                name_bytes.as_ptr().cast(),
                name_bytes.len(),
                &mut name,
            ) == NAPI_OK
            && napi_set_named_property(env, object, c"id".as_ptr(), id) == NAPI_OK
            && napi_set_named_property(env, object, c"score".as_ptr(), score) == NAPI_OK
            && napi_set_named_property(env, object, c"active".as_ptr(), active) == NAPI_OK
            && napi_set_named_property(env, object, c"name".as_ptr(), name) == NAPI_OK
            && napi_set_element(env, array, index, object) == NAPI_OK;
        if !ok {
            return throw(env, b"failed to build row object\0");
        }
    }
    array
}

unsafe fn export(
    env: napi_env,
    exports: napi_value,
    name: &'static [u8],
    cb: napi_callback,
) -> bool {
    let mut func = ptr::null_mut();
    napi_create_function(
        env,
        name.as_ptr().cast(),
        name.len() - 1,
        cb,
        ptr::null_mut(),
        &mut func,
    ) == NAPI_OK
        && napi_set_named_property(env, exports, name.as_ptr().cast(), func) == NAPI_OK
}

/// Module entry point looked up by the host runtime.
///
/// # Safety
/// Must only be called by a Node-API host with a valid `env` and `exports`.
#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: napi_env, exports: napi_value) -> napi_value {
    let ok = export(env, exports, b"noop\0", noop)
        && export(env, exports, b"add_i32\0", add_i32)
        && export(env, exports, b"sum_i32\0", sum_i32)
        && export(env, exports, b"string_len\0", string_len)
        && export(env, exports, b"bytes_len\0", bytes_len)
        && export(env, exports, b"checksum_bytes\0", checksum_bytes)
        && export(env, exports, b"return_f64\0", return_f64)
        && export(env, exports, b"return_string_ascii\0", return_string_ascii)
        && export(env, exports, b"return_string_utf8\0", return_string_utf8)
        && export(env, exports, b"return_bytes\0", return_bytes)
        && export(env, exports, b"return_rows_packed\0", return_rows_packed)
        && export(env, exports, b"return_rows\0", return_rows);
    if !ok {
        return throw(env, b"failed to register isotsbench-napi exports\0");
    }
    exports
}
