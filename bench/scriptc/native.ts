// Signature-only declarations bound to C symbols by native/scriptc/ffi.json
// (scriptc build --ffi). scriptc turns only direct calls of these exact
// declarations into native calls.
//
// Bound: the scalar functions of the shared C ABI, and size_t adapters for
// span parameters (scriptc passes `string` and `bytes` as
// `(const uint8_t *, size_t)`, borrowed for the call).
//
// Not bound, because scriptc 0.1.7 FFI cannot express them: the fill_*
// return functions need a writable caller buffer (no `mutable-bytes` class)
// and nothing can be returned except scalars.

export declare function isotsbench_noop(): void;
export declare function isotsbench_add_i32(a: number, b: number): number;
export declare function isotsbench_return_f64(): number;
/** sum_i32 over a Uint8Array alias of the Int32Array's memory (bytes accepts only Uint8Array/Buffer). */
export declare function isotsbench_scriptc_sum_i32(bytes: Uint8Array): number;
/** scriptc passes the string's UTF-8 bytes; see docs/methodology.md for what that costs. */
export declare function isotsbench_scriptc_string_len(value: string): number;
export declare function isotsbench_scriptc_bytes_len(data: Uint8Array): number;
export declare function isotsbench_scriptc_checksum_bytes(data: Uint8Array): number;
