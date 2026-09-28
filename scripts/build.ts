// Builds the native libraries in release mode and copies them to build/:
// the Node-API addon (native/napi) and the C ABI library for runtime FFI
// (native/ffi).
//
//   node scripts/build.ts

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { FFI_LIBRARY_NAME, FFI_LIBRARY_URL } from "../bench/common/ffi.ts";
import { NAPI_ADDON_URL } from "../bench/common/napi.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const NAPI_LIBRARY_NAMES: Record<string, string> = {
  darwin: "libisotsbench_napi.dylib",
  win32: "isotsbench_napi.dll",
};

export interface NativeArtifact {
  path: string;
  sha256: string;
}

function install(built: string, dest: URL): NativeArtifact {
  const path = fileURLToPath(dest);
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(join(ROOT, "target", "release", built), path);
  console.error(`built: ${path}`);
  return { path: relative(ROOT, path), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

export function buildNative(): { napi: NativeArtifact; ffi: NativeArtifact } {
  const cargo = spawnSync("cargo", ["build", "--release", "-p", "isotsbench-napi", "-p", "isotsbench-ffi"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (cargo.status !== 0) throw new Error("cargo build failed");
  return {
    napi: install(NAPI_LIBRARY_NAMES[process.platform] ?? "libisotsbench_napi.so", NAPI_ADDON_URL),
    ffi: install(FFI_LIBRARY_NAME, FFI_LIBRARY_URL),
  };
}

if (import.meta.main) buildNative();
