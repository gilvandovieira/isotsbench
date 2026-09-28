// Loads the Node-API addon. `createRequire` is used because it is the one
// loading path shared by Node.js, Bun and Deno for `.node` files.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Row } from "./rows.ts";

export interface NativeOps {
  noop(): void;
  add_i32(a: number, b: number): number;
  sum_i32(data: Int32Array): number;
  string_len(value: string): number;
  bytes_len(data: Uint8Array): number;
  checksum_bytes(data: Uint8Array): number;
  return_f64(): number;
  return_string_ascii(bytes: number): string;
  return_string_utf8(bytes: number): string;
  /** A new JS-owned Uint8Array filled by native code. */
  return_bytes(bytes: number): Uint8Array;
  /** A new JS-owned Uint8Array of `count` packed rows (32 bytes each). */
  return_rows_packed(count: number): Uint8Array;
  /** `count` row objects built through Node-API. */
  return_rows(count: number): Row[];
}

export const NAPI_ADDON_URL = new URL("../../build/isotsbench_napi.node", import.meta.url);

export function loadNapi(): NativeOps {
  const path = fileURLToPath(NAPI_ADDON_URL);
  if (!existsSync(path)) {
    throw new Error(`Node-API addon not found at ${path}. Run \`make build\` first.`);
  }
  return createRequire(import.meta.url)(path) as NativeOps;
}
