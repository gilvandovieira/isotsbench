// The batch clock used under scriptc, which has no process.hrtime:
// performance.now (steps of about 40 ns measured on the reference machine),
// converted to ns. Batches are calibrated to ~20 ms, so its resolution adds
// well under 0.001% to a sample.

import type { Case } from "../common/case.ts";
import type { Clock } from "../common/harness.ts";

// Keeps every batch result observable so the work cannot be optimised away.
let sink = 0;

export const performanceClock: Clock = {
  name: "performance.now",
  timeBatch(c: Case, iterations: number): number {
    const start = performance.now();
    const result = c.run(iterations);
    const elapsed = performance.now() - start;
    sink = (sink + result) | 0;
    return elapsed * 1e6;
  },
};
