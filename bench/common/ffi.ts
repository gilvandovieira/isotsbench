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
    });
    return { noop: symbols.isotsbench_noop, add_i32: symbols.isotsbench_add_i32, sum_i32: symbols.isotsbench_sum_i32 };
  }

  const { symbols } = Deno.dlopen(path, {
    isotsbench_noop: { parameters: [], result: "void" },
    isotsbench_add_i32: { parameters: ["i32", "i32"], result: "i32" },
    isotsbench_sum_i32: { parameters: ["buffer", "u32"], result: "i32" },
  });
  return {
    noop: symbols.isotsbench_noop,
    add_i32: symbols.isotsbench_add_i32,
    sum_i32: symbols.isotsbench_sum_i32,
  };
}
