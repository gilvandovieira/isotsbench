// Runs the benchmark cases in the current runtime (Node.js, Bun or Deno).
//
//   node bench/run.ts [--warmup 5] [--samples 30] [--sample-ms 20] [--filter sum_i32 | --case sum_i32/ts/10] [--out file.json]
//   node bench/run.ts --list [--filter sum_i32] [--suite boundary,payload,return]
//   bun  bench/run.ts ...
//   deno run --allow-read --allow-write --allow-ffi bench/run.ts ...

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import process from "node:process";
import { parseArgs } from "node:util";
import { buildCaseIds, buildCases, checkEquivalence } from "./common/cases.ts";
import { caseGroup, formatDataRate, formatNs, formatRate, table } from "./common/format.ts";
import { parseSuites, suiteOf } from "./common/suites.ts";
import { type CaseResult, measure, type Options, TIMER } from "./common/harness.ts";

const RESULT_SCHEMA_VERSION = 2;

function runtimeName(): "node" | "bun" | "deno" {
  // Bun and Deno also expose process.versions.node, so check them first.
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.Bun) return "bun";
  if (g.Deno) return "deno";
  return "node";
}

/**
 * CPUs this process may run on, as the kernel reports it. Linux only, and
 * not under Deno, which refuses /proc reads without --allow-all; widening
 * Deno's permissions for bookkeeping would change how it is launched.
 */
function cpuAffinity(runtime: string): string | null {
  if (process.platform !== "linux" || runtime === "deno") return null;
  return readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] ?? null;
}

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got "${value}"`);
  return n;
}

function printResults(results: CaseResult[]): void {
  const tsMedian = new Map(
    results.filter((r) => r.impl === "ts").map((r) => [caseGroup(r.id), r.ns_per_op.median]),
  );
  const rows = results.map((r) => {
    const s = r.ns_per_op;
    const baseline = tsMedian.get(caseGroup(r.id));
    const ratio = r.impl !== "ts" && baseline ? `${(s.median / baseline).toFixed(2)}×` : "";
    return [
      r.id,
      formatNs(s.median),
      `${formatRate(r.ops_per_s)}ops/s`,
      formatDataRate(r.op, r.payload, s.median),
      `${((s.stddev / s.mean) * 100).toFixed(1)}%`,
      formatNs(s.min),
      formatNs(s.max),
      String(r.iterations),
      ratio,
    ];
  });
  console.log(table(["case", "median/op", "throughput", "data rate", "rsd", "min/op", "max/op", "iters", "vs ts"], rows));
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      warmup: { type: "string", default: "5" },
      samples: { type: "string", default: "30" },
      "sample-ms": { type: "string", default: "20" },
      filter: { type: "string" },
      suite: { type: "string" },
      case: { type: "string" },
      list: { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  if (values.filter && values.case) throw new Error("use either --filter or --case, not both");
  const suites = values.suite ? parseSuites(values.suite) : null;
  const select = (id: string) =>
    (!suites || suites.includes(suiteOf(id.split("/")[0]))) &&
    (values.case ? id === values.case : !values.filter || id.includes(values.filter));

  if (values.list) {
    // Listing constructs no cases, so it allocates no benchmark data.
    const ids = buildCaseIds().filter(select);
    console.log(ids.join("\n"));
    return;
  }

  const options: Options = {
    warmup: positiveInt("warmup", values.warmup),
    samples: positiveInt("samples", values.samples),
    sampleMs: positiveInt("sample-ms", values["sample-ms"]),
  };
  const runtime = runtimeName();

  const cases = buildCases(select);
  if (cases.length === 0) throw new Error(`no case matches ${values.case ?? values.filter ?? values.suite}`);

  console.error(
    `${runtime}: ${cases.length} cases, warmup ${options.warmup}, samples ${options.samples}, ~${options.sampleMs} ms/sample`,
  );
  const startedAt = new Date().toISOString();
  const results = cases.map((c, i) => {
    console.error(`  [${i + 1}/${cases.length}] ${c.id}`);
    return measure(c, options);
  });
  const finishedAt = new Date().toISOString();

  // Verify every operation of the suites this process measured.
  checkEquivalence([...new Set(cases.map((c) => suiteOf(c.op)))]);

  printResults(results);

  if (values.out) {
    const output = {
      schema: RESULT_SCHEMA_VERSION,
      runtime,
      versions: process.versions,
      platform: process.platform,
      arch: process.arch,
      process: {
        pid: process.pid,
        affinity: cpuAffinity(runtime),
        // Respects the affinity mask in all three runtimes.
        allowedCpuCount: os.availableParallelism(),
        execArgv: process.execArgv,
      },
      timer: TIMER,
      options,
      equivalence: "checked after measurement, for the suites of the measured cases",
      startedAt,
      finishedAt,
      // In execution order.
      results,
    };
    writeFileSync(values.out, JSON.stringify(output, null, 2) + "\n");
    console.error(`wrote ${values.out}`);
  }
}

main();
