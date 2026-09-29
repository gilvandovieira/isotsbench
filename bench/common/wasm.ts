// Direct WebAssembly API over the Rust core's wasm32-unknown-unknown build,
// loaded synchronously from disk (Node.js, Bun, Deno). Input arrays live in
// JS memory; callers copy them into the exported linear memory before
// calling `sum_i32` (or, for the resident diagnostic, once outside timing).
// The ABI and both builds are described in wasm-abi.ts. A missing artifact
// (target not installed) makes that variant unavailable.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bindWasm, WASM_URLS, type WasmBinding, type WasmVariant } from "./wasm-abi.ts";

export type { WasmBinding } from "./wasm-abi.ts";

export function loadWasm(variant: WasmVariant): WasmBinding | null {
  const path = fileURLToPath(WASM_URLS[variant]);
  if (!existsSync(path)) return null;
  return bindWasm(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path))).exports, variant);
}
