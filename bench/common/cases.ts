// Benchmark cases shared by every runtime.
//
// Each case owns its own loop instead of passing callbacks to a generic
// loop: a shared loop would see several call targets and become
// polymorphic, penalising whichever case the JIT happened to see second.
// Every loop folds results into its return value so calls cannot be
// eliminated as dead code.

import type { Case, Impl } from "./case.ts";
import {
  type BoundaryPath,
  checkBoundary,
  checkPayload,
  checkScalarReturn,
  expectNumber,
  expectString,
  expectTrue,
  type PayloadPath,
} from "./checks.ts";
import * as ts from "./ts-impl.ts";
import { loadNapi } from "./napi.ts";
import { ffiBinding, loadFfi } from "./ffi.ts";
import {
  bytesPayload,
  makeI32Data,
  PAYLOAD_SIZES,
  RETURN_STRING_SIZES,
  ROW_COUNTS,
  STRING_VARIANTS,
  type StringVariant,
  stringPayload,
  SUM_I32_SIZES,
} from "./payloads.ts";
import { decodeRows, PACKED_ROW_SIZE, type Row } from "./rows.ts";
import type { Suite } from "./suites.ts";
import { loadWasm, type WasmBinding } from "./wasm.ts";

export type { Case, Impl } from "./case.ts";

type ExistingImpl = Exclude<Impl, "wasm">;
const napi = loadNapi();
const ffi = loadFfi();
const wasm = loadWasm("default");
const wasmSimd = loadWasm("simd128");
/** Only V8 (Node.js, Deno) has a switch for JS→WASM inlining; see process-groups.ts. */
const V8_RUNTIME = !(globalThis as unknown as Record<string, unknown>).Bun;
const BINDINGS: Record<ExistingImpl, string> = { ts: "none", napi: "node-api", ffi: ffiBinding() ?? "unavailable" };
/** Implementations this runtime can run, in canonical order. */
const IMPLS: ExistingImpl[] = ffi ? ["ts", "napi", "ffi"] : ["ts", "napi"];

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
const wasmNoop = wasm?.noop;
const wasmAdd = wasm?.add_i32;
const wasmSum = wasm?.sum_i32;
const simdSum = wasmSimd?.sum_i32;
const tsStringLen = ts.string_len;
const tsBytesLen = ts.bytes_len;
const tsChecksum = ts.checksum_bytes;
const napiStringLen = napi.string_len;
const napiBytesLen = napi.bytes_len;
const napiChecksum = napi.checksum_bytes;
const ffiStringLen = ffi?.string_len;
const ffiBytesLen = ffi?.bytes_len;
const ffiChecksum = ffi?.checksum_bytes;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const tsReturnF64 = ts.return_f64;
const tsReturnBytes = ts.return_bytes;
const tsReturnRows = ts.return_rows;
const napiReturnF64 = napi.return_f64;
const napiReturnAscii = napi.return_string_ascii;
const napiReturnUtf8 = napi.return_string_utf8;
const napiReturnBytes = napi.return_bytes;
const napiReturnRows = napi.return_rows;
const napiReturnRowsPacked = napi.return_rows_packed;
const ffiReturnF64 = ffi?.return_f64;
const ffiFillAscii = ffi?.fill_string_ascii;
const ffiFillUtf8 = ffi?.fill_string_utf8;
const ffiFillBytes = ffi?.fill_bytes;
const ffiFillRows = ffi?.fill_rows_packed;


/** Ownership strategies of the return cases; documented in docs/methodology.md. */
const OWNERSHIP = {
  value: "value",
  napiString: "native-buffer+engine-copy",
  ffiString: "js-buffer+TextDecoder",
  jsFill: "js-alloc+js-fill",
  nativeFill: "js-alloc+native-fill",
  jsObjects: "js-objects",
  nativeObjects: "native-objects",
  packed: "js-alloc+native-fill+js-decode",
} as const;

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

// ---- WebAssembly (boundary suite) -------------------------------------------
// A JS array and WASM linear memory are separate. `copy` paths copy the input
// into linear memory on every call; `resident` paths copy it once outside
// timing, isolating the WASM execution. `simd128` paths run the same source
// built with SIMD enabled. See docs/wasm.md.

// Shared by `wasm.inlineable` and `wasm.no-inline`: the two never run in the
// same process (see process-groups.ts), so they never share type feedback.
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

/** The WASM sum paths this runtime can run, in canonical order. */
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

/** One sum through a WASM build, exactly as a `copy` case does it (for the correctness check). */
function wasmSumOnce(binding: WasmBinding, data: Int32Array): number {
  const pointer = binding.alloc_i32(data.length);
  new Int32Array(binding.memory.buffer, pointer, data.length).set(data);
  return binding.sum_i32(pointer, data.length);
}

function sumCase(impl: ExistingImpl, size: number): Case {
  const data = makeI32Data(size);
  const runs: Record<ExistingImpl, (iterations: number) => number> = {
    ts: (iterations) => sumTsLoop(iterations, data),
    napi: (iterations) => sumNapiLoop(iterations, data),
    ffi: (iterations) => sumFfiLoop(iterations, data),
  };
  return {
    id: `sum_i32/${impl}/${size}`,
    op: "sum_i32",
    impl,
    binding: BINDINGS[impl],
    size,
    payload: { kind: "int32array", bytes: size * 4 },
    run: runs[impl],
  };
}

function stringLenTsLoop(iterations: number, value: string): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + tsStringLen(value)) | 0;
  return acc;
}

// Node-API transcodes the string inside the call (into the addon's reused buffer).
function stringLenNapiLoop(iterations: number, value: string): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + napiStringLen(value)) | 0;
  return acc;
}

// A C function cannot read a JS string: the caller encodes it into a reused
// buffer with TextEncoder.encodeInto, then passes pointer and byte length.
function stringLenFfiLoop(iterations: number, value: string, scratch: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    const { written } = encoder.encodeInto(value, scratch);
    acc = (acc + ffiStringLen!(scratch, written!)) | 0;
  }
  return acc;
}

function stringLenCase(impl: ExistingImpl, variant: (typeof STRING_VARIANTS)[number], bytes: number): Case {
  const value = stringPayload(variant, bytes);
  // Worst case: 3 UTF-8 bytes per UTF-16 code unit.
  const scratch = impl === "ffi" ? new Uint8Array(value.length * 3) : new Uint8Array(0);
  const runs: Record<ExistingImpl, (iterations: number) => number> = {
    ts: (iterations) => stringLenTsLoop(iterations, value),
    napi: (iterations) => stringLenNapiLoop(iterations, value),
    ffi: (iterations) => stringLenFfiLoop(iterations, value, scratch),
  };
  return {
    id: `string_len/${impl}/${variant}/${bytes}`,
    op: "string_len",
    impl,
    binding: BINDINGS[impl],
    size: bytes,
    variant,
    payload: { kind: `string-${variant}`, bytes },
    run: runs[impl],
  };
}

function bytesLenTsLoop(iterations: number, data: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + tsBytesLen(data)) | 0;
  return acc;
}

function bytesLenNapiLoop(iterations: number, data: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + napiBytesLen(data)) | 0;
  return acc;
}

function bytesLenFfiLoop(iterations: number, data: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + ffiBytesLen!(data, data.length)) | 0;
  return acc;
}

function checksumTsLoop(iterations: number, data: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + tsChecksum(data)) | 0;
  return acc;
}

function checksumNapiLoop(iterations: number, data: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + napiChecksum(data)) | 0;
  return acc;
}

function checksumFfiLoop(iterations: number, data: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + ffiChecksum!(data, data.length)) | 0;
  return acc;
}

function bytesCase(op: "bytes_len" | "checksum_bytes", impl: ExistingImpl, bytes: number): Case {
  const data = bytesPayload(bytes);
  const runs: Record<ExistingImpl, (iterations: number) => number> = op === "bytes_len"
    ? {
      ts: (iterations) => bytesLenTsLoop(iterations, data),
      napi: (iterations) => bytesLenNapiLoop(iterations, data),
      ffi: (iterations) => bytesLenFfiLoop(iterations, data),
    }
    : {
      ts: (iterations) => checksumTsLoop(iterations, data),
      napi: (iterations) => checksumNapiLoop(iterations, data),
      ffi: (iterations) => checksumFfiLoop(iterations, data),
    };
  return {
    id: `${op}/${impl}/${bytes}`,
    op,
    impl,
    binding: BINDINGS[impl],
    size: bytes,
    payload: { kind: "uint8array", bytes },
    run: runs[impl],
  };
}

// ---- Return path (native → JS) --------------------------------------------
// Every loop returns a new result per call, as a real API would, and folds a
// part of it into the accumulator so the result cannot be discarded.

function returnF64TsLoop(iterations: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc += tsReturnF64();
  return acc;
}

function returnF64NapiLoop(iterations: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc += napiReturnF64();
  return acc;
}

function returnF64FfiLoop(iterations: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc += ffiReturnF64!();
  return acc;
}

// Node-API: native fills its reused buffer, the engine copies it into a new JS string.
function returnAsciiNapiLoop(iterations: number, bytes: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + napiReturnAscii(bytes).length) | 0;
  return acc;
}

function returnUtf8NapiLoop(iterations: number, bytes: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + napiReturnUtf8(bytes).length) | 0;
  return acc;
}

// FFI: native fills a reused JS buffer, TextDecoder copies it into a new JS string.
function returnAsciiFfiLoop(iterations: number, out: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    ffiFillAscii!(out, out.length);
    acc = (acc + decoder.decode(out).length) | 0;
  }
  return acc;
}

function returnUtf8FfiLoop(iterations: number, out: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    ffiFillUtf8!(out, out.length);
    acc = (acc + decoder.decode(out).length) | 0;
  }
  return acc;
}

function returnStringCase(impl: "napi" | "ffi", variant: (typeof STRING_VARIANTS)[number], bytes: number): Case {
  const out = new Uint8Array(impl === "ffi" ? bytes : 0);
  const run = impl === "napi"
    ? variant === "ascii"
      ? (iterations: number) => returnAsciiNapiLoop(iterations, bytes)
      : (iterations: number) => returnUtf8NapiLoop(iterations, bytes)
    : variant === "ascii"
    ? (iterations: number) => returnAsciiFfiLoop(iterations, out)
    : (iterations: number) => returnUtf8FfiLoop(iterations, out);
  return {
    id: `return_string/${impl}/${variant}/${bytes}`,
    op: "return_string",
    impl,
    binding: BINDINGS[impl],
    size: bytes,
    variant,
    payload: { kind: `string-${variant}`, bytes },
    ownership: impl === "napi" ? OWNERSHIP.napiString : OWNERSHIP.ffiString,
    run,
  };
}

function returnBytesTsLoop(iterations: number, bytes: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + tsReturnBytes(bytes)[bytes - 1]) | 0;
  return acc;
}

function returnBytesNapiLoop(iterations: number, bytes: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + napiReturnBytes(bytes)[bytes - 1]) | 0;
  return acc;
}

// The JS allocation is part of the FFI return: the caller must provide the memory.
function returnBytesFfiLoop(iterations: number, bytes: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    const out = new Uint8Array(bytes);
    ffiFillBytes!(out, bytes);
    acc = (acc + out[bytes - 1]) | 0;
  }
  return acc;
}

function returnBytesCase(impl: ExistingImpl, bytes: number): Case {
  const runs: Record<ExistingImpl, (iterations: number) => number> = {
    ts: (iterations) => returnBytesTsLoop(iterations, bytes),
    napi: (iterations) => returnBytesNapiLoop(iterations, bytes),
    ffi: (iterations) => returnBytesFfiLoop(iterations, bytes),
  };
  return {
    id: `return_bytes/${impl}/${bytes}`,
    op: "return_bytes",
    impl,
    binding: BINDINGS[impl],
    size: bytes,
    payload: { kind: "uint8array", bytes },
    ownership: impl === "ts" ? OWNERSHIP.jsFill : OWNERSHIP.nativeFill,
    run: runs[impl],
  };
}

function returnRowsTsLoop(iterations: number, count: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + tsReturnRows(count)[count - 1].id) | 0;
  return acc;
}

function returnRowsNapiObjectsLoop(iterations: number, count: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + napiReturnRows(count)[count - 1].id) | 0;
  return acc;
}

function returnRowsNapiPackedLoop(iterations: number, count: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    acc = (acc + decodeRows(napiReturnRowsPacked(count), count)[count - 1].id) | 0;
  }
  return acc;
}

function returnRowsFfiPackedLoop(iterations: number, count: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    const out = new Uint8Array(count * PACKED_ROW_SIZE);
    ffiFillRows!(out, out.length);
    acc = (acc + decodeRows(out, count)[count - 1].id) | 0;
  }
  return acc;
}

/**
 * Row paths. A C function cannot create JS objects, so FFI can only return
 * packed bytes that JS decodes; Node-API can do either. The strategies are
 * measured under separate names instead of being presented as equivalent.
 */
const ROW_PATHS = [
  { path: "ts", impl: "ts", ownership: OWNERSHIP.jsObjects, loop: returnRowsTsLoop },
  { path: "napi.objects", impl: "napi", strategy: "objects", ownership: OWNERSHIP.nativeObjects, loop: returnRowsNapiObjectsLoop },
  { path: "napi.packed", impl: "napi", strategy: "packed", ownership: OWNERSHIP.packed, loop: returnRowsNapiPackedLoop },
  { path: "ffi.packed", impl: "ffi", strategy: "packed", ownership: OWNERSHIP.packed, loop: returnRowsFfiPackedLoop },
] as const;

function returnCases(select: (id: string) => boolean): Case[] {
  const nativeImpls = IMPLS.filter((impl): impl is "napi" | "ffi" => impl !== "ts");
  const f64Loops: Record<ExistingImpl, (iterations: number) => number> = {
    ts: returnF64TsLoop,
    napi: returnF64NapiLoop,
    ffi: returnF64FfiLoop,
  };
  const f64 = IMPLS.filter((impl) => select(`return_f64/${impl}`)).map((impl): Case => ({
    id: `return_f64/${impl}`,
    op: "return_f64",
    impl,
    binding: BINDINGS[impl],
    size: null,
    ownership: OWNERSHIP.value,
    run: f64Loops[impl],
  }));
  // No ts path: JS has no equivalent way to produce these strings that does not
  // depend on engine string representations (ropes, slices); see methodology.
  const strings = STRING_VARIANTS.flatMap((variant) =>
    RETURN_STRING_SIZES.flatMap((bytes) =>
      nativeImpls.filter((impl) => select(`return_string/${impl}/${variant}/${bytes}`)).map((impl) =>
        returnStringCase(impl, variant, bytes)
      )
    )
  );
  const buffers = PAYLOAD_SIZES.flatMap((bytes) =>
    IMPLS.filter((impl) => select(`return_bytes/${impl}/${bytes}`)).map((impl) => returnBytesCase(impl, bytes))
  );
  const rows = ROW_COUNTS.flatMap((count) =>
    ROW_PATHS.filter((p) => IMPLS.includes(p.impl) && select(`return_rows/${p.path}/${count}`)).map((p): Case => ({
      id: `return_rows/${p.path}/${count}`,
      op: "return_rows",
      impl: p.impl,
      binding: BINDINGS[p.impl],
      size: count,
      payload: { kind: "rows", count },
      ...("strategy" in p ? { strategy: p.strategy } : {}),
      ownership: p.ownership,
      run: (iterations) => p.loop(iterations, count),
    }))
  );
  return [...f64, ...strings, ...buffers, ...rows];
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
      id: "noop/wasm.inlineable",
      op: "noop",
      impl: "wasm",
      binding: "WebAssembly",
      size: null,
      // The runtime's default: V8 can inline the WASM call into the JS loop.
      strategy: "inlineable",
      run: noopWasmLoop,
    },
    {
      id: "noop/wasm.no-inline",
      op: "noop",
      impl: "wasm",
      binding: "WebAssembly",
      size: null,
      // Diagnostic: runs only in a V8 process with JS→WASM inlining disabled.
      strategy: "no-inline",
      run: noopWasmLoop,
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
    {
      id: "add_i32/wasm.inlineable",
      op: "add_i32",
      impl: "wasm",
      binding: "WebAssembly",
      size: null,
      // The runtime's default: V8 can inline the WASM call into the JS loop.
      strategy: "inlineable",
      run: addWasmLoop,
    },
    {
      id: "add_i32/wasm.no-inline",
      op: "add_i32",
      impl: "wasm",
      binding: "WebAssembly",
      size: null,
      // Diagnostic: runs only in a V8 process with JS→WASM inlining disabled.
      strategy: "no-inline",
      run: addWasmLoop,
    },
  ];
  const available = (c: Case) =>
    c.impl === "wasm"
      ? wasm !== null && (c.strategy !== "no-inline" || V8_RUNTIME)
      : IMPLS.some((impl) => impl === c.impl);
  const selected = scalar.filter((c) => available(c) && select(c.id));
  // Per size: every path of the same operation together, in canonical order.
  const sums = SUM_I32_SIZES.flatMap((size) => [
    ...IMPLS.filter((impl) => select(`sum_i32/${impl}/${size}`)).map((impl) => sumCase(impl, size)),
    ...WASM_SUM_PATHS.filter((path) => select(`sum_i32/${path}/${size}`)).map((path) => wasmSumCase(path, size)),
  ]);
  const strings = STRING_VARIANTS.flatMap((variant) =>
    PAYLOAD_SIZES.flatMap((bytes) =>
      IMPLS.filter((impl) => select(`string_len/${impl}/${variant}/${bytes}`)).map((impl) =>
        stringLenCase(impl, variant, bytes)
      )
    )
  );
  const buffers = (["bytes_len", "checksum_bytes"] as const).flatMap((op) =>
    PAYLOAD_SIZES.flatMap((bytes) =>
      IMPLS.filter((impl) => select(`${op}/${impl}/${bytes}`)).map((impl) => bytesCase(op, impl, bytes))
    )
  );
  return [...selected, ...sums, ...strings, ...buffers, ...returnCases(select)];
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
 * runtime has it) agrees with the TypeScript reference, for the given
 * suites (those of the cases this process measured). Throws on the first
 * mismatch.
 *
 * Runs after measurement: calling the functions beforehand with overflow
 * and edge-case inputs would shape the JIT's type feedback for the cases
 * being measured.
 */
export function checkEquivalence(suites: readonly Suite[]): void {
  if (suites.includes("boundary")) checkBoundaryPaths();
  if (suites.includes("payload")) checkPayloadPaths();
  if (suites.includes("return")) checkReturn();
}

function checkBoundaryPaths(): void {
  const paths: BoundaryPath[] = [
    { name: "napi", noopReturnsUndefined: () => napiNoop() === undefined, add_i32: napiAdd, sum_i32: napiSum },
  ];
  // Each WASM build is checked through the same copy as its `copy` cases;
  // `resident` cases call the same exported sum on the same values.
  for (const [name, binding] of [["wasm", wasm], ["wasm.simd128", wasmSimd]] as const) {
    if (!binding) continue;
    paths.push({
      name,
      noopReturnsUndefined: () => binding.noop() === undefined,
      add_i32: binding.add_i32,
      sum_i32: (d) => wasmSumOnce(binding, d),
    });
  }
  if (ffi) {
    paths.push({
      name: "ffi",
      noopReturnsUndefined: () => ffi.noop() === undefined,
      add_i32: ffi.add_i32,
      sum_i32: (d) => ffi.sum_i32(d, d.length),
    });
  }
  expectTrue("ts noop returns undefined", tsNoop() === undefined);
  checkBoundary(paths);
}

function checkPayloadPaths(): void {
  const paths: PayloadPath[] = [
    { name: "napi", string_len: napiStringLen, bytes_len: napiBytesLen, checksum_bytes: napiChecksum },
  ];
  if (ffi) {
    paths.push({
      name: "ffi",
      // Same ingress as the benchmark loop: encodeInto, then pointer and byte length.
      string_len: (s) => {
        const scratch = new Uint8Array(s.length * 3);
        return ffi.string_len(scratch, encoder.encodeInto(s, scratch).written!);
      },
      bytes_len: (d) => ffi.bytes_len(d, d.length),
      checksum_bytes: (d) => ffi.checksum_bytes(d, d.length),
    });
  }
  checkPayload(paths);
}

/**
 * Return path: the scalar check is shared (checks.ts); strings, buffers and
 * rows are returned only by Node-API and Bun/Deno FFI, so they are checked here.
 */
function checkReturn(): void {
  checkScalarReturn([{ name: "napi", return_f64: napiReturnF64 }, ...(ffi ? [{ name: "ffi", return_f64: ffi.return_f64 }] : [])]);
  // Each helper returns exactly what the corresponding benchmark loop produces.
  const paths: {
    name: string;
    string(variant: StringVariant, bytes: number): string;
    bytes(bytes: number): Uint8Array;
    rows: [string, (count: number) => Row[]][];
  }[] = [{
    name: "napi",
    string: (variant, bytes) => (variant === "ascii" ? napiReturnAscii(bytes) : napiReturnUtf8(bytes)),
    bytes: napiReturnBytes,
    rows: [["objects", napiReturnRows], ["packed", (count) => decodeRows(napiReturnRowsPacked(count), count)]],
  }];
  if (ffi) {
    paths.push({
      name: "ffi",
      string: (variant, bytes) => {
        const out = new Uint8Array(bytes);
        const written = (variant === "ascii" ? ffi.fill_string_ascii : ffi.fill_string_utf8)(out, bytes);
        expectNumber(`ffi fill_string_${variant} ${bytes} B written`, written, bytes);
        return decoder.decode(out);
      },
      bytes: (bytes) => {
        const out = new Uint8Array(bytes);
        expectNumber(`ffi fill_bytes ${bytes} B written`, ffi.fill_bytes(out, bytes), bytes);
        return out;
      },
      rows: [["packed", (count) => {
        const out = new Uint8Array(count * PACKED_ROW_SIZE);
        expectNumber(`ffi fill_rows_packed ${count} rows written`, ffi.fill_rows_packed(out, out.length), count);
        return decodeRows(out, count);
      }]],
    });
  }

  const expectRows = (label: string, actual: Row[], expected: Row[]) => {
    expectNumber(`${label} length`, actual.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      const a = actual[i];
      const e = expected[i];
      expectString(`${label}[${i}] keys`, Object.keys(a).join(), Object.keys(e).join());
      expectNumber(`${label}[${i}].id`, a.id, e.id);
      expectNumber(`${label}[${i}].score`, a.score, e.score);
      expectTrue(`${label}[${i}].active`, a.active === e.active);
      expectString(`${label}[${i}].name`, a.name, e.name);
    }
  };

  for (const path of paths) {
    for (const variant of STRING_VARIANTS) {
      // 0 and 23 cover the empty string and the utf8 pattern tail.
      for (const bytes of [0, 23, ...RETURN_STRING_SIZES]) {
        const value = path.string(variant, bytes);
        expectString(`${path.name} return_string ${variant} ${bytes} B`, value, ts.expectedReturnString(variant, bytes));
        expectNumber(`${path.name} return_string ${variant} ${bytes} B is UTF-8 sized`, encoder.encode(value).length, bytes);
      }
    }
    // A returned string must not alias native memory reused by later calls.
    const kept = path.string("utf8", 1024);
    path.string("ascii", 64 * 1024);
    expectString(`${path.name} return_string survives a later call`, kept, ts.expectedReturnString("utf8", 1024));

    for (const bytes of [0, ...PAYLOAD_SIZES]) {
      const actual = path.bytes(bytes);
      const expected = tsReturnBytes(bytes);
      const label = `${path.name} return_bytes ${bytes} B`;
      expectTrue(`${label} is a Uint8Array`, actual instanceof Uint8Array);
      // The result owns a whole buffer of its own: not a view into a pool or native memory.
      expectNumber(`${label} byteOffset`, actual.byteOffset, 0);
      expectNumber(`${label} buffer size`, actual.buffer.byteLength, bytes);
      let mismatch = -1;
      for (let i = 0; i < bytes && mismatch < 0; i++) if (actual[i] !== expected[i]) mismatch = i;
      expectNumber(`${label} first differing byte`, mismatch, -1);
    }
    const first = path.bytes(64);
    const second = path.bytes(64);
    first[0] ^= 0xff;
    expectNumber(`${path.name} return_bytes results are independent`, second[0], tsReturnBytes(64)[0]);

    for (const [strategy, make] of path.rows) {
      for (const count of [0, ...ROW_COUNTS]) {
        expectRows(`${path.name}.${strategy} return_rows(${count})`, make(count), tsReturnRows(count));
      }
    }
  }
}
