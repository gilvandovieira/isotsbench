// The shape of a benchmark case, shared by every runtime's case builder
// (bench/common/cases.ts for Node.js, Bun and Deno; bench/scriptc/ for scriptc).

import type { Payload } from "./payloads.ts";

/** ts: TypeScript; napi: Node-API; ffi: native C ABI; wasm: WebAssembly over the Rust core. */
export type Impl = "ts" | "napi" | "ffi" | "wasm";

export interface Case {
  id: string;
  op: string;
  impl: Impl;
  /** Mechanism crossing into native code: "none", "node-api", runtime FFI or "WebAssembly". */
  binding: string;
  /** Workload size for scalable operations: elements for sum_i32, payload bytes for the marshalling cases. */
  size: number | null;
  /** Payload flavour where an operation has several (string_len: "ascii" or "utf8"). */
  variant?: string;
  /** What crosses the boundary, and how much of it. */
  payload?: Payload;
  /** Return cases only: how the result is represented when a path has several ("objects" or "packed" rows). */
  strategy?: string;
  /** Who allocates, fills, copies or borrows the data (see docs/methodology.md): return cases, and scriptc FFI cases. */
  ownership?: string;
  run(iterations: number): number;
}
