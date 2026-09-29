// Boundary-suite cases on the browser main thread: the TypeScript baseline
// and the WebAssembly paths of bench/common/cases.ts, with the same ids,
// loops, data and metadata. Node-API and FFI do not exist in a browser, and
// `wasm.no-inline` needs engine flags (see docs/browser.md).
//
// Each loop is a copy of its counterpart in bench/common/cases.ts. They are
// not imported from there because that module loads Node-API and FFI at
// startup; the loops must stay identical, and each case keeps its own loop
// over one hoisted function reference.

import type { Case } from "../common/case.ts";
import { type BoundaryPath, checkBoundary, expectTrue } from "../common/checks.ts";
import { makeI32Data, SUM_I32_SIZES } from "../common/payloads.ts";
import * as ts from "../common/ts-impl.ts";
import type { WasmBinding } from "../common/wasm-abi.ts";
import { loadWasm } from "./wasm.ts";

const defaultBuild = await loadWasm("default");
const simdBuild = await loadWasm("simd128");
const wasm = defaultBuild.binding;
const wasmSimd = simdBuild.binding;
/** Artifact identity and availability, for the result metadata. */
export const wasmArtifacts = [defaultBuild.status, simdBuild.status];

const tsNoop = ts.noop;
const tsAdd = ts.add_i32;
const tsSum = ts.sum_i32;
const wasmNoop = wasm?.noop;
const wasmAdd = wasm?.add_i32;
const wasmSum = wasm?.sum_i32;
const simdSum = wasmSimd?.sum_i32;

function sumTsLoop(iterations: number, data: Int32Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + tsSum(data)) | 0;
  return acc;
}

function noopWasmLoop(iterations: number): number {
  for (let i = 0; i < iterations; i++) wasmNoop!();
  return iterations;
}

function addWasmLoop(iterations: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = wasmAdd!(acc, i);
  return acc;
}

// The view is made per batch: an allocation for another case can grow the
// memory, which replaces `memory.buffer`. All allocations happen while cases
// are built, before any timing.
function sumWasmCopyLoop(iterations: number, data: Int32Array, pointer: number): number {
  const target = new Int32Array(wasm!.memory.buffer, pointer, data.length);
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    target.set(data);
    acc = (acc + wasmSum!(pointer, data.length)) | 0;
  }
  return acc;
}

function sumWasmResidentLoop(iterations: number, pointer: number, length: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + wasmSum!(pointer, length)) | 0;
  return acc;
}

function sumSimdCopyLoop(iterations: number, data: Int32Array, pointer: number): number {
  const target = new Int32Array(wasmSimd!.memory.buffer, pointer, data.length);
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    target.set(data);
    acc = (acc + simdSum!(pointer, data.length)) | 0;
  }
  return acc;
}

function sumSimdResidentLoop(iterations: number, pointer: number, length: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + simdSum!(pointer, length)) | 0;
  return acc;
}

type WasmSumPath = "wasm.copy" | "wasm.resident" | "wasm.simd128.copy" | "wasm.simd128.resident";

/** The WASM sum paths this browser can run, in canonical order. */
const WASM_SUM_PATHS: WasmSumPath[] = [
  ...(wasm ? ["wasm.copy", "wasm.resident"] as const : []),
  ...(wasmSimd ? ["wasm.simd128.copy", "wasm.simd128.resident"] as const : []),
];

function wasmSumCase(path: WasmSumPath, size: number): Case {
  const binding = path.startsWith("wasm.simd128") ? wasmSimd! : wasm!;
  const data = makeI32Data(size);
  const pointer = binding.alloc_i32(size);
  const resident = path.endsWith("resident");
  // Resident input is copied here, outside timing; growth keeps its contents.
  if (resident) new Int32Array(binding.memory.buffer, pointer, size).set(data);
  const runs: Record<WasmSumPath, (iterations: number) => number> = {
    "wasm.copy": (iterations) => sumWasmCopyLoop(iterations, data, pointer),
    "wasm.resident": (iterations) => sumWasmResidentLoop(iterations, pointer, size),
    "wasm.simd128.copy": (iterations) => sumSimdCopyLoop(iterations, data, pointer),
    "wasm.simd128.resident": (iterations) => sumSimdResidentLoop(iterations, pointer, size),
  };
  return {
    id: `sum_i32/${path}/${size}`,
    op: "sum_i32",
    impl: "wasm",
    binding: path.startsWith("wasm.simd128") ? "WebAssembly+simd128" : "WebAssembly",
    size,
    payload: { kind: "int32array", bytes: size * 4 },
    strategy: resident ? "resident" : "copy",
    ownership: resident ? "wasm-memory-resident" : "js-to-wasm-memory-copy",
    run: runs[path],
  };
}

function sumTsCase(size: number): Case {
  const data = makeI32Data(size);
  return {
    id: `sum_i32/ts/${size}`,
    op: "sum_i32",
    impl: "ts",
    binding: "none",
    size,
    payload: { kind: "int32array", bytes: size * 4 },
    run: (iterations) => sumTsLoop(iterations, data),
  };
}

/** Builds only the selected main-thread cases, in canonical order. */
export function buildMainCases(select: (id: string) => boolean = () => true): Case[] {
  const scalar: Case[] = [
    {
      id: "noop/ts",
      op: "noop",
      impl: "ts",
      binding: "none",
      size: null,
      run(iterations) {
        for (let i = 0; i < iterations; i++) tsNoop();
        return iterations;
      },
    },
    {
      id: "noop/wasm.inlineable",
      op: "noop",
      impl: "wasm",
      binding: "WebAssembly",
      size: null,
      // The engine's default: it may inline the WASM call into the JS loop.
      strategy: "inlineable",
      run: noopWasmLoop,
    },
    {
      id: "add_i32/ts",
      op: "add_i32",
      impl: "ts",
      binding: "none",
      size: null,
      run(iterations) {
        let acc = 0;
        for (let i = 0; i < iterations; i++) acc = tsAdd(acc, i);
        return acc;
      },
    },
    {
      id: "add_i32/wasm.inlineable",
      op: "add_i32",
      impl: "wasm",
      binding: "WebAssembly",
      size: null,
      strategy: "inlineable",
      run: addWasmLoop,
    },
  ];
  const selected = scalar.filter((c) => (c.impl === "ts" || wasm !== null) && select(c.id));
  // Per size: every path of the same operation together, in canonical order.
  const sums = SUM_I32_SIZES.flatMap((size) => [
    ...(select(`sum_i32/ts/${size}`) ? [sumTsCase(size)] : []),
    ...WASM_SUM_PATHS.filter((path) => select(`sum_i32/${path}/${size}`)).map((path) => wasmSumCase(path, size)),
  ]);
  return [...selected, ...sums];
}

/** One sum through a WASM build, exactly as a `copy` case does it (for the correctness check). */
function wasmSumOnce(binding: WasmBinding, data: Int32Array): number {
  const pointer = binding.alloc_i32(data.length);
  new Int32Array(binding.memory.buffer, pointer, data.length).set(data);
  return binding.sum_i32(pointer, data.length);
}

/**
 * The server runtimes' boundary check (checks.ts) for every WASM build this
 * browser loaded. Runs after measurement, for the same reason as there.
 */
export function checkMainEquivalence(): void {
  const paths: BoundaryPath[] = [];
  for (const [name, binding] of [["wasm", wasm], ["wasm.simd128", wasmSimd]] as const) {
    if (!binding) continue;
    paths.push({
      name,
      noopReturnsUndefined: () => binding.noop() === undefined,
      add_i32: binding.add_i32,
      sum_i32: (d) => wasmSumOnce(binding, d),
    });
  }
  expectTrue("ts noop returns undefined", tsNoop() === undefined);
  checkBoundary(paths);
}
