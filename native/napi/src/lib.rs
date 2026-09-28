//! Node-API binding over `isotsbench-core`.
//!
//! Written against the raw Node-API C ABI (no napi-rs) so the benchmark
//! measures Node-API itself rather than a binding framework. Only the
//! handful of functions used below are declared. The same `.node` file is
//! loaded by Node.js, Bun and Deno.

#![allow(non_camel_case_types)]

use std::ffi::{c_char, c_void};
use std::ptr;

type napi_env = *mut c_void;
type napi_value = *mut c_void;
type napi_callback_info = *mut c_void;
type napi_status = i32;
type napi_callback = unsafe extern "C" fn(napi_env, napi_callback_info) -> napi_value;

const NAPI_OK: napi_status = 0;
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
    fn napi_get_typedarray_info(
        env: napi_env,
        typedarray: napi_value,
        kind: *mut i32,
        length: *mut usize,
        data: *mut *mut c_void,
        arraybuffer: *mut napi_value,
        byte_offset: *mut usize,
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
        && export(env, exports, b"sum_i32\0", sum_i32);
    if !ok {
        return throw(env, b"failed to register isotsbench-napi exports\0");
    }
    exports
}
