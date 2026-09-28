// Run-to-run variance across complete benchmark runs.
//
//   node scripts/compare.ts results/raw/<run-id> [results/raw/<run-id> ...]
//
// A "complete run" is one repetition (`--runs`) of one isolation mode inside
// one run directory, so this compares repetitions of one invocation and
// separate invocations alike. Each case's per-run median ns/op is the unit
// of comparison. Isolation modes are never pooled; where both are present,
// cases on which they disagree are listed separately.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";
import { formatNs, table } from "../bench/common/format.ts";
import type { CaseResult } from "../bench/common/harness.ts";

export interface StoredResult extends CaseResult {
  /** Repetition number (1-based); absent in schema 1 files. */
  run?: number;
  /** Position of the producing process in the run schedule. */
  sequence?: number;
  /** Process isolation mode that produced this result; absent before `--isolation both`. */
  isolation?: Isolation;
}

export type Isolation = "case" | "runtime";

export interface RunSet {
  /** Run directory id. */
  source: string;
  run: number;
  runtime: string;
  isolation: Isolation;
  results: StoredResult[];
}

export interface CaseVariance {
  runtime: string;
  isolation: Isolation;
  id: string;
  op: string;
  impl: string;
  size: number | null;
  runMedians: { source: string; run: number; median: number }[];
  median: number;
  min: number;
  max: number;
  /** (max - min) / median of the per-run medians. */
  spread: number;
}

// deno-lint-ignore no-explicit-any
type Json = any;

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Spread above which a case is flagged: its per-run medians disagree too much to report one number. */
export const UNSTABLE_SPREAD = 0.05;

/** Groups results into complete runs; `fallback` is the isolation of results that don't record one. */
export function splitRuns(source: string, runtime: string, results: StoredResult[], fallback: Isolation): RunSet[] {
  const runs = new Map<string, RunSet>();
  for (const r of results) {
    const run = r.run ?? 1;
    const isolation = r.isolation ?? fallback;
    const key = `${run}\t${isolation}`;
    const set = runs.get(key) ?? { source, run, runtime, isolation, results: [] };
    set.results.push(r);
    runs.set(key, set);
  }
  return [...runs.values()];
}

export function loadRunDir(dir: string): { environment: Json; runSets: RunSet[] } {
  const environment = JSON.parse(readFileSync(join(dir, "environment.json"), "utf8"));
  // Directories from before `--isolation both` used one mode for the whole run (schema 1: shared process).
  const fallback: Isolation = environment.methodology?.isolation === "case" ? "case" : "runtime";
  const runSets: RunSet[] = [];
  for (const runtime of Object.keys(environment.runtimes)) {
    const path = join(dir, `${runtime}.json`);
    if (!existsSync(path)) continue;
    runSets.push(...splitRuns(basename(dir), runtime, JSON.parse(readFileSync(path, "utf8")).results, fallback));
  }
  return { environment, runSets };
}

/** Per runtime, isolation mode and case, the spread of per-run medians. `caseOrder` fixes row order. */
export function caseVariance(runSets: RunSet[], caseOrder: string[] = []): CaseVariance[] {
  const byKey = new Map<string, CaseVariance>();
  for (const set of runSets) {
    for (const r of set.results) {
      const key = `${set.runtime}\t${set.isolation}\t${r.id}`;
      const entry = byKey.get(key) ?? {
        runtime: set.runtime,
        isolation: set.isolation,
        id: r.id,
        op: r.op,
        impl: r.impl,
        size: r.size,
        runMedians: [],
        median: 0,
        min: 0,
        max: 0,
        spread: 0,
      };
      entry.runMedians.push({ source: set.source, run: set.run, median: r.ns_per_op.median });
      byKey.set(key, entry);
    }
  }
  const rank = (id: string) => {
    const i = caseOrder.indexOf(id);
    return i === -1 ? caseOrder.length : i;
  };
  const runtimes = [...new Set(runSets.map((s) => s.runtime))];
  return [...byKey.values()]
    .map((e) => {
      const values = e.runMedians.map((m) => m.median);
      const med = median(values);
      const min = Math.min(...values);
      const max = Math.max(...values);
      return { ...e, median: med, min, max, spread: (max - min) / med };
    })
    .sort((a, b) =>
      runtimes.indexOf(a.runtime) - runtimes.indexOf(b.runtime) || rank(a.id) - rank(b.id) ||
      a.isolation.localeCompare(b.isolation)
    );
}

export interface Divergence {
  runtime: string;
  id: string;
  fresh: CaseVariance;
  shared: CaseVariance;
  /** shared median / fresh median. */
  ratio: number;
}

/**
 * Cases whose fresh-process (`case`) and shared-process (`runtime`) results
 * disagree: the ranges of per-run medians don't overlap and the medians
 * differ by more than UNSTABLE_SPREAD.
 */
export function divergences(variances: CaseVariance[]): Divergence[] {
  const out: Divergence[] = [];
  for (const fresh of variances.filter((v) => v.isolation === "case")) {
    const shared = variances.find((v) => v.isolation === "runtime" && v.runtime === fresh.runtime && v.id === fresh.id);
    if (!shared) continue;
    const disjoint = fresh.max < shared.min || shared.max < fresh.min;
    const relative = Math.abs(fresh.median - shared.median) / Math.min(fresh.median, shared.median);
    if (disjoint && relative > UNSTABLE_SPREAD) {
      out.push({ runtime: fresh.runtime, id: fresh.id, fresh, shared, ratio: shared.median / fresh.median });
    }
  }
  return out;
}

export function printDivergences(variances: CaseVariance[]): void {
  if (new Set(variances.map((v) => v.isolation)).size < 2) return;
  const found = divergences(variances);
  console.log(`\nisolation divergence (fresh process per case vs shared process per runtime): ${found.length} case(s)`);
  if (!found.length) return;
  const rows = found.map((d) => [
    d.runtime,
    d.id,
    formatNs(d.fresh.median),
    `${formatNs(d.fresh.min)} – ${formatNs(d.fresh.max)}`,
    formatNs(d.shared.median),
    `${formatNs(d.shared.min)} – ${formatNs(d.shared.max)}`,
    `${d.ratio.toFixed(2)}×`,
  ]);
  console.log(table(["runtime", "case", "fresh", "fresh runs", "shared", "shared runs", "shared/fresh"], rows));
}

/** With several run directories, adds each directory's median of runs as a column. */
export function printVariance(variances: CaseVariance[]): void {
  const sources = [...new Set(variances.flatMap((v) => v.runMedians.map((m) => m.source)))];
  const perSource = (v: CaseVariance, source: string) => {
    const values = v.runMedians.filter((m) => m.source === source).map((m) => m.median);
    return values.length ? formatNs(median(values)) : "-";
  };
  const modes = new Set(variances.map((v) => v.isolation)).size > 1;
  const rows = variances.map((v) => [
    v.runtime,
    v.id,
    ...(modes ? [v.isolation] : []),
    String(v.runMedians.length),
    ...(sources.length > 1 ? sources.map((s) => perSource(v, s)) : []),
    formatNs(v.median),
    formatNs(v.min),
    formatNs(v.max),
    `${(v.spread * 100).toFixed(1)}%`,
    v.spread > UNSTABLE_SPREAD ? "unstable" : "",
  ]);
  const header = [
    "runtime",
    "case",
    ...(modes ? ["isolation"] : []),
    "runs",
    ...(sources.length > 1 ? sources : []),
    "median of runs",
    "min run",
    "max run",
    "spread",
    "",
  ];
  console.log(table(header, rows));
  const unstable = variances.filter((v) => v.spread > UNSTABLE_SPREAD);
  console.log(
    `${unstable.length} of ${variances.length} cases exceed ${UNSTABLE_SPREAD * 100}% run-to-run spread` +
      (unstable.length
        ? `: ${unstable.map((v) => `${v.runtime} ${v.id}${modes ? ` (${v.isolation})` : ""}`).join(", ")}`
        : ""),
  );
}

/** Settings that make runs incomparable or explain differences between them. */
function comparableSettings(env: Json): Record<string, string> {
  const m = env.methodology ?? {};
  const system = env.system ?? {};
  const cpus: Json[] = system.cpus ?? [];
  const settings: Record<string, string> = {
    "git commit": `${env.git?.commit ?? "none"}${env.git?.dirty ? " (dirty)" : ""}`,
    "cpu": env.cpu?.model ?? "n/a",
    "kernel": env.os?.release ?? "n/a",
    "rustc": env.rust?.rustc ?? "n/a",
    "isolation": m.isolation ?? "runtime (schema 1)",
    "cpus": m.cpus ?? "unpinned",
    "warmup/samples/sample-ms": `${env.options?.warmup}/${env.options?.samples}/${env.options?.sampleMs}`,
    "governors": [...new Set(cpus.map((c) => c.governor))].join(",") || (env.cpuGovernor ?? "n/a"),
    "turbo": system.intelPstate?.noTurbo === "1" || system.cpufreqBoost === "0"
      ? "off"
      : system.intelPstate?.noTurbo === "0" || system.cpufreqBoost === "1"
      ? "on"
      : "n/a",
    "platform profile": system.platformProfile ?? env.powerProfile ?? "n/a",
  };
  for (const [rt, version] of Object.entries(env.runtimes ?? {})) settings[`${rt} version`] = String(version);
  return settings;
}

function main(): void {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error("usage: node scripts/compare.ts results/raw/<run-id> [results/raw/<run-id> ...]");
    process.exit(2);
  }
  const loaded = dirs.map((dir) => ({ dir, ...loadRunDir(dir) }));

  const settings = loaded.map((l) => comparableSettings(l.environment));
  const differing = [...new Set(settings.flatMap(Object.keys))].filter((key) =>
    new Set(settings.map((s) => s[key] ?? "n/a")).size > 1
  );
  if (differing.length) {
    console.log("settings that differ between run directories:");
    for (const key of differing) {
      console.log(`  ${key}: ${loaded.map((l, i) => `${basename(l.dir)}=${settings[i][key] ?? "n/a"}`).join("  ")}`);
    }
    console.log();
  }
  for (const l of loaded) {
    for (const w of l.environment.conditions?.warnings ?? []) console.log(`${basename(l.dir)}: warning: ${w}`);
  }

  const caseOrder: string[] = loaded[0].environment.methodology?.cases ?? [];
  const variances = caseVariance(loaded.flatMap((l) => l.runSets), caseOrder);
  printVariance(variances);
  printDivergences(variances);
}

if (import.meta.main) main();
