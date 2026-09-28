// Loads the Node-API addon. `createRequire` is used because it is the one
// loading path shared by Node.js, Bun and Deno for `.node` files.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export interface NativeOps {
  noop(): void;
  add_i32(a: number, b: number): number;
  sum_i32(data: Int32Array): number;
}

export const NAPI_ADDON_URL = new URL("../../build/isotsbench_napi.node", import.meta.url);

export function loadNapi(): NativeOps {
  const path = fileURLToPath(NAPI_ADDON_URL);
  if (!existsSync(path)) {
    throw new Error(`Node-API addon not found at ${path}. Run \`make build\` first.`);
  }
  return createRequire(import.meta.url)(path) as NativeOps;
}
