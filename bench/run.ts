// Runs the benchmark cases in the current runtime (Node.js, Bun or Deno).
//
//   node bench/run.ts [--warmup 5] [--samples 30] [--sample-ms 20] [--filter sum_i32] [--out file.json]
//   bun  bench/run.ts ...
//   deno run --allow-read --allow-write --allow-ffi bench/run.ts ...

import { writeFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { buildCases, checkEquivalence } from "./common/cases.ts";
import { formatNs, formatRate, table } from "./common/format.ts";
import { type CaseResult, measure, type Options, TIMER } from "./common/harness.ts";

const RESULT_SCHEMA_VERSION = 1;

function runtimeName(): "node" | "bun" | "deno" {
  // Bun and Deno also expose process.versions.node, so check them first.
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.Bun) return "bun";
  if (g.Deno) return "deno";
  return "node";
}

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got "${value}"`);
  return n;
}

function printResults(results: CaseResult[]): void {
  const tsMedian = new Map(
    results.filter((r) => r.impl === "ts").map((r) => [`${r.op}/${r.size}`, r.ns_per_op.median]),
  );
  const rows = results.map((r) => {
    const s = r.ns_per_op;
    const baseline = tsMedian.get(`${r.op}/${r.size}`);
    const ratio = r.impl !== "ts" && baseline ? `${(s.median / baseline).toFixed(2)}×` : "";
    return [
      r.id,
      formatNs(s.median),
      `${formatRate(r.ops_per_s)}ops/s`,
      `${((s.stddev / s.mean) * 100).toFixed(1)}%`,
      formatNs(s.min),
      formatNs(s.max),
      String(r.iterations),
      ratio,
    ];
  });
  console.log(table(["case", "median/op", "throughput", "rsd", "min/op", "max/op", "iters", "vs ts"], rows));
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      warmup: { type: "string", default: "5" },
      samples: { type: "string", default: "30" },
      "sample-ms": { type: "string", default: "20" },
      filter: { type: "string" },
      out: { type: "string" },
    },
  });
  const options: Options = {
    warmup: positiveInt("warmup", values.warmup),
    samples: positiveInt("samples", values.samples),
    sampleMs: positiveInt("sample-ms", values["sample-ms"]),
  };
  const runtime = runtimeName();

  checkEquivalence();

  const cases = buildCases().filter((c) => !values.filter || c.id.includes(values.filter));
  if (cases.length === 0) throw new Error(`no case matches --filter ${values.filter}`);

  console.error(
    `${runtime}: ${cases.length} cases, warmup ${options.warmup}, samples ${options.samples}, ~${options.sampleMs} ms/sample`,
  );
  const startedAt = new Date().toISOString();
  const results = cases.map((c, i) => {
    console.error(`  [${i + 1}/${cases.length}] ${c.id}`);
    return measure(c, options);
  });

  printResults(results);

  if (values.out) {
    const output = {
      schema: RESULT_SCHEMA_VERSION,
      runtime,
      versions: process.versions,
      platform: process.platform,
      arch: process.arch,
      timer: TIMER,
      options,
      startedAt,
      finishedAt: new Date().toISOString(),
      results,
    };
    writeFileSync(values.out, JSON.stringify(output, null, 2) + "\n");
    console.error(`wrote ${values.out}`);
  }
}

main();
