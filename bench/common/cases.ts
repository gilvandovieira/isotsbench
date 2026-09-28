// Benchmark cases shared by every runtime.
//
// Each case owns its own loop instead of passing callbacks to a generic
// loop: a shared loop would see several call targets and become
// polymorphic, penalising whichever case the JIT happened to see second.
// Every loop folds results into its return value so calls cannot be
// eliminated as dead code.

import * as ts from "./ts-impl.ts";
import { loadNapi } from "./napi.ts";

export type Impl = "ts" | "napi";

export interface Case {
  id: string;
  op: string;
  impl: Impl;
  /** Workload size (elements) for scalable operations. */
  size: number | null;
  run(iterations: number): number;
}

export const SUM_I32_SIZES = [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000];

const napi = loadNapi();

const tsNoop = ts.noop;
const tsAdd = ts.add_i32;
const tsSum = ts.sum_i32;
const napiNoop = napi.noop;
const napiAdd = napi.add_i32;
const napiSum = napi.sum_i32;

/** Deterministic pseudo-random i32 values (LCG), identical in every runtime. */
export function makeI32Data(size: number): Int32Array {
  const data = new Int32Array(size);
  let x = 0x2545f491;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    data[i] = x;
  }
  return data;
}

function sumTsLoop(iterations: number, data: Int32Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + tsSum(data)) | 0;
  return acc;
}

function sumNapiLoop(iterations: number, data: Int32Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + napiSum(data)) | 0;
  return acc;
}

function sumCase(impl: Impl, size: number): Case {
  const data = makeI32Data(size);
  return {
    id: `sum_i32/${impl}/${size}`,
    op: "sum_i32",
    impl,
    size,
    run: impl === "ts"
      ? (iterations) => sumTsLoop(iterations, data)
      : (iterations) => sumNapiLoop(iterations, data),
  };
}

export function buildCases(): Case[] {
  return [
    {
      id: "noop/ts",
      op: "noop",
      impl: "ts",
      size: null,
      run(iterations) {
        for (let i = 0; i < iterations; i++) tsNoop();
        return iterations;
      },
    },
    {
      id: "noop/napi",
      op: "noop",
      impl: "napi",
      size: null,
      run(iterations) {
        for (let i = 0; i < iterations; i++) napiNoop();
        return iterations;
      },
    },
    {
      id: "add_i32/ts",
      op: "add_i32",
      impl: "ts",
      size: null,
      run(iterations) {
        let acc = 0;
        for (let i = 0; i < iterations; i++) acc = tsAdd(acc, i);
        return acc;
      },
    },
    {
      id: "add_i32/napi",
      op: "add_i32",
      impl: "napi",
      size: null,
      run(iterations) {
        let acc = 0;
        for (let i = 0; i < iterations; i++) acc = napiAdd(acc, i);
        return acc;
      },
    },
    ...SUM_I32_SIZES.flatMap((size) => [sumCase("ts", size), sumCase("napi", size)]),
  ];
}

/**
 * Confirms both implementations agree before anything is timed.
 * Throws on the first mismatch.
 */
export function checkEquivalence(): void {
  const expect = (label: string, actual: unknown, expected: unknown) => {
    if (!Object.is(actual, expected)) {
      throw new Error(`equivalence check failed: ${label}: got ${actual}, expected ${expected}`);
    }
  };

  expect("ts noop", tsNoop(), undefined);
  expect("napi noop", napiNoop(), undefined);

  const pairs: [number, number][] = [[0, 0], [2, 3], [-7, 3], [2147483647, 1], [-2147483648, -1]];
  for (const [a, b] of pairs) {
    expect(`add_i32(${a}, ${b})`, napiAdd(a, b), tsAdd(a, b));
  }

  for (const size of [0, ...SUM_I32_SIZES]) {
    const data = makeI32Data(size);
    expect(`sum_i32 size ${size}`, napiSum(data), tsSum(data));
  }
  const view = makeI32Data(64).subarray(3, 40);
  expect("sum_i32 offset view", napiSum(view), tsSum(view));
}
