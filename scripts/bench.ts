// Runs the benchmark matrix: builds the native addon, records the
// environment and run conditions, runs bench/run.ts for every scheduled
// unit (sequentially, never in parallel) and prints a summary.
//
//   node scripts/bench.ts [options]
//
//   --runtimes node,bun,deno,scriptc   runtimes to run (missing ones are skipped)
//   --isolation case|runtime|both
//                              fresh process per case (default), one shared process per
//                              runtime, or both modes in the same shuffled repetitions
//   --runs N                   complete repetitions of the matrix (default 1)
//   --order shuffle|fixed      unit order within each repetition (default shuffle)
//   --seed N                   seed for --order shuffle (default random, recorded)
//   --cpus LIST                pin every benchmark process with `taskset -c LIST` (Linux)
//   --official                 official profile: both isolation modes, shuffle, >= 3 runs, --cpus required
//   --suite LIST               only these suites: boundary, payload, return (default all)
//   --warmup N --samples N --sample-ms N --filter TEXT   passed to bench/run.ts
//
// Raw output: results/raw/<run-id>/{environment,node,bun,deno}.json

import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatNs } from "../bench/common/format.ts";
import { parseSuites, type Suite } from "../bench/common/suites.ts";
import { type ProcessGroup, processGroupOf, WASM_NO_INLINE_FLAG } from "../bench/common/process-groups.ts";
import { buildNative, buildScriptc, buildWasm, SCRIPTC_EXECUTABLE, type ScriptcBuild, type WasmBuild, scriptcVersion } from "./build.ts";
import {
  type CaseVariance,
  caseVariance,
  type Isolation,
  printDivergences,
  printSummary,
  printVariance,
  splitRuns,
  type StoredResult,
} from "./compare.ts";
import { mulberry32, shuffle } from "./shuffle.ts";
import { assessConditions, formatCpuList, parseCpuList, probeSystem } from "./system.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RESULT_SCHEMA_VERSION = 2;

// Relative to ROOT, which every process runs in. scriptc is not an
// interpreter: its benchmark is an executable built by scripts/build.ts.
const RUNTIME_COMMANDS: Record<string, string[]> = {
  node: ["node", "bench/run.ts"],
  bun: ["bun", "bench/run.ts"],
  deno: ["deno", "run", "--allow-read", "--allow-write", "--allow-ffi", "bench/run.ts"],
  scriptc: [SCRIPTC_EXECUTABLE],
};

/** A runtime's version, or null when it is not installed. */
function runtimeVersion(rt: string): string | null {
  if (rt === "scriptc") return scriptcVersion();
  return capture(RUNTIME_COMMANDS[rt][0], ["--version"])?.split("\n")[0] ?? null;
}

interface Plan {
  profile: "official" | "standard";
  isolation: Isolation | "both";
  runs: number;
  order: "shuffle" | "fixed";
  seed: number;
  cpus: number[] | null;
  harness: { warmup: number; samples: number; sampleMs: number };
  filter: string | null;
  suites: Suite[] | null;
}

interface Unit {
  run: number;
  runtime: string;
  isolation: Isolation;
  /** Engine flags the process starts with (see bench/common/process-groups.ts). */
  group: ProcessGroup;
  /** null: a shared process running every selected case of its group in canonical order. */
  caseId: string | null;
}

/**
 * Commands for the non-default process groups. A runtime without an entry
 * cannot run that group. Deno receives V8 flags through --v8-flags.
 */
const GROUP_COMMANDS: Record<Exclude<ProcessGroup, "default">, Record<string, string[]>> = {
  "wasm-no-inline": {
    node: ["node", WASM_NO_INLINE_FLAG, "bench/run.ts"],
    deno: ["deno", "run", "--allow-read", "--allow-write", "--allow-ffi", `--v8-flags=${WASM_NO_INLINE_FLAG}`, "bench/run.ts"],
  },
};

/** The command that starts a process of `group` for `runtime`, including the group argument. */
function commandFor(runtime: string, group: ProcessGroup): string[] {
  if (runtime === "scriptc") return RUNTIME_COMMANDS.scriptc;
  const base = group === "default" ? RUNTIME_COMMANDS[runtime] : GROUP_COMMANDS[group][runtime];
  if (!base) throw new Error(`${runtime} cannot run process group ${group}`);
  return [...base, "--process-group", group];
}

/** --filter / --suite arguments for bench/run.ts. */
function selectionArgs(plan: Plan): string[] {
  return [
    ...(plan.filter ? ["--filter", plan.filter] : []),
    ...(plan.suites ? ["--suite", plan.suites.join(",")] : []),
  ];
}

function capture(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got "${value}"`);
  return n;
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`--${name} must be one of ${allowed.join(", ")}, got "${value}"`);
  }
  return value as T;
}

function resolvePlan(values: Record<string, string | boolean | undefined>): Plan {
  const str = (key: string) => values[key] as string | undefined;
  const official = values.official === true;
  const isolation = oneOf("isolation", str("isolation") ?? (official ? "both" : "case"), [
    "case",
    "runtime",
    "both",
  ] as const);
  const order = oneOf("order", str("order") ?? "shuffle", ["shuffle", "fixed"] as const);
  const runs = positiveInt("runs", str("runs") ?? (official ? "3" : "1"));
  const cpus = str("cpus") ? parseCpuList(str("cpus")!) : null;

  if (official) {
    if (isolation !== "both") throw new Error("--official requires --isolation both");
    if (order !== "shuffle") throw new Error("--official requires --order shuffle");
    if (runs < 3) throw new Error("--official requires --runs 3 or more");
    if (!cpus) throw new Error("--official requires --cpus (CPU pinning via Linux taskset)");
  }
  if (cpus) {
    if (process.platform !== "linux") {
      throw new Error(`--cpus uses Linux taskset and is not supported on ${process.platform}`);
    }
    if (capture("taskset", ["--version"]) === null) throw new Error("--cpus requires taskset (util-linux)");
  }

  let seed = randomInt(2 ** 32 - 1);
  if (str("seed") !== undefined) {
    seed = Number(str("seed"));
    if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) throw new Error("--seed must be an integer in [0, 2^32)");
  }

  return {
    profile: official ? "official" : "standard",
    isolation,
    runs,
    order,
    seed,
    cpus,
    harness: {
      warmup: positiveInt("warmup", str("warmup") ?? "5"),
      samples: positiveInt("samples", str("samples") ?? "30"),
      sampleMs: positiveInt("sample-ms", str("sample-ms") ?? "20"),
    },
    filter: str("filter") ?? null,
    suites: str("suite") ? parseSuites(str("suite")!) : null,
  };
}

/**
 * Every repetition runs every unit once: one process per case for `case`
 * isolation, one process per runtime for `runtime` isolation. Shuffling the
 * units of each repetition keeps slow drifts (thermals, background load)
 * from always landing on the same runtime, case or mode.
 */
function schedule(plan: Plan, runtimes: string[], casesByRuntime: Record<string, string[]>): Unit[] {
  const random = mulberry32(plan.seed);
  const modes: Isolation[] = plan.isolation === "both" ? ["case", "runtime"] : [plan.isolation];
  const units: Unit[] = [];
  for (let run = 1; run <= plan.runs; run++) {
    const base = runtimes.flatMap((runtime) => {
      const groups = [...new Set(casesByRuntime[runtime].map(processGroupOf))];
      return modes.flatMap((isolation): Unit[] =>
        isolation === "case"
          ? casesByRuntime[runtime].map((caseId) => ({ run, runtime, isolation, group: processGroupOf(caseId), caseId }))
          : groups.map((group) => ({ run, runtime, isolation, group, caseId: null }))
      );
    });
    units.push(...(plan.order === "shuffle" ? shuffle(base, random) : base));
  }
  return units;
}

/** Merges per-runtime case lists into one order, keeping each list's relative order. */
function mergeCaseOrder(lists: string[][]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    let at = 0;
    for (const id of list) {
      const i = out.indexOf(id);
      if (i === -1) out.splice(at++, 0, id);
      else at = i + 1;
    }
  }
  return out;
}

function collectEnvironment(
  runId: string,
  plan: Plan,
  runtimes: Record<string, string | null>,
  caseIds: string[],
  casesByRuntime: Record<string, string[]>,
  native: ReturnType<typeof buildNative> & { scriptc?: ScriptcBuild },
  wasm: WasmBuild | null,
) {
  const rustc = capture("rustc", ["-vV"]) ?? "";
  const rustcField = (key: string) => rustc.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1] ?? null;
  const cpus = os.cpus();
  const system = probeSystem();
  const warnings = assessConditions(system, plan.cpus);
  return {
    runId,
    createdAt: new Date().toISOString(),
    finishedAt: null as string | null,
    cpu: { model: cpus[0]?.model ?? null, cores: cpus.length, arch: os.arch() },
    memoryBytes: os.totalmem(),
    os: { platform: os.platform(), type: os.type(), release: os.release(), version: os.version() },
    system,
    loadavg: { start: os.loadavg(), end: null as number[] | null },
    runtimes,
    rust: {
      rustc: rustcField("release"),
      commit: rustcField("commit-hash"),
      target: rustcField("host"),
      cargo: capture("cargo", ["--version"]),
      profile: "release",
      rustflags: process.env.RUSTFLAGS ?? null,
    },
    native,
    wasm,
    git: {
      commit: capture("git", ["rev-parse", "HEAD"]),
      dirty: capture("git", ["status", "--porcelain"]) !== "",
    },
    methodology: {
      profile: plan.profile,
      isolation: plan.isolation,
      runs: plan.runs,
      order: plan.order,
      seed: plan.seed,
      cpus: plan.cpus ? formatCpuList(plan.cpus) : null,
      pinning: plan.cpus ? { tool: capture("taskset", ["--version"]), command: ["taskset", "-c", formatCpuList(plan.cpus)] } : null,
      runtimeCommands: RUNTIME_COMMANDS,
      processGroupCommands: GROUP_COMMANDS,
      canonicalOrder: "cases run in canonical order within a shared process; see docs/methodology.md",
      filter: plan.filter,
      suites: plan.suites,
      cases: caseIds,
      casesByRuntime,
      equivalence: "checked in every process after measurement",
    },
    options: plan.harness,
    conditions: {
      warnings,
      officialCriteriaMet: false,
    },
    failedUnits: [] as (Unit & { sequence: number; status: number | null })[],
  };
}

function printWarnings(warnings: string[]): void {
  if (!warnings.length) return;
  console.error("\nrun conditions not suitable for official results (see docs/methodology.md):");
  for (const w of warnings) console.error(`  - ${w}`);
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      runtimes: { type: "string", default: Object.keys(RUNTIME_COMMANDS).join(",") },
      isolation: { type: "string" },
      runs: { type: "string" },
      order: { type: "string" },
      seed: { type: "string" },
      cpus: { type: "string" },
      official: { type: "boolean", default: false },
      warmup: { type: "string" },
      samples: { type: "string" },
      "sample-ms": { type: "string" },
      filter: { type: "string" },
      suite: { type: "string" },
    },
  });
  const plan = resolvePlan(values);
  const requested = values.runtimes.split(",").map((s) => s.trim()).filter(Boolean);
  for (const rt of requested) {
    if (!RUNTIME_COMMANDS[rt]) throw new Error(`unknown runtime "${rt}"`);
  }

  if (plan.cpus) {
    const online = new Set(probeSystem().onlineCpus);
    const offline = plan.cpus.filter((c) => !online.has(c));
    if (offline.length) throw new Error(`--cpus includes CPUs that are not online: ${formatCpuList(offline)}`);
  }

  const versions: Record<string, string | null> = {};
  for (const rt of requested) {
    versions[rt] = runtimeVersion(rt);
    if (versions[rt] === null) console.error(`skipping ${rt}: not found on PATH`);
  }
  const available = requested.filter((rt) => versions[rt] !== null);
  if (!available.length) throw new Error("no requested runtime is available");

  const native: ReturnType<typeof buildNative> & { scriptc?: ScriptcBuild } = buildNative();
  const wasm = available.some((rt) => rt !== "scriptc") ? buildWasm() : null;
  if (available.includes("scriptc")) native.scriptc = buildScriptc();

  // Each runtime lists the cases it supports (Node.js has no FFI path).
  const casesByRuntime: Record<string, string[]> = {};
  for (const rt of available) {
    // --list prints the cases of every process group, in canonical order.
    const [cmd, ...args] = RUNTIME_COMMANDS[rt];
    const listed = capture(cmd, [...args, "--list", ...selectionArgs(plan)]);
    if (listed === null) throw new Error(`${rt} failed to list its cases`);
    casesByRuntime[rt] = listed.split("\n").filter(Boolean);
    if (!casesByRuntime[rt].length) console.error(`skipping ${rt}: no case matches the selection`);
  }
  const runtimes = available.filter((rt) => casesByRuntime[rt].length);
  if (!runtimes.length) throw new Error("no case matches the selection (--filter / --suite)");
  const caseIds = mergeCaseOrder(runtimes.map((rt) => casesByRuntime[rt]));

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(ROOT, "results", "raw", runId);
  mkdirSync(outDir, { recursive: true });
  const environment = collectEnvironment(runId, plan, versions, caseIds, casesByRuntime, native, wasm);
  const writeEnvironment = () =>
    writeFileSync(join(outDir, "environment.json"), JSON.stringify(environment, null, 2) + "\n");
  writeEnvironment();

  const units = schedule(plan, runtimes, casesByRuntime);
  console.error(
    `\n${plan.profile} run ${runId}: ${units.length} processes, isolation ${plan.isolation}, ${plan.runs} run(s), ` +
      `order ${plan.order} (seed ${plan.seed}), cpus ${plan.cpus ? formatCpuList(plan.cpus) : "unpinned"}`,
  );
  printWarnings(environment.conditions.warnings);

  const harnessArgs = [
    "--warmup", String(plan.harness.warmup),
    "--samples", String(plan.harness.samples),
    "--sample-ms", String(plan.harness.sampleMs),
  ];
  const pinPrefix = plan.cpus ? ["taskset", "-c", formatCpuList(plan.cpus)] : [];
  // deno-lint-ignore no-explicit-any
  const files = new Map<string, any>();

  units.forEach((unit, index) => {
    const sequence = index + 1;
    const tmp = join(outDir, `.unit-${sequence}.json`);
    const selection = unit.caseId ? ["--case", unit.caseId] : selectionArgs(plan);
    const argv = [...pinPrefix, ...commandFor(unit.runtime, unit.group), ...harnessArgs, ...selection, "--out", tmp];
    const child = spawnSync(argv[0], argv.slice(1), { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const mode = plan.isolation === "both" ? ` ${unit.isolation.padEnd(7)}` : "";
    const group = unit.group === "default" ? "" : ` [${unit.group}]`;
    const label = `[${sequence}/${units.length}] run ${unit.run}${mode} ${unit.runtime.padEnd(4)}${group}`;

    if (child.status !== 0 || !existsSync(tmp)) {
      console.error(`${label} ${unit.caseId ?? "all cases"} FAILED (exit ${child.status})\n${child.stderr}`);
      environment.failedUnits.push({ ...unit, sequence, status: child.status });
      return;
    }
    const out = JSON.parse(readFileSync(tmp, "utf8"));
    rmSync(tmp);

    if (plan.cpus) {
      const affinityMatches = out.process.affinity === null ||
        formatCpuList(parseCpuList(out.process.affinity)) === formatCpuList(plan.cpus);
      if (out.process.allowedCpuCount !== plan.cpus.length || !affinityMatches) {
        throw new Error(
          `${unit.runtime} process was not pinned as requested: affinity ${out.process.affinity}, ` +
            `${out.process.allowedCpuCount} CPUs allowed, expected ${formatCpuList(plan.cpus)}`,
        );
      }
    }

    const file = files.get(unit.runtime) ?? {
      schema: RESULT_SCHEMA_VERSION,
      runtime: out.runtime,
      versions: out.versions,
      platform: out.platform,
      arch: out.arch,
      timer: out.timer,
      options: out.options,
      equivalence: out.equivalence,
      results: [],
    };
    const processInfo = { ...out.process, startedAt: out.startedAt, finishedAt: out.finishedAt };
    for (const r of out.results) {
      file.results.push({ ...r, run: unit.run, isolation: unit.isolation, sequence, process: processInfo });
      console.error(`${label} ${r.id.padEnd(22)} ${formatNs(r.ns_per_op.median).padStart(10)}/op`);
    }
    files.set(unit.runtime, file);
    writeFileSync(join(outDir, `${unit.runtime}.json`), JSON.stringify(file, null, 2) + "\n");
  });

  environment.finishedAt = new Date().toISOString();
  environment.loadavg.end = os.loadavg();
  environment.conditions.officialCriteriaMet = plan.profile === "official" &&
    environment.conditions.warnings.length === 0 && environment.failedUnits.length === 0;
  writeEnvironment();

  const runSets = runtimes.filter((rt) => files.has(rt))
    .flatMap((rt) => splitRuns(runId, rt, files.get(rt).results as StoredResult[], "case"));
  const variances = caseVariance(runSets, caseIds);
  const modeTitles: Record<Isolation, string> = {
    case: "fresh process per case",
    runtime: "shared process per runtime (canonical case order)",
  };
  for (const isolation of ["case", "runtime"] as const) {
    const subset = variances.filter((v) => v.isolation === isolation);
    if (subset.length) printSummary(subset, plan.runs, plan.isolation === "both" ? modeTitles[isolation] : null);
  }
  if (plan.runs > 1) {
    console.log("\nrun-to-run variance (per-run medians):");
    printVariance(variances);
  }
  printDivergences(variances);

  if (plan.profile === "official") {
    printWarnings(environment.conditions.warnings);
    console.error(
      environment.conditions.officialCriteriaMet
        ? "\nofficial criteria met"
        : "\nofficial criteria NOT met; do not publish these numbers as official",
    );
  } else if (environment.conditions.warnings.length) {
    console.error(`\n${environment.conditions.warnings.length} run-condition warning(s) recorded in environment.json`);
  }
  console.error(`raw results: ${outDir}`);
  if (environment.failedUnits.length) {
    console.error(`failed units: ${environment.failedUnits.length}`);
    process.exit(1);
  }
}

main();
