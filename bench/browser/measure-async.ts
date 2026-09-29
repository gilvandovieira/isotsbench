// The measurement protocol of bench/common/harness.ts (calibrate → warmup →
// samples, batched timing, the same statistics) for cases whose batch
// completes asynchronously: Worker round trips. harness.ts itself stays
// synchronous because scriptc compiles it.
//
// A batch is timed with performance.now on the main thread, from posting the
// first request to the resolution of the batch after the last reply. That
// resolution adds one microtask to a batch of about `sampleMs`.

import type { CaseResult, Options } from "../common/harness.ts";
import { summarize } from "../common/harness.ts";
import { suiteOf } from "../common/suites.ts";
import type { AsyncCase } from "./worker-cases.ts";

/** As in harness.ts. */
const MAX_ITERATIONS = 2 ** 30;

// Keeps every batch result observable.
let sink = 0;

async function timeBatch(c: AsyncCase, iterations: number): Promise<number> {
  const start = performance.now();
  const result = await c.run(iterations);
  const elapsed = performance.now() - start;
  sink = (sink + result) | 0;
  return elapsed * 1e6;
}

async function calibrate(c: AsyncCase, targetNs: number): Promise<number> {
  let iterations = 1;
  for (;;) {
    const elapsed = await timeBatch(c, iterations);
    if (elapsed >= targetNs || iterations >= MAX_ITERATIONS) {
      const scaled = Math.round((iterations * targetNs) / (elapsed > 1 ? elapsed : 1));
      return scaled < 1 ? 1 : scaled > MAX_ITERATIONS ? MAX_ITERATIONS : scaled;
    }
    iterations *= 2;
  }
}

export async function measureAsync(c: AsyncCase, options: Options): Promise<CaseResult> {
  const iterations = await calibrate(c, options.sampleMs * 1e6);
  const warmup_ns: number[] = [];
  for (let i = 0; i < options.warmup; i++) warmup_ns.push(await timeBatch(c, iterations));
  const samples_ns: number[] = [];
  for (let i = 0; i < options.samples; i++) samples_ns.push(await timeBatch(c, iterations));

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
