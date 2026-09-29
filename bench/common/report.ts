// Per-process result table printed by each runtime's runner.

import { caseGroup, formatDataRate, formatNs, formatRate, table } from "./format.ts";
import type { CaseResult } from "./harness.ts";

export function printResults(results: CaseResult[]): void {
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
      formatDataRate(r.op, r.payload, s.median, r.strategy),
      `${((s.stddev / s.mean) * 100).toFixed(1)}%`,
      formatNs(s.min),
      formatNs(s.max),
      String(r.iterations),
      ratio,
    ];
  });
  console.log(table(["case", "median/op", "throughput", "data rate", "rsd", "min/op", "max/op", "iters", "vs ts"], rows));
}
