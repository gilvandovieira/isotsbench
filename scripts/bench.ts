// Runs the benchmark matrix: builds the native addon, records the
// environment, runs bench/run.ts in each available runtime (sequentially,
// one process per runtime) and prints a cross-runtime summary.
//
//   node scripts/bench.ts [--runtimes node,bun,deno] [--warmup 5] [--samples 30] [--sample-ms 20] [--filter id]
//
// Raw output: results/raw/<run-id>/{environment,node,bun,deno}.json

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatNs, table } from "../bench/common/format.ts";
import type { CaseResult } from "../bench/common/harness.ts";
import { buildNative } from "./build.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNNER = join(ROOT, "bench", "run.ts");

const RUNTIME_COMMANDS: Record<string, string[]> = {
  node: ["node", RUNNER],
  bun: ["bun", RUNNER],
  deno: ["deno", "run", "--allow-read", "--allow-write", "--allow-ffi", RUNNER],
};

function capture(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function run(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" }).status === 0;
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function collectEnvironment(runId: string, runtimes: Record<string, string | null>, options: object) {
  const rustc = capture("rustc", ["-vV"]) ?? "";
  const rustcField = (key: string) => rustc.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1] ?? null;
  const cpus = os.cpus();
  return {
    runId,
    createdAt: new Date().toISOString(),
    cpu: { model: cpus[0]?.model ?? null, cores: cpus.length, arch: os.arch() },
    memoryBytes: os.totalmem(),
    os: { platform: os.platform(), type: os.type(), release: os.release(), version: os.version() },
    cpuGovernor: readOptional("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
    powerProfile: readOptional("/sys/firmware/acpi/platform_profile"),
    runtimes,
    rust: {
      rustc: rustcField("release"),
      commit: rustcField("commit-hash"),
      target: rustcField("host"),
      cargo: capture("cargo", ["--version"]),
      profile: "release",
      rustflags: process.env.RUSTFLAGS ?? null,
    },
    git: {
      commit: capture("git", ["rev-parse", "HEAD"]),
      dirty: capture("git", ["status", "--porcelain"]) !== "",
    },
    options,
  };
}

function printSummary(byRuntime: Map<string, CaseResult[]>): void {
  const names = [...byRuntime.keys()];
  const keys = [...new Set([...byRuntime.values()].flat().map((r) => `${r.op}/${r.size}`))];
  const median = (rt: string, key: string, impl: string) =>
    byRuntime.get(rt)!.find((r) => `${r.op}/${r.size}` === key && r.impl === impl)?.ns_per_op.median;

  const rows = keys.map((key) => [
    key.replace(/\/null$/, ""),
    ...names.flatMap((rt) => {
      const ts = median(rt, key, "ts");
      const napi = median(rt, key, "napi");
      return [
        ts === undefined ? "-" : formatNs(ts),
        napi === undefined ? "-" : formatNs(napi),
        ts && napi ? `${(napi / ts).toFixed(2)}×` : "-",
      ];
    }),
  ]);
  const header = ["median ns/op", ...names.flatMap((rt) => [`${rt} ts`, `${rt} napi`, "napi/ts"])];
  console.log(`\n${table(header, rows)}`);

  for (const rt of names) {
    const sizes = byRuntime.get(rt)!.filter((r) => r.op === "sum_i32" && r.impl === "ts").map((r) => r.size!);
    // Smallest size from which napi stays faster for every larger measured size.
    let breakEven: number | null = null;
    for (const size of [...sizes].sort((a, b) => b - a)) {
      const ts = median(rt, `sum_i32/${size}`, "ts");
      const napi = median(rt, `sum_i32/${size}`, "napi");
      if (ts === undefined || napi === undefined || napi >= ts) break;
      breakEven = size;
    }
    if (sizes.length) {
      console.log(
        `${rt}: sum_i32 napi faster than ts ${breakEven === null ? "at no measured size" : `from size ${breakEven}`}`,
      );
    }
  }
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      runtimes: { type: "string", default: Object.keys(RUNTIME_COMMANDS).join(",") },
      warmup: { type: "string", default: "5" },
      samples: { type: "string", default: "30" },
      "sample-ms": { type: "string", default: "20" },
      filter: { type: "string" },
    },
  });
  const requested = values.runtimes.split(",").map((s) => s.trim()).filter(Boolean);
  for (const rt of requested) {
    if (!RUNTIME_COMMANDS[rt]) throw new Error(`unknown runtime "${rt}"`);
  }

  const passThrough = ["--warmup", values.warmup, "--samples", values.samples, "--sample-ms", values["sample-ms"]];
  if (values.filter) passThrough.push("--filter", values.filter);

  buildNative();

  const versions: Record<string, string | null> = {};
  for (const rt of requested) {
    versions[rt] = capture(RUNTIME_COMMANDS[rt][0], ["--version"])?.split("\n")[0] ?? null;
    if (versions[rt] === null) console.error(`skipping ${rt}: not found on PATH`);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(ROOT, "results", "raw", runId);
  mkdirSync(outDir, { recursive: true });
  const options = { warmup: Number(values.warmup), samples: Number(values.samples), sampleMs: Number(values["sample-ms"]) };
  writeFileSync(
    join(outDir, "environment.json"),
    JSON.stringify(collectEnvironment(runId, versions, options), null, 2) + "\n",
  );

  const byRuntime = new Map<string, CaseResult[]>();
  const failed: string[] = [];
  for (const rt of requested) {
    if (versions[rt] === null) continue;
    const out = join(outDir, `${rt}.json`);
    const [cmd, ...args] = RUNTIME_COMMANDS[rt];
    console.error(`\n== ${rt} (${versions[rt]}) ==`);
    if (run(cmd, [...args, ...passThrough, "--out", out]) && existsSync(out)) {
      byRuntime.set(rt, JSON.parse(readFileSync(out, "utf8")).results);
    } else {
      failed.push(rt);
    }
  }

  if (byRuntime.size) printSummary(byRuntime);
  else failed.push("(no runtime available)");
  console.error(`\nraw results: ${outDir}`);
  if (failed.length) {
    console.error(`failed runtimes: ${failed.join(", ")}`);
    process.exit(1);
  }
}

main();
