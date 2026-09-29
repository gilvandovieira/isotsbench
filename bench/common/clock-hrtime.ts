// The batch clock used under Node.js, Bun and Deno: process.hrtime.bigint,
// ns resolution in all three. Unchanged from the original harness.

import process from "node:process";
import type { Case } from "./case.ts";
import type { Clock } from "./harness.ts";

// Keeps every batch result observable so the work cannot be optimised away.
let sink = 0;

export const hrtimeClock: Clock = {
  name: "process.hrtime.bigint",
  timeBatch(c: Case, iterations: number): number {
    const start = process.hrtime.bigint();
    const result = c.run(iterations);
    const elapsed = process.hrtime.bigint() - start;
    sink = (sink + result) | 0;
    return Number(elapsed);
  },
};
