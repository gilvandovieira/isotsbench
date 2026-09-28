// Benchmark cases shared by every runtime.
//
// Each case owns its own loop instead of passing callbacks to a generic
// loop: a shared loop would see several call targets and become
// polymorphic, penalising whichever case the JIT happened to see second.
// Every loop folds results into its return value so calls cannot be
// eliminated as dead code.

import * as ts from "./ts-impl.ts";
import { loadNapi } from "./napi.ts";
import { ffiBinding, loadFfi } from "./ffi.ts";

/** ts: pure TypeScript; napi: Node-API addon; ffi: C ABI via the runtime's FFI (Bun, Deno only). */
export type Impl = "ts" | "napi" | "ffi";

export interface Case {
  id: string;
  op: string;
  impl: Impl;
  /** Mechanism crossing into native code: "none", "node-api", "bun:ffi" or "Deno.dlopen". */
  binding: string;
  /** Workload size (elements) for scalable operations. */
  size: number | null;
  run(iterations: number): number;
}

export const SUM_I32_SIZES = [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000];

const napi = loadNapi();
const ffi = loadFfi();
const BINDINGS: Record<Impl, string> = { ts: "none", napi: "node-api", ffi: ffiBinding() ?? "unavailable" };
/** Implementations this runtime can run, in canonical order. */
const IMPLS: Impl[] = ffi ? ["ts", "napi", "ffi"] : ["ts", "napi"];

const tsNoop = ts.noop;
const tsAdd = ts.add_i32;
const tsSum = ts.sum_i32;
const napiNoop = napi.noop;
const napiAdd = napi.add_i32;
const napiSum = napi.sum_i32;
// Only called from FFI cases, which exist only when `ffi` is loaded.
const ffiNoop = ffi?.noop;
const ffiAdd = ffi?.add_i32;
const ffiSum = ffi?.sum_i32;

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

// The length argument is part of the FFI call: a C function cannot read it from the array.
function sumFfiLoop(iterations: number, data: Int32Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + ffiSum!(data, data.length)) | 0;
  return acc;
}

function sumCase(impl: Impl, size: number): Case {
  const data = makeI32Data(size);
  const runs: Record<Impl, (iterations: number) => number> = {
    ts: (iterations) => sumTsLoop(iterations, data),
    napi: (iterations) => sumNapiLoop(iterations, data),
    ffi: (iterations) => sumFfiLoop(iterations, data),
  };
  return { id: `sum_i32/${impl}/${size}`, op: "sum_i32", impl, binding: BINDINGS[impl], size, run: runs[impl] };
}

/** Builds only the selected cases, so a process allocates data for nothing else. */
export function buildCases(select: (id: string) => boolean = () => true): Case[] {
  const scalar: Case[] = [
    {
      id: "noop/ts",
      op: "noop",
      impl: "ts",
      binding: BINDINGS.ts,
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
      binding: BINDINGS.napi,
      size: null,
      run(iterations) {
        for (let i = 0; i < iterations; i++) napiNoop();
        return iterations;
      },
    },
    {
      id: "noop/ffi",
      op: "noop",
      impl: "ffi",
      binding: BINDINGS.ffi,
      size: null,
      run(iterations) {
        for (let i = 0; i < iterations; i++) ffiNoop!();
        return iterations;
      },
    },
    {
      id: "add_i32/ts",
      op: "add_i32",
      impl: "ts",
      binding: BINDINGS.ts,
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
      binding: BINDINGS.napi,
      size: null,
      run(iterations) {
        let acc = 0;
        for (let i = 0; i < iterations; i++) acc = napiAdd(acc, i);
        return acc;
      },
    },
    {
      id: "add_i32/ffi",
      op: "add_i32",
      impl: "ffi",
      binding: BINDINGS.ffi,
      size: null,
      run(iterations) {
        let acc = 0;
        for (let i = 0; i < iterations; i++) acc = ffiAdd!(acc, i);
        return acc;
      },
    },
  ];
  const selected = scalar.filter((c) => IMPLS.includes(c.impl) && select(c.id));
  const sums = SUM_I32_SIZES.flatMap((size) =>
    IMPLS.filter((impl) => select(`sum_i32/${impl}/${size}`)).map((impl) => sumCase(impl, size))
  );
  return [...selected, ...sums];
}

/** Every case id this runtime can run, in canonical order; selects nothing, so no data is allocated. */
export function buildCaseIds(): string[] {
  const ids: string[] = [];
  buildCases((id) => {
    ids.push(id);
    return false;
  });
  return ids;
}

/**
 * Confirms every available native path (Node-API, and FFI where the
 * runtime has it) agrees with the TypeScript reference. Throws on the
 * first mismatch.
 *
 * Runs after measurement: calling the functions beforehand with overflow
 * and edge-case inputs would shape the JIT's type feedback for the cases
 * being measured.
 */
export function checkEquivalence(): void {
  const expect = (label: string, actual: unknown, expected: unknown) => {
    if (!Object.is(actual, expected)) {
      throw new Error(`equivalence check failed: ${label}: got ${actual}, expected ${expected}`);
    }
  };

  const paths: { name: string; ops: { noop(): void; add_i32(a: number, b: number): number; sum(d: Int32Array): number } }[] = [
    { name: "napi", ops: { noop: napiNoop, add_i32: napiAdd, sum: napiSum } },
  ];
  if (ffi) paths.push({ name: "ffi", ops: { noop: ffi.noop, add_i32: ffi.add_i32, sum: (d) => ffi.sum_i32(d, d.length) } });

  expect("ts noop", tsNoop(), undefined);
  const pairs: [number, number][] = [[0, 0], [2, 3], [-7, 3], [2147483647, 1], [-2147483648, -1]];
  const sizes = [0, ...SUM_I32_SIZES];
  const view = makeI32Data(64).subarray(3, 40);

  for (const { name, ops } of paths) {
    expect(`${name} noop`, ops.noop(), undefined);
    for (const [a, b] of pairs) {
      expect(`${name} add_i32(${a}, ${b})`, ops.add_i32(a, b), tsAdd(a, b));
    }
    for (const size of sizes) {
      const data = makeI32Data(size);
      expect(`${name} sum_i32 size ${size}`, ops.sum(data), tsSum(data));
    }
    expect(`${name} sum_i32 offset view`, ops.sum(view), tsSum(view));
  }
}
