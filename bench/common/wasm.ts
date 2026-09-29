// Direct WebAssembly API over the Rust core's wasm32-unknown-unknown build.
// Input arrays live in JS memory; callers copy them into the exported linear
// memory before calling `sum_i32` (or, for the resident diagnostic, once
// outside timing).
//
// Two builds of the same source are loaded:
// - default: the target's default features (no SIMD);
// - simd128: `-C target-feature=+simd128`, which lets LLVM vectorise the sum.
// A missing artifact (target not installed) makes that variant unavailable.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type WasmVariant = "default" | "simd128";

export const WASM_URLS: Record<WasmVariant, URL> = {
  default: new URL("../../build/isotsbench.wasm", import.meta.url),
  simd128: new URL("../../build/isotsbench-simd128.wasm", import.meta.url),
};

export interface WasmBinding {
  memory: WebAssembly.Memory;
  noop(): void;
  add_i32(a: number, b: number): number;
  /** Reserves `length` i32 in linear memory; returns an unsigned byte offset. */
  alloc_i32(length: number): number;
  sum_i32(pointer: number, length: number): number;
}

export function loadWasm(variant: WasmVariant): WasmBinding | null {
  const path = fileURLToPath(WASM_URLS[variant]);
  if (!existsSync(path)) return null;
  const exports = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path))).exports;
  const memory = exports.memory;
  const noop = exports.isotsbench_noop;
  const add_i32 = exports.isotsbench_add_i32;
  const alloc_i32 = exports.isotsbench_alloc_i32;
  const sum_i32 = exports.isotsbench_sum_i32;
  if (
    !(memory instanceof WebAssembly.Memory) ||
    typeof noop !== "function" || typeof add_i32 !== "function" ||
    typeof alloc_i32 !== "function" || typeof sum_i32 !== "function"
  ) {
    throw new Error(`isotsbench WASM artifact (${variant}) is missing required exports`);
  }
  const alloc = alloc_i32 as (length: number) => number;
  return {
    memory,
    noop: noop as () => void,
    add_i32: add_i32 as (a: number, b: number) => number,
    // wasm32 pointers cross as i32; read them as unsigned so offsets above
    // 2 GiB stay positive. Passing one back to an i32 parameter keeps its bits.
    alloc_i32: (length) => alloc(length) >>> 0,
    sum_i32: sum_i32 as (pointer: number, length: number) => number,
  };
}
