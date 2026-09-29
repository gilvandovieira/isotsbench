// Runs the browser matrix: builds the WASM artifacts, records the environment
// and run conditions, opens bench/browser/ in a fresh headless browser for
// every scheduled unit (sequentially, never in parallel) and prints a
// summary. Main-thread and Worker results are kept apart everywhere: separate
// pages, separate result files (`<browser>.main.json`, `<browser>.worker.json`)
// and separate tables.
//
//   node scripts/bench-browser.ts [options]
//
//   --browsers chromium,firefox  browsers to run (missing ones are skipped;
//                                CHROMIUM_PATH / FIREFOX_PATH select a binary)
//   --threads main,worker        which thread's cases to run (default both)
//   --isolation case|runtime|both
//                                fresh browser per case (default), one shared page per
//                                browser and thread, or both in the same shuffled repetitions
//   --runs N  --order shuffle|fixed  --seed N  --cpus LIST  --official
//   --warmup N --samples N --sample-ms N --filter TEXT
//   --timeout-s N                per-page limit (default 900)
//
// Raw output: results/raw/<run-id>/{environment,<browser>.main,<browser>.worker}.json

import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { caseGroup, formatNs, table } from "../bench/common/format.ts";
import { SUM_I32_SIZES } from "../bench/common/payloads.ts";
import { WORKER_CONFIG } from "../bench/browser/worker-cases.ts";
import {
  type Browser,
  BROWSER_NAMES,
  type BrowserName,
  commandTemplate,
  engineVersion,
  findBrowser,
  FIREFOX_PREFS,
  RESPONSE_HEADERS,
  runPage,
  startServer,
} from "./browser.ts";
import { buildWasm, type WasmBuild } from "./build.ts";
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

type Thread = "main" | "worker";
const THREADS: readonly Thread[] = ["main", "worker"];

interface Plan {
  profile: "official" | "standard";
  isolation: Isolation | "both";
  runs: number;
  order: "shuffle" | "fixed";
  seed: number;
  cpus: number[] | null;
  harness: { warmup: number; samples: number; sampleMs: number };
  filter: string | null;
  threads: Thread[];
  timeoutMs: number;
}

interface Unit {
  run: number;
  browser: BrowserName;
  thread: Thread;
  isolation: Isolation;
  /** null: one page running every selected case of its thread in canonical order. */
  caseId: string | null;
}

/** What a page reports about itself in list mode (see bench/browser/page.ts). */
// deno-lint-ignore no-explicit-any
type PageInfo = any;

interface Listing {
  info: PageInfo;
  workerWasm: { sha256: string | null; error: string | null };
  main: string[];
  worker: string[];
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

function listOf<T extends string>(name: string, value: string, allowed: readonly T[]): T[] {
  const items = value.split(",").map((s) => s.trim()).filter(Boolean).map((v) => oneOf(name, v, allowed));
  if (!items.length) throw new Error(`--${name} is empty`);
  return [...new Set(items)];
}

function resolvePlan(values: Record<string, string | boolean | undefined>): Plan {
  const str = (key: string) => values[key] as string | undefined;
  const official = values.official === true;
  const isolation = oneOf("isolation", str("isolation") ?? (official ? "both" : "case"), ["case", "runtime", "both"] as const);
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
    if (process.platform !== "linux") throw new Error(`--cpus uses Linux taskset and is not supported on ${process.platform}`);
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
    threads: listOf("threads", str("threads") ?? THREADS.join(","), THREADS),
    timeoutMs: positiveInt("timeout-s", str("timeout-s") ?? "900") * 1000,
  };
}

/** As scripts/bench.ts: every repetition runs every unit once, shuffled with the recorded seed. */
function schedule(plan: Plan, casesByRuntime: Map<string, { browser: BrowserName; thread: Thread; ids: string[] }>): Unit[] {
  const random = mulberry32(plan.seed);
  const modes: Isolation[] = plan.isolation === "both" ? ["case", "runtime"] : [plan.isolation];
  const units: Unit[] = [];
  for (let run = 1; run <= plan.runs; run++) {
    const base = [...casesByRuntime.values()].flatMap(({ browser, thread, ids }) =>
      modes.flatMap((isolation): Unit[] =>
        isolation === "case"
          ? ids.map((caseId) => ({ run, browser, thread, isolation, caseId }))
          : [{ run, browser, thread, isolation, caseId: null }]
      )
    );
    units.push(...(plan.order === "shuffle" ? shuffle(base, random) : base));
  }
  return units;
}

/** Target features recorded by the compiler in the module's `target_features` custom section. */
function targetFeatures(path: string): string[] {
  const module = new WebAssembly.Module(readFileSync(join(ROOT, path)));
  const [section] = WebAssembly.Module.customSections(module, "target_features");
  if (!section) return [];
  const bytes = new Uint8Array(section);
  let at = 0;
  const leb = () => {
    let value = 0;
    for (let shift = 0;; shift += 7) {
      const byte = bytes[at++];
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value >>> 0;
    }
  };
  const features: string[] = [];
  for (let count = leb(); count > 0; count--) {
    const prefix = String.fromCharCode(bytes[at++]);
    const length = leb();
    features.push(prefix + new TextDecoder().decode(bytes.subarray(at, at + length)));
    at += length;
  }
  return features;
}

/** A page and its Worker must have fetched exactly the artifacts that were built and recorded. */
function verifyArtifacts(
  browser: BrowserName,
  page: { variant: string; sha256: string | null }[],
  worker: { sha256: string | null } | null,
  wasm: WasmBuild,
): void {
  const built: Record<string, string> = { default: wasm.default.artifact.sha256, simd128: wasm.simd128.artifact.sha256 };
  for (const artifact of page) {
    if (artifact.sha256 !== built[artifact.variant]) {
      throw new Error(`${browser} fetched ${artifact.variant} WASM with SHA-256 ${artifact.sha256}, built ${built[artifact.variant]}`);
    }
  }
  if (worker && worker.sha256 !== built.default) {
    throw new Error(`${browser} Worker fetched WASM with SHA-256 ${worker.sha256}, built ${built.default}`);
  }
}

/** Browser-specific reasons a run is unsuitable as an official result. */
function browserWarnings(browser: BrowserName, info: PageInfo, sampleMs: number): string[] {
  const warnings: string[] = [];
  if (!info.crossOriginIsolated) {
    warnings.push(`${browser}: the page is not cross-origin isolated, so performance.now runs at reduced resolution`);
  }
  // 0.1% of a batch: the same bound as the other clocks give by a wide margin.
  if (info.timer.minNs > sampleMs * 1e6 * 0.001) {
    warnings.push(`${browser}: performance.now steps ${info.timer.minNs} ns, more than 0.1% of a ${sampleMs} ms batch`);
  }
  for (const artifact of info.wasm) {
    if (artifact.error) warnings.push(`${browser}: ${artifact.variant} WASM unavailable (${artifact.error})`);
  }
  return warnings;
}

/**
 * Worker costs, per browser and size, as differences of medians inside the
 * Worker results: the round trip of `noop/worker.ts` (messaging only), the
 * compute behind it (resident − round trip) and what each way of moving the
 * input adds (strategy − resident). Differences of independent medians are
 * approximate and can come out negative.
 */
function printWorkerDecomposition(variances: CaseVariance[]): void {
  const runtimes = [...new Set(variances.map((v) => v.runtime))].filter((rt) => rt.endsWith(".worker"));
  for (const rt of runtimes) {
    const mine = variances.filter((v) => v.runtime === rt);
    const median = (id: string) => mine.find((v) => v.id === id)?.median;
    const roundTrip = median("noop/worker.ts");
    if (roundTrip === undefined) continue;
    const signed = (ns: number | undefined) => (ns === undefined ? "-" : ns < 0 ? `−${formatNs(-ns)}` : `+${formatNs(ns)}`);
    const rows = SUM_I32_SIZES.flatMap((size) =>
      (["ts", "wasm"] as const).map((impl) => {
        const at = (strategy: string) => median(`sum_i32/worker.${impl}.${strategy}/${size}`);
        const resident = at("resident");
        const delta = (strategy: string) => {
          const value = at(strategy);
          return value === undefined || resident === undefined ? undefined : value - resident;
        };
        return [
          `${size}`,
          impl,
          resident === undefined ? "-" : formatNs(resident),
          signed(resident === undefined ? undefined : resident - roundTrip),
          signed(delta("clone")),
          signed(delta("copy")),
          signed(delta("transfer")),
        ];
      })
    ).filter((row) => row[2] !== "-");
    if (!rows.length) continue;
    console.log(`\n${rt}: Worker cost decomposition (differences of medians; round trip noop/worker.ts = ${formatNs(roundTrip)})`);
    console.log(table(["sum_i32 size", "impl", "resident", "compute (resident − rt)", "clone − resident", "copy − resident", "transfer − resident"], rows));
  }
}

function printWarnings(warnings: string[]): void {
  if (!warnings.length) return;
  console.error("\nrun conditions not suitable for official results (see docs/methodology.md):");
  for (const w of warnings) console.error(`  - ${w}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      browsers: { type: "string", default: BROWSER_NAMES.join(",") },
      threads: { type: "string" },
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
      "timeout-s": { type: "string" },
    },
  });
  const plan = resolvePlan(values);
  const requested = listOf("browsers", values.browsers, BROWSER_NAMES);
  if (plan.cpus) {
    const online = new Set(probeSystem().onlineCpus);
    const offline = plan.cpus.filter((c) => !online.has(c));
    if (offline.length) throw new Error(`--cpus includes CPUs that are not online: ${formatCpuList(offline)}`);
  }

  const browsers: Browser[] = [];
  for (const name of requested) {
    const browser = findBrowser(name);
    if (browser) browsers.push(browser);
    else console.error(`skipping ${name}: not found (set ${name.toUpperCase()}_PATH or put it on PATH)`);
  }
  if (!browsers.length) throw new Error("no requested browser is available");

  const wasm = buildWasm();
  if (!wasm) throw new Error("the browser paths need the WASM artifacts: rustup target add wasm32-unknown-unknown");

  const server = await startServer();
  const pinPrefix = plan.cpus ? ["taskset", "-c", formatCpuList(plan.cpus)] : [];
  try {
    // One list-mode page per browser: case ids in canonical order, page metadata, fetched artifact hashes.
    const listings = new Map<BrowserName, Listing>();
    const engines: Record<string, { version: string | null; source: string }> = {};
    for (const browser of browsers) {
      const { data } = await runPage(browser, server, new URLSearchParams({ mode: "list" }), { timeoutMs: plan.timeoutMs });
      const listing = data as Listing;
      verifyArtifacts(browser.name, listing.info.wasm, listing.workerWasm, wasm);
      listings.set(browser.name, listing);
      engines[browser.name] = await engineVersion(browser);
    }

    const selected = (id: string) => !plan.filter || id.includes(plan.filter);
    const casesByRuntime = new Map<string, { browser: BrowserName; thread: Thread; ids: string[] }>();
    for (const browser of browsers) {
      for (const thread of plan.threads) {
        const ids = listings.get(browser.name)![thread].filter(selected);
        if (ids.length) casesByRuntime.set(`${browser.name}.${thread}`, { browser: browser.name, thread, ids });
      }
    }
    if (!casesByRuntime.size) throw new Error("no case matches the selection (--filter / --threads)");

    const system = probeSystem();
    const warnings = [
      ...assessConditions(system, plan.cpus),
      ...browsers.flatMap((b) => browserWarnings(b.name, listings.get(b.name)!.info, plan.harness.sampleMs)),
    ];
    const rustc = capture("rustc", ["-vV"]) ?? "";
    const cpus = os.cpus();
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = join(ROOT, "results", "raw", runId);
    mkdirSync(outDir, { recursive: true });
    const environment = {
      runId,
      kind: "browser",
      createdAt: new Date().toISOString(),
      finishedAt: null as string | null,
      cpu: { model: cpus[0]?.model ?? null, cores: cpus.length, arch: os.arch() },
      memoryBytes: os.totalmem(),
      os: { platform: os.platform(), type: os.type(), release: os.release(), version: os.version() },
      system,
      loadavg: { start: os.loadavg(), end: null as number[] | null },
      // One entry per result file, so scripts/compare.ts reads browser runs like runtime runs.
      runtimes: Object.fromEntries([...casesByRuntime].map(([rt, { browser }]) => [rt, browsers.find((b) => b.name === browser)!.version])),
      browsers: Object.fromEntries(browsers.map((b) => [b.name, {
        path: b.path,
        version: b.version,
        engine: { name: b.engine, ...engines[b.name] },
        command: [...pinPrefix, ...commandTemplate(b)],
        ...(b.name === "firefox" ? { prefs: FIREFOX_PREFS } : {}),
        page: listings.get(b.name)!.info,
        workerWasm: listings.get(b.name)!.workerWasm,
      }])),
      server: {
        node: process.version,
        origin: "http://127.0.0.1:<ephemeral port>",
        headers: RESPONSE_HEADERS,
        typescript: "node:module stripTypeScriptTypes, mode strip (type erasure only, no bundling)",
      },
      rust: { rustc: rustc.match(/^release: (.*)$/m)?.[1] ?? null, cargo: capture("cargo", ["--version"]), rustflags: process.env.RUSTFLAGS ?? null },
      wasm: {
        ...wasm,
        targetFeatures: { default: targetFeatures(wasm.default.artifact.path), simd128: targetFeatures(wasm.simd128.artifact.path) },
      },
      git: { commit: capture("git", ["rev-parse", "HEAD"]), dirty: capture("git", ["status", "--porcelain"]) !== "" },
      methodology: {
        profile: plan.profile,
        isolation: plan.isolation,
        isolationMeaning: { case: "a fresh browser and profile per case", runtime: "one page per browser and thread, cases in canonical order" },
        runs: plan.runs,
        order: plan.order,
        seed: plan.seed,
        cpus: plan.cpus ? formatCpuList(plan.cpus) : null,
        pinning: plan.cpus ? { tool: capture("taskset", ["--version"]), command: pinPrefix, scope: "the whole browser process group" } : null,
        threads: plan.threads,
        filter: plan.filter,
        cases: [...new Set([...casesByRuntime.values()].flatMap((c) => c.ids))],
        casesByRuntime: Object.fromEntries([...casesByRuntime].map(([rt, c]) => [rt, c.ids])),
        timing: "performance.now on the page's main thread; Worker cases time whole batches of sequential round trips",
        worker: WORKER_CONFIG,
        equivalence: "checked in every page after measurement, for the thread it measured",
      },
      options: plan.harness,
      conditions: { warnings, officialCriteriaMet: false },
      failedUnits: [] as (Unit & { sequence: number; error: string })[],
    };
    const writeEnvironment = () => writeFileSync(join(outDir, "environment.json"), JSON.stringify(environment, null, 2) + "\n");
    writeEnvironment();

    const units = schedule(plan, casesByRuntime);
    console.error(
      `\n${plan.profile} browser run ${runId}: ${units.length} pages, isolation ${plan.isolation}, ${plan.runs} run(s), ` +
        `order ${plan.order} (seed ${plan.seed}), cpus ${plan.cpus ? formatCpuList(plan.cpus) : "unpinned"}`,
    );
    printWarnings(warnings);

    // deno-lint-ignore no-explicit-any
    const files = new Map<string, any>();
    for (const [index, unit] of units.entries()) {
      const sequence = index + 1;
      const runtime = `${unit.browser}.${unit.thread}`;
      const browser = browsers.find((b) => b.name === unit.browser)!;
      const query = new URLSearchParams({
        mode: "bench",
        thread: unit.thread,
        warmup: String(plan.harness.warmup),
        samples: String(plan.harness.samples),
        "sample-ms": String(plan.harness.sampleMs),
      });
      if (unit.caseId) query.set("case", unit.caseId);
      else if (plan.filter) query.set("filter", plan.filter);
      const mode = plan.isolation === "both" ? ` ${unit.isolation.padEnd(7)}` : "";
      const label = `[${sequence}/${units.length}] run ${unit.run}${mode} ${runtime.padEnd(15)}`;

      let page;
      try {
        page = await runPage(browser, server, query, { timeoutMs: plan.timeoutMs, pinPrefix });
        // deno-lint-ignore no-explicit-any
        const posted = page.data as any;
        verifyArtifacts(browser.name, posted.info.wasm, posted.worker?.wasm ?? null, wasm);
      } catch (error) {
        console.error(`${label} ${unit.caseId ?? "all cases"} FAILED: ${error instanceof Error ? error.message : error}`);
        environment.failedUnits.push({ ...unit, sequence, error: String(error) });
        continue;
      }
      if (plan.cpus) {
        const expected = formatCpuList(plan.cpus);
        const wrong = page.affinity!.filter((list) => formatCpuList(parseCpuList(list)) !== expected);
        if (!page.affinity!.length || wrong.length) {
          throw new Error(`${browser.name} was not pinned as requested: ${page.affinity!.join(" | ")}, expected ${expected}`);
        }
      }
      // deno-lint-ignore no-explicit-any
      const out = page.data as any;
      const file = files.get(runtime) ?? {
        schema: RESULT_SCHEMA_VERSION,
        runtime,
        browser: browser.name,
        thread: unit.thread,
        versions: { browser: browser.version, engine: environment.browsers[browser.name].engine, userAgent: out.info.userAgent },
        platform: os.platform(),
        arch: os.arch(),
        timer: out.info.timer,
        crossOriginIsolated: out.info.crossOriginIsolated,
        options: out.options,
        worker: out.worker,
        equivalence: "checked after measurement, for the thread of the measured cases",
        results: [],
      };
      const processInfo = {
        pid: page.pid,
        command: page.command.map((arg) => arg.replace(/token=[^&]+/, "token=<unit>")),
        affinity: page.affinity,
        launchAttempts: page.launchAttempts,
        startedAt: out.startedAt,
        finishedAt: out.finishedAt,
      };
      for (const r of out.results) {
        file.results.push({ ...r, run: unit.run, isolation: unit.isolation, sequence, process: processInfo });
        console.error(`${label} ${r.id.padEnd(34)} ${formatNs(r.ns_per_op.median).padStart(10)}/op`);
      }
      files.set(runtime, file);
      writeFileSync(join(outDir, `${runtime}.json`), JSON.stringify(file, null, 2) + "\n");
    }

    environment.finishedAt = new Date().toISOString();
    environment.loadavg.end = os.loadavg();
    environment.conditions.officialCriteriaMet = plan.profile === "official" && warnings.length === 0 &&
      environment.failedUnits.length === 0;
    writeEnvironment();

    const runSets = [...files].flatMap(([rt, file]) => splitRuns(runId, rt, file.results as StoredResult[], "case"));
    const variances = caseVariance(runSets, environment.methodology.cases);
    const modeTitles: Record<Isolation, string> = {
      case: "fresh browser per case",
      runtime: "shared page per browser and thread (canonical case order)",
    };
    for (const isolation of ["case", "runtime"] as const) {
      const subset = variances.filter((v) => v.isolation === isolation);
      if (!subset.length) continue;
      if (plan.isolation === "both") console.log(`\n${modeTitles[isolation]}:`);
      for (const thread of plan.threads) {
        const mine = subset.filter((v) => v.runtime.endsWith(`.${thread}`));
        if (!mine.length) continue;
        console.log(`\n### ${thread === "main" ? "main thread" : "main → Worker → main"}`);
        printSummary(mine, plan.runs, null);
        if (thread === "worker") printWorkerDecomposition(mine);
      }
    }
    if (plan.runs > 1) {
      console.log("\nrun-to-run variance (per-run medians):");
      printVariance(variances);
    }
    printDivergences(variances);

    if (plan.profile === "official") {
      printWarnings(warnings);
      console.error(environment.conditions.officialCriteriaMet ? "\nofficial criteria met" : "\nofficial criteria NOT met; do not publish these numbers as official");
    } else if (warnings.length) {
      console.error(`\n${warnings.length} run-condition warning(s) recorded in environment.json`);
    }
    console.error(`raw results: ${outDir}`);
    if (environment.failedUnits.length) {
      console.error(`failed units: ${environment.failedUnits.length}`);
      process.exitCode = 1;
    }
  } finally {
    await server.close();
  }
}

await main();
