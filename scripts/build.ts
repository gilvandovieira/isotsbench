// Builds the Node-API addon in release mode and copies it to build/.
//
//   node scripts/build.ts

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { NAPI_ADDON_URL } from "../bench/common/napi.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const LIBRARY_NAMES: Record<string, string> = {
  darwin: "libisotsbench_napi.dylib",
  win32: "isotsbench_napi.dll",
};

export function buildNative(): void {
  const cargo = spawnSync("cargo", ["build", "--release", "-p", "isotsbench-napi"], { cwd: ROOT, stdio: "inherit" });
  if (cargo.status !== 0) throw new Error("cargo build failed");
  const lib = LIBRARY_NAMES[process.platform] ?? "libisotsbench_napi.so";
  const dest = fileURLToPath(NAPI_ADDON_URL);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(ROOT, "target", "release", lib), dest);
  console.error(`addon: ${dest}`);
}

if (import.meta.main) buildNative();
