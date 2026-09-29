// Measurement loop: calibrate -> warmup -> samples, using batched timing.
//
// A sample times `iterations` calls in one batch; ns/op is derived from the
// batch. Iterations are calibrated per case so each sample lasts roughly
// `sampleMs`, keeping timer overhead negligible for tiny operations.
//
// The clock is supplied by the runtime's entry point: process.hrtime.bigint
// under Node.js, Bun and Deno (clock-hrtime.ts), performance.now under
// scriptc, which has no hrtime (bench/scriptc/clock.ts). Each result records
// which one measured it.

import type { Case } from "./case.ts";
import type { Payload } from "./payloads.ts";
import { type Suite, suiteOf } from "./suites.ts";

export interface Options {
  warmup: number;
  samples: number;
  sampleMs: number;
}

/** Times one batch of `c.run(iterations)`, in ns, keeping its result observable. */
export interface Clock {
  readonly name: string;
  timeBatch(c: Case, iterations: number): number;
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
  /** "none", "node-api", "bun:ffi", "Deno.dlopen" or "scriptc-ffi"; absent in results recorded before FFI paths existed. */
  binding?: string;
  size: number | null;
  /** Payload flavour (string_len: "ascii" or "utf8"); null otherwise. Absent before M3. */
  variant?: string | null;
  /** Kind and size (bytes or record count) of the data crossing the boundary; null for scalar cases. Absent before M3. */
  payload?: Payload | null;
  /** "boundary", "payload" or "return". Absent before suites existed (derive it with suiteOf(op)). */
  suite?: Suite;
  /** Result representation when a path has several ("objects", "packed", "borrowed"); null otherwise. */
  strategy?: string | null;
  /** Allocation/fill/copy/borrow strategy of the data; null where not recorded. */
  ownership?: string | null;
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

const MAX_ITERATIONS = 2 ** 30;

/** Doubles the batch size until one batch reaches the target, then scales to it. */
function calibrate(c: Case, targetNs: number, clock: Clock): number {
  let iterations = 1;
  for (;;) {
    const elapsed = clock.timeBatch(c, iterations);
    if (elapsed >= targetNs || iterations >= MAX_ITERATIONS) {
      const scaled = Math.round((iterations * targetNs) / (elapsed > 1 ? elapsed : 1));
      return scaled < 1 ? 1 : scaled > MAX_ITERATIONS ? MAX_ITERATIONS : scaled;
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

export function measure(c: Case, options: Options, clock: Clock): CaseResult {
  const iterations = calibrate(c, options.sampleMs * 1e6, clock);
  const warmup_ns: number[] = [];
  for (let i = 0; i < options.warmup; i++) warmup_ns.push(clock.timeBatch(c, iterations));
  const samples_ns: number[] = [];
  for (let i = 0; i < options.samples; i++) samples_ns.push(clock.timeBatch(c, iterations));

  const ns_per_op = summarize(samples_ns.map((ns) => ns / iterations));
  return {
    id: c.id,
    op: c.op,
    impl: c.impl,
    binding: c.binding,
    size: c.size,
    variant: c.variant ?? null,
    payload: c.payload ?? null,
    suite: suiteOf(c.op),
    strategy: c.strategy ?? null,
    ownership: c.ownership ?? null,
    iterations,
    warmup_ns,
    samples_ns,
    ns_per_op,
    ops_per_s: 1e9 / ns_per_op.median,
  };
}
