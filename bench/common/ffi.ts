// Loads the C ABI library (native/ffi) through the runtime's own FFI:
// bun:ffi in Bun, Deno.dlopen in Deno. Node.js has no stable FFI, so it
// gets no FFI path.
//
// Both runtimes use the same signatures and the same call code. sum_i32
// receives the typed array as a pointer (the view's own start, byteOffset
// included; no copy) plus the element count as u32, because a C function
// cannot read a JS array's length. u32 takes a plain number on the fast
// path in both runtimes; see native/ffi for why it is not size_t.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";

export interface FfiOps {
  noop(): void;
  add_i32(a: number, b: number): number;
  sum_i32(data: Int32Array, length: number): number;
  /** `utf8` holds the string already encoded (TextEncoder.encodeInto); `length` is the byte count. */
  string_len(utf8: Uint8Array, length: number): number;
  bytes_len(data: Uint8Array, length: number): number;
  checksum_bytes(data: Uint8Array, length: number): number;
  return_f64(): number;
  /** The fill_* functions write exactly `length` bytes into `out` (caller-owned) and return what they produced. */
  fill_string_ascii(out: Uint8Array, length: number): number;
  fill_string_utf8(out: Uint8Array, length: number): number;
  fill_bytes(out: Uint8Array, length: number): number;
  /** Returns the row count; `length` must be a multiple of 32. */
  fill_rows_packed(out: Uint8Array, length: number): number;
}

export type FfiBinding = "bun:ffi" | "Deno.dlopen";

const LIBRARY_NAMES: Record<string, string> = {
  darwin: "libisotsbench_ffi.dylib",
  win32: "isotsbench_ffi.dll",
};

export const FFI_LIBRARY_NAME = LIBRARY_NAMES[process.platform] ?? "libisotsbench_ffi.so";
export const FFI_LIBRARY_URL = new URL(`../../build/${FFI_LIBRARY_NAME}`, import.meta.url);

/** The FFI mechanism of the current runtime, or null when it has none. */
export function ffiBinding(): FfiBinding | null {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.Bun) return "bun:ffi";
  if (g.Deno) return "Deno.dlopen";
  return null;
}

export function loadFfi(): FfiOps | null {
  const binding = ffiBinding();
  if (binding === null) return null;
  const path = fileURLToPath(FFI_LIBRARY_URL);
  if (!existsSync(path)) {
    throw new Error(`FFI library not found at ${path}. Run \`make build\` first.`);
  }

  if (binding === "bun:ffi") {
    const { dlopen } = createRequire(import.meta.url)("bun:ffi");
    const { symbols } = dlopen(path, {
      isotsbench_noop: { args: [], returns: "void" },
      isotsbench_add_i32: { args: ["i32", "i32"], returns: "i32" },
      isotsbench_sum_i32: { args: ["ptr", "u32"], returns: "i32" },
      isotsbench_string_len: { args: ["ptr", "u32"], returns: "u32" },
      isotsbench_bytes_len: { args: ["ptr", "u32"], returns: "u32" },
      isotsbench_checksum_bytes: { args: ["ptr", "u32"], returns: "u32" },
      isotsbench_return_f64: { args: [], returns: "f64" },
      isotsbench_fill_string_ascii: { args: ["ptr", "u32"], returns: "u32" },
      isotsbench_fill_string_utf8: { args: ["ptr", "u32"], returns: "u32" },
      isotsbench_fill_bytes: { args: ["ptr", "u32"], returns: "u32" },
      isotsbench_fill_rows_packed: { args: ["ptr", "u32"], returns: "u32" },
    });
    return {
      noop: symbols.isotsbench_noop,
      add_i32: symbols.isotsbench_add_i32,
      sum_i32: symbols.isotsbench_sum_i32,
      string_len: symbols.isotsbench_string_len,
      bytes_len: symbols.isotsbench_bytes_len,
      checksum_bytes: symbols.isotsbench_checksum_bytes,
      return_f64: symbols.isotsbench_return_f64,
      fill_string_ascii: symbols.isotsbench_fill_string_ascii,
      fill_string_utf8: symbols.isotsbench_fill_string_utf8,
      fill_bytes: symbols.isotsbench_fill_bytes,
      fill_rows_packed: symbols.isotsbench_fill_rows_packed,
    };
  }

  const { symbols } = Deno.dlopen(path, {
    isotsbench_noop: { parameters: [], result: "void" },
    isotsbench_add_i32: { parameters: ["i32", "i32"], result: "i32" },
    isotsbench_sum_i32: { parameters: ["buffer", "u32"], result: "i32" },
    isotsbench_string_len: { parameters: ["buffer", "u32"], result: "u32" },
    isotsbench_bytes_len: { parameters: ["buffer", "u32"], result: "u32" },
    isotsbench_checksum_bytes: { parameters: ["buffer", "u32"], result: "u32" },
    isotsbench_return_f64: { parameters: [], result: "f64" },
    isotsbench_fill_string_ascii: { parameters: ["buffer", "u32"], result: "u32" },
    isotsbench_fill_string_utf8: { parameters: ["buffer", "u32"], result: "u32" },
    isotsbench_fill_bytes: { parameters: ["buffer", "u32"], result: "u32" },
    isotsbench_fill_rows_packed: { parameters: ["buffer", "u32"], result: "u32" },
  });
  return {
    noop: symbols.isotsbench_noop,
    add_i32: symbols.isotsbench_add_i32,
    sum_i32: symbols.isotsbench_sum_i32,
    string_len: symbols.isotsbench_string_len,
    bytes_len: symbols.isotsbench_bytes_len,
    checksum_bytes: symbols.isotsbench_checksum_bytes,
    return_f64: symbols.isotsbench_return_f64,
    fill_string_ascii: symbols.isotsbench_fill_string_ascii,
    fill_string_utf8: symbols.isotsbench_fill_string_utf8,
    fill_bytes: symbols.isotsbench_fill_bytes,
    fill_rows_packed: symbols.isotsbench_fill_rows_packed,
  };
}
