// Builds the native artifacts in release mode into build/:
// - the Node-API addon (native/napi) and the C ABI library for Bun/Deno FFI
//   (native/ffi);
// - when scriptc is installed, the scriptc executable
//   (bench/scriptc/run.ts, linked against the static archive native/scriptc
//   through native/scriptc/ffi.json).
// - when the wasm32-unknown-unknown target is installed, the WebAssembly
//   module for Node.js, Bun and Deno from native/wasm, in two builds: default
//   target features, and +simd128.
//
//   node scripts/build.ts [--skip-scriptc]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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

/** Relative to ROOT. */
export const SCRIPTC_EXECUTABLE = join("build", "isotsbench-scriptc");
const SCRIPTC_ENTRY = join("bench", "scriptc", "run.ts");
const SCRIPTC_MANIFEST = join("native", "scriptc", "ffi.json");
const SCRIPTC_ARCHIVE = join("target", "release", "libisotsbench_scriptc.a");
const WASM_TARGET = "wasm32-unknown-unknown";
const WASM_ARTIFACT = join("build", "isotsbench.wasm");
const WASM_SIMD128_ARTIFACT = join("build", "isotsbench-simd128.wasm");

export interface NativeArtifact {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ScriptcBuild {
  compiler: string;
  /** The exact build command; scriptc defaults: LLVM backend, release (-O2) optimisation. */
  command: string[];
  executable: NativeArtifact;
  archive: NativeArtifact;
  manifest: NativeArtifact;
}

export interface WasmVariantBuild {
  /** The exact release build command. */
  command: string[];
  /** RUSTFLAGS the build ran with: the caller's, plus `+simd128` for that variant. */
  rustflags: string | null;
  artifact: NativeArtifact;
}

export interface WasmBuild {
  target: string;
  rustc: string;
  default: WasmVariantBuild;
  simd128: WasmVariantBuild;
}

function artifact(path: string): NativeArtifact {
  const bytes = readFileSync(join(ROOT, path));
  return { path, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function install(built: string, dest: URL): NativeArtifact {
  const path = fileURLToPath(dest);
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(join(ROOT, "target", "release", built), path);
  console.error(`built: ${path}`);
  return artifact(relative(ROOT, path));
}

function run(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

export function buildNative(): { napi: NativeArtifact; ffi: NativeArtifact } {
  run("cargo", ["build", "--release", "-p", "isotsbench-napi", "-p", "isotsbench-ffi"]);
  return {
    napi: install(NAPI_LIBRARY_NAMES[process.platform] ?? "libisotsbench_napi.so", NAPI_ADDON_URL),
    ffi: install(FFI_LIBRARY_NAME, FFI_LIBRARY_URL),
  };
}

/** Whether rustc has the standard library for the WASM target (`rustup target add ...`). */
export function wasmTargetInstalled(): boolean {
  const sysroot = spawnSync("rustc", ["--print", "sysroot"], { cwd: ROOT, encoding: "utf8" });
  return sysroot.status === 0 && existsSync(join(sysroot.stdout.trim(), "lib", "rustlib", WASM_TARGET));
}

function buildWasmVariant(extraRustflags: string | null, targetDir: string, destination: string): WasmVariantBuild {
  const command = [
    "cargo",
    "build",
    "--release",
    "--target",
    WASM_TARGET,
    "-p",
    "isotsbench-wasm",
    "--target-dir",
    targetDir,
  ];
  const rustflags = [process.env.RUSTFLAGS, extraRustflags].filter(Boolean).join(" ") || null;
  const result = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    stdio: "inherit",
    env: rustflags === null ? process.env : { ...process.env, RUSTFLAGS: rustflags },
  });
  if (result.status !== 0) throw new Error(`${command.join(" ")} failed`);
  const built = join(ROOT, targetDir, WASM_TARGET, "release", "isotsbench_wasm.wasm");
  mkdirSync(dirname(join(ROOT, destination)), { recursive: true });
  copyFileSync(built, join(ROOT, destination));
  console.error(`built: ${join(ROOT, destination)}`);
  return { command, rustflags, artifact: artifact(destination) };
}

/**
 * Builds the WebAssembly module from the shared Rust core twice: with the
 * target's default features and with `+simd128` (separate target dirs, so
 * neither build invalidates the other). Returns null, and removes any stale
 * artifacts, when the WASM target is not installed: WASM cases are then
 * simply unavailable, like a missing runtime.
 */
export function buildWasm(): WasmBuild | null {
  if (!wasmTargetInstalled()) {
    for (const path of [WASM_ARTIFACT, WASM_SIMD128_ARTIFACT]) rmSync(join(ROOT, path), { force: true });
    console.error(`skipping WebAssembly: rustc has no ${WASM_TARGET} target (rustup target add ${WASM_TARGET})`);
    return null;
  }
  const rustc = spawnSync("rustc", ["-vV"], { cwd: ROOT, encoding: "utf8" });
  if (rustc.status !== 0) throw new Error("rustc -vV failed");
  return {
    target: WASM_TARGET,
    rustc: rustc.stdout.trim(),
    default: buildWasmVariant(null, "target", WASM_ARTIFACT),
    simd128: buildWasmVariant("-C target-feature=+simd128", join("target", "wasm-simd128"), WASM_SIMD128_ARTIFACT),
  };
}

/** The installed scriptc compiler's version, or null when it is not on PATH. */
export function scriptcVersion(): string | null {
  const result = spawnSync("scriptc", ["--version"], { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Builds the scriptc executable. Throws if scriptc is not installed. */
export function buildScriptc(): ScriptcBuild {
  const compiler = scriptcVersion();
  if (compiler === null) throw new Error("scriptc is not on PATH");
  run("cargo", ["build", "--release", "-p", "isotsbench-scriptc"]);
  const command = ["scriptc", "build", SCRIPTC_ENTRY, "--ffi", SCRIPTC_MANIFEST, "-o", SCRIPTC_EXECUTABLE];
  mkdirSync(join(ROOT, "build"), { recursive: true });
  run(command[0], command.slice(1));
  console.error(`built: ${join(ROOT, SCRIPTC_EXECUTABLE)}`);
  return {
    compiler,
    command,
    executable: artifact(SCRIPTC_EXECUTABLE),
    archive: artifact(SCRIPTC_ARCHIVE),
    manifest: artifact(SCRIPTC_MANIFEST),
  };
}

if (import.meta.main) {
  buildNative();
  buildWasm();
  if (process.argv.includes("--skip-scriptc")) console.error("skipping scriptc: --skip-scriptc");
  else if (scriptcVersion() === null) console.error("skipping scriptc: not on PATH");
  else buildScriptc();
}
