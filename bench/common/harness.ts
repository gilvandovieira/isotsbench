// Measurement loop: calibrate -> warmup -> samples, using batched timing.
//
// A sample times `iterations` calls in one batch; ns/op is derived from the
// batch. Iterations are calibrated per case so each sample lasts roughly
// `sampleMs`, keeping timer overhead negligible for tiny operations.

import process from "node:process";
import type { Case } from "./cases.ts";

export interface Options {
  warmup: number;
  samples: number;
  sampleMs: number;
}

export interface Stats {
  median: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

export interface CaseResult {
  id: string;
  op: string;
  impl: string;
  /** "none", "node-api", "bun:ffi" or "Deno.dlopen"; absent in results recorded before FFI paths existed. */
  binding?: string;
  size: number | null;
  iterations: number;
  /** Raw elapsed time of each warmup batch, in ns. Not used for stats. */
  warmup_ns: number[];
  /** Raw elapsed time of each measured batch, in ns. */
  samples_ns: number[];
  /** Derived from samples_ns / iterations. */
  ns_per_op: Stats;
  /** 1e9 / median ns/op. */
  ops_per_s: number;
}

export const TIMER = "process.hrtime.bigint";
const MAX_ITERATIONS = 2 ** 30;

// Keeps every batch result observable so the work cannot be optimised away.
let sink = 0;

function timeBatch(c: Case, iterations: number): number {
  const start = process.hrtime.bigint();
  const result = c.run(iterations);
  const elapsed = process.hrtime.bigint() - start;
  sink = (sink + result) | 0;
  return Number(elapsed);
}

/** Doubles the batch size until one batch reaches the target, then scales to it. */
function calibrate(c: Case, targetNs: number): number {
  let iterations = 1;
  for (;;) {
    const elapsed = timeBatch(c, iterations);
    if (elapsed >= targetNs || iterations >= MAX_ITERATIONS) {
      return Math.min(MAX_ITERATIONS, Math.max(1, Math.round((iterations * targetNs) / Math.max(elapsed, 1))));
    }
    iterations *= 2;
  }
}

export function summarize(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1 ? sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  return { median, mean, stddev: Math.sqrt(variance), min: sorted[0], max: sorted[n - 1] };
}

export function measure(c: Case, options: Options): CaseResult {
  const iterations = calibrate(c, options.sampleMs * 1e6);
  const warmup_ns: number[] = [];
  for (let i = 0; i < options.warmup; i++) warmup_ns.push(timeBatch(c, iterations));
  const samples_ns: number[] = [];
  for (let i = 0; i < options.samples; i++) samples_ns.push(timeBatch(c, iterations));

  const ns_per_op = summarize(samples_ns.map((ns) => ns / iterations));
  return {
    id: c.id,
    op: c.op,
    impl: c.impl,
    binding: c.binding,
    size: c.size,
    iterations,
    warmup_ns,
    samples_ns,
    ns_per_op,
    ops_per_s: 1e9 / ns_per_op.median,
  };
}
