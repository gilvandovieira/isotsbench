// Builds the native artifacts in release mode into build/:
// - the Node-API addon (native/napi) and the C ABI library for Bun/Deno FFI
//   (native/ffi);
// - when scriptc is installed, the scriptc executable
//   (bench/scriptc/run.ts, linked against the static archive native/scriptc
//   through native/scriptc/ffi.json).
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

/** Relative to ROOT. */
export const SCRIPTC_EXECUTABLE = join("build", "isotsbench-scriptc");
const SCRIPTC_ENTRY = join("bench", "scriptc", "run.ts");
const SCRIPTC_MANIFEST = join("native", "scriptc", "ffi.json");
const SCRIPTC_ARCHIVE = join("target", "release", "libisotsbench_scriptc.a");

export interface NativeArtifact {
  path: string;
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

function artifact(path: string): NativeArtifact {
  return { path, sha256: createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex") };
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
  if (scriptcVersion() === null) console.error("skipping scriptc: not on PATH");
  else buildScriptc();
}
