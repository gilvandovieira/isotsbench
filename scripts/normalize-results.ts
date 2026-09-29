// Normalized dataset from the committed official runs.
//
//   node scripts/normalize-results.ts [--out <dir>]
//
// Reads the run directories in OFFICIAL_RUNS (never writes to them) and writes
// results.json, results.csv and metadata.json to results/normalized/ (or --out).
// One record per source run, environment, isolation mode and case id: fresh
// (`case`) and shared (`runtime`) results stay separate, and case ids are never
// merged. Statistics use the same definitions as `make compare`
// (scripts/compare.ts). The output holds no timestamps of its own, so the same
// inputs always produce byte-identical files.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  caseVariance,
  divergences,
  type Isolation,
  type RunSet,
  splitRuns,
  type StoredResult,
  UNSTABLE_SPREAD,
} from "./compare.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The runs listed under "Official results" in docs/findings.md, relative to the repository root. */
export const OFFICIAL_RUNS = [
  "results/raw/2026-09-29T10-24-40-196Z",
  "results/raw/2026-09-29T11-49-48-358Z",
];

export const SCHEMA = 1;

// deno-lint-ignore no-explicit-any
type Json = any;

/** Where one per-run median comes from: `results[index]` of `file`. */
export interface RunPointer {
  run: number;
  median_ns: number;
  file: string;
  index: number;
  sequence: number | null;
}

export interface NormalizedResult {
  /** Unique: `<source>/<environment>/<isolation>/<id>`. */
  key: string;
  /** Run directory id under results/raw/. */
  source: string;
  /** The raw file's `runtime`: node, bun, deno, scriptc, or <browser>.<thread>. */
  environment: string;
  kind: "runtime" | "browser";
  runtime: string | null;
  browser: string | null;
  thread: string | null;
  version: string;
  suite: string;
  op: string;
  id: string;
  /** The path segment of the id, e.g. "napi", "wasm.copy", "worker.wasm.transfer". */
  path: string;
  impl: string;
  binding: string | null;
  strategy: string | null;
  ownership: string | null;
  variant: string | null;
  size: number | null;
  payload_kind: string | null;
  payload_bytes: number | null;
  payload_count: number | null;
  /** "case": fresh process or browser per case; "runtime": shared process, or page per browser and thread. */
  isolation: Isolation;
  runs: RunPointer[];
  run_count: number;
  /** Median of the per-run medians, ns per operation. Report the range instead when `stability` is "unstable". */
  median_ns: number;
  min_run_ns: number;
  max_run_ns: number;
  /** (max - min) / median of the per-run medians. */
  spread: number;
  stability: "stable" | "unstable";
  /** Fresh and shared per-run medians don't overlap and differ by more than 5%; null when only one mode ran. */
  divergent: boolean | null;
  official: boolean;
}

interface Source {
  root: string;
  dir: string;
  id: string;
  environment: Json;
  files: { environment: string; path: string; sha256: string; header: Json; results: StoredResult[] }[];
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Loads a run directory and refuses anything that is not a clean official run. */
export function loadSource(dir: string, root = ROOT): Source {
  const abs = join(root, dir);
  const envPath = join(abs, "environment.json");
  if (!existsSync(envPath)) throw new Error(`${dir}: no environment.json`);
  const environment = JSON.parse(readFileSync(envPath, "utf8"));
  const problems = [
    environment.conditions?.officialCriteriaMet !== true && "conditions.officialCriteriaMet is not true",
    (environment.conditions?.warnings ?? []).length > 0 && "condition warnings present",
    (environment.failedUnits ?? []).length > 0 && "failed units present",
    environment.git?.dirty !== false && "git tree dirty or unknown",
  ].filter(Boolean);
  if (problems.length) throw new Error(`${dir}: not an official run: ${problems.join("; ")}`);

  const files = Object.keys(environment.runtimes).map((name) => {
    const path = join(abs, `${name}.json`);
    if (!existsSync(path)) throw new Error(`${dir}: missing ${name}.json`);
    const bytes = readFileSync(path);
    const { results, ...header } = JSON.parse(bytes.toString("utf8"));
    return { environment: name, path: relative(root, path), sha256: sha256(bytes), header, results };
  });
  return { root, dir, id: environment.runId, environment, files };
}

function describe(source: Source, environment: string) {
  const header = source.files.find((f) => f.environment === environment)!.header;
  const browser = header.browser ?? null;
  return {
    kind: (source.environment.kind === "browser" ? "browser" : "runtime") as NormalizedResult["kind"],
    runtime: browser ? null : environment,
    browser,
    thread: header.thread ?? null,
    version: String(source.environment.runtimes[environment]),
  };
}

export function normalize(sources: Source[]): NormalizedResult[] {
  const out: NormalizedResult[] = [];
  for (const source of sources) {
    const runSets: RunSet[] = source.files.flatMap((f) => splitRuns(source.id, f.environment, f.results, "case"));
    const variances = caseVariance(runSets, source.environment.methodology?.cases ?? []);
    const divergent = new Set(divergences(variances).map((d) => `${d.runtime}\t${d.id}`));
    const bothModes = new Set(variances.map((v) => v.isolation)).size > 1;

    for (const v of variances) {
      const file = source.files.find((f) => f.environment === v.runtime)!;
      const pointers = file.results
        .map((r, index) => ({ r, index }))
        .filter(({ r }) => r.id === v.id && (r.isolation ?? "case") === v.isolation)
        .map(({ r, index }) => ({
          run: r.run ?? 1,
          median_ns: r.ns_per_op.median,
          file: file.path,
          index,
          sequence: r.sequence ?? null,
        }))
        .sort((a, b) => a.run - b.run);
      const first = file.results[pointers[0].index];
      out.push({
        key: `${source.id}/${v.runtime}/${v.isolation}/${v.id}`,
        source: source.id,
        environment: v.runtime,
        ...describe(source, v.runtime),
        suite: v.suite,
        op: v.op,
        id: v.id,
        path: v.id.split("/")[1],
        impl: v.impl,
        binding: first.binding ?? null,
        strategy: v.strategy,
        ownership: first.ownership ?? null,
        variant: first.variant ?? null,
        size: v.size,
        payload_kind: first.payload?.kind ?? null,
        payload_bytes: first.payload?.bytes ?? null,
        payload_count: first.payload?.count ?? null,
        isolation: v.isolation,
        runs: pointers,
        run_count: pointers.length,
        median_ns: v.median,
        min_run_ns: v.min,
        max_run_ns: v.max,
        spread: v.spread,
        stability: v.spread > UNSTABLE_SPREAD ? "unstable" : "stable",
        divergent: bothModes ? divergent.has(`${v.runtime}\t${v.id}`) : null,
        official: source.environment.conditions.officialCriteriaMet === true,
      });
    }
  }
  return out;
}

/** Throws on schema or count errors: every expected case, mode and run present exactly once, and nothing else. */
export function validate(results: NormalizedResult[], sources: Source[]): void {
  const errors: string[] = [];
  const byKey = new Map<string, NormalizedResult>();
  for (const r of results) {
    if (byKey.has(r.key)) errors.push(`duplicate key ${r.key}`);
    byKey.set(r.key, r);
  }
  for (const source of sources) {
    const m = source.environment.methodology;
    const modes: Isolation[] = m.isolation === "both" ? ["case", "runtime"] : [m.isolation];
    const runs: number = m.runs;
    for (const file of source.files) {
      const expected: string[] = m.casesByRuntime[file.environment];
      if (file.results.length !== expected.length * modes.length * runs) {
        errors.push(
          `${file.path}: ${file.results.length} raw results, expected ${expected.length} × ${modes.length} × ${runs}`,
        );
      }
      for (const id of expected) {
        for (const isolation of modes) {
          const r = byKey.get(`${source.id}/${file.environment}/${isolation}/${id}`);
          if (!r) {
            errors.push(`${source.id} ${file.environment} ${isolation} ${id}: missing`);
            continue;
          }
          const runNumbers = r.runs.map((p) => p.run).join(",");
          const wanted = Array.from({ length: runs }, (_, i) => i + 1).join(",");
          if (runNumbers !== wanted) errors.push(`${r.key}: runs ${runNumbers}, expected ${wanted}`);
        }
      }
    }
    const inSource = results.filter((r) => r.source === source.id).length;
    const total = source.files.reduce((n, f) => n + m.casesByRuntime[f.environment].length * modes.length, 0);
    if (inSource !== total) errors.push(`${source.id}: ${inSource} records, expected ${total}`);
  }
  for (const r of results) {
    const values = r.runs.map((p) => p.median_ns);
    if (r.run_count !== r.runs.length) errors.push(`${r.key}: run_count ${r.run_count} ≠ ${r.runs.length}`);
    if (!values.every((x) => Number.isFinite(x) && x > 0)) {
      errors.push(`${r.key}: non-positive or non-finite run median`);
    }
    if (!(r.min_run_ns <= r.median_ns && r.median_ns <= r.max_run_ns)) {
      errors.push(`${r.key}: median outside run range`);
    }
    if (r.min_run_ns !== Math.min(...values) || r.max_run_ns !== Math.max(...values)) {
      errors.push(`${r.key}: range ≠ runs`);
    }
    if ((r.spread > UNSTABLE_SPREAD) !== (r.stability === "unstable")) errors.push(`${r.key}: stability ≠ spread`);
    if (r.id.split("/")[0] !== r.op || r.path !== r.id.split("/")[1]) errors.push(`${r.key}: op/path ≠ id`);
    if (r.official !== true) errors.push(`${r.key}: not official`);
  }
  if (errors.length) throw new Error(`normalized data failed validation:\n  ${errors.slice(0, 20).join("\n  ")}`);
}

const CSV_COLUMNS = [
  "key",
  "source",
  "environment",
  "kind",
  "runtime",
  "browser",
  "thread",
  "version",
  "suite",
  "op",
  "id",
  "path",
  "impl",
  "binding",
  "strategy",
  "ownership",
  "variant",
  "size",
  "payload_kind",
  "payload_bytes",
  "payload_count",
  "isolation",
  "run_count",
] as const;
const CSV_STATS = ["median_ns", "min_run_ns", "max_run_ns", "spread", "stability", "divergent", "official"] as const;

const csvField = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** One row per record; per-run medians as run1_ns … runN_ns. */
export function toCsv(results: NormalizedResult[]): string {
  const maxRuns = Math.max(...results.map((r) => r.runs.length));
  const runCols = Array.from({ length: maxRuns }, (_, i) => `run${i + 1}_ns`);
  const lines = [[...CSV_COLUMNS, ...runCols, ...CSV_STATS].join(",")];
  for (const r of results) {
    const byRun = runCols.map((_, i) => r.runs.find((p) => p.run === i + 1)?.median_ns ?? null);
    lines.push([...CSV_COLUMNS.map((c) => r[c]), ...byRun, ...CSV_STATS.map((c) => r[c])].map(csvField).join(","));
  }
  return lines.join("\n") + "\n";
}

export function metadata(results: NormalizedResult[], sources: Source[]): Json {
  const env = (s: Source) => s.environment;
  return {
    schema: SCHEMA,
    generator: "scripts/normalize-results.ts",
    command: "node scripts/normalize-results.ts",
    definitions: {
      unit: "nanoseconds per operation",
      run_median: "a run's `ns_per_op.median` for the case: median over its measured batches",
      median_ns: "median of the per-run medians",
      spread: "(max - min) / median of the per-run medians",
      stability: `unstable when spread > ${UNSTABLE_SPREAD}; report min_run_ns to max_run_ns, not median_ns`,
      divergent: `fresh and shared per-run medians do not overlap and differ by more than ${UNSTABLE_SPREAD * 100}%`,
      isolation: {
        case: "fresh process (or browser) per case",
        runtime: "one shared process per runtime (or page per browser and thread), cases in canonical order",
      },
      path:
        "the second segment of the case id; paths with different semantics have different names and are never merged",
      runs: "each per-run median points to results[index] of a raw file under results/raw/",
    },
    counts: {
      records: results.length,
      unstable: results.filter((r) => r.stability === "unstable").length,
      divergent_cases:
        new Set(results.filter((r) => r.divergent).map((r) => `${r.source}/${r.environment}/${r.id}`)).size,
      by_source: Object.fromEntries(sources.map((s) => [s.id, results.filter((r) => r.source === s.id).length])),
    },
    sources: sources.map((s) => ({
      id: s.id,
      directory: s.dir,
      kind: env(s).kind === "browser" ? "browser" : "runtime",
      created_at: env(s).createdAt,
      finished_at: env(s).finishedAt,
      git: env(s).git,
      official_criteria_met: env(s).conditions.officialCriteriaMet,
      condition_warnings: env(s).conditions.warnings,
      failed_units: env(s).failedUnits.length,
      options: env(s).options,
      methodology: {
        profile: env(s).methodology.profile,
        isolation: env(s).methodology.isolation,
        runs: env(s).methodology.runs,
        order: env(s).methodology.order,
        seed: env(s).methodology.seed,
        cpus: env(s).methodology.cpus,
        pinning: env(s).methodology.pinning,
      },
      machine: {
        cpu: env(s).cpu,
        memory_bytes: env(s).memoryBytes,
        os: env(s).os,
        cpu_classes: env(s).system?.cpuClasses,
        scaling_driver: env(s).system?.scalingDriver,
        no_turbo: env(s).system?.intelPstate?.noTurbo ?? null,
        platform_profile: env(s).system?.platformProfile ?? null,
        pinned_cpus: (env(s).system?.cpus ?? [])
          .filter((c: Json) => String(env(s).methodology.cpus).split(",").map(Number).includes(c.cpu))
          .map((c: Json) => ({
            cpu: c.cpu,
            core_type: c.coreType,
            governor: c.governor,
            epp: c.energyPerformancePreference,
          })),
      },
      software: {
        environments: env(s).runtimes,
        browsers: env(s).browsers
          ? Object.fromEntries(
            Object.entries(env(s).browsers).map((
              [name, b]: [string, Json],
            ) => [name, { version: b.version, engine: b.engine }]),
          )
          : null,
        rust: env(s).rust,
        native: env(s).native ?? null,
        wasm: env(s).wasm
          ? { target: env(s).wasm.target, default: env(s).wasm.default.artifact, simd128: env(s).wasm.simd128.artifact }
          : null,
      },
      files: [
        {
          path: join(s.dir, "environment.json"),
          sha256: sha256(readFileSync(join(s.root, s.dir, "environment.json"))),
        },
        ...s.files.map((f) => ({ path: f.path, sha256: f.sha256, raw_results: f.results.length })),
      ],
    })),
  };
}

export function generate(
  dirs: string[] = OFFICIAL_RUNS,
  root = ROOT,
): { results: NormalizedResult[]; files: Record<string, string> } {
  const sources = dirs.map((dir) => loadSource(dir, root));
  const results = normalize(sources);
  validate(results, sources);
  return {
    results,
    files: {
      "results.json": JSON.stringify(results, null, 1) + "\n",
      "results.csv": toCsv(results),
      "metadata.json": JSON.stringify(metadata(results, sources), null, 2) + "\n",
    },
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex === -1 ? join(ROOT, "results", "normalized") : args[outIndex + 1];
  if (outIndex !== -1 && !out) throw new Error("--out needs a directory");
  const { results, files } = generate();
  mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(out, name), content);
  const unstable = results.filter((r) => r.stability === "unstable").length;
  console.error(`wrote ${results.length} records (${unstable} unstable) from ${OFFICIAL_RUNS.length} runs to ${out}`);
}

if (import.meta.main) main();
