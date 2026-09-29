// Benchmark cases for scriptc: compiled TypeScript (`ts`) and scriptc's
// native FFI to the shared Rust C ABI (`ffi`, binding "scriptc-ffi").
//
// Same operations, sizes, payloads and TS reference implementations as
// bench/common/cases.ts; the loops mirror it one-to-one. They are separate
// because scriptc only turns direct calls of declared functions into
// native calls, and cannot compile the Node-API/Bun/Deno loaders.
//
// Not measured under scriptc (see docs/methodology.md):
// - napi: no JavaScript engine, so no Node-API.
// - return_string, return_bytes and return_rows over FFI: scriptc 0.1.7 can
//   neither return pointers nor pass a writable caller buffer. Their `ts`
//   paths are measured where they exist (return_bytes, return_rows).

import type { Case } from "../common/case.ts";
import { checkBoundary, checkPayload, checkScalarReturn } from "../common/checks.ts";
import {
  bytesPayload,
  makeI32Data,
  PAYLOAD_SIZES,
  ROW_COUNTS,
  STRING_VARIANTS,
  type StringVariant,
  stringPayload,
  SUM_I32_SIZES,
} from "../common/payloads.ts";
import type { Suite } from "../common/suites.ts";
import * as ts from "../common/ts-impl.ts";
import {
  isotsbench_add_i32,
  isotsbench_noop,
  isotsbench_return_f64,
  isotsbench_scriptc_bytes_len,
  isotsbench_scriptc_checksum_bytes,
  isotsbench_scriptc_string_len,
  isotsbench_scriptc_sum_i32,
} from "./native.ts";

const TS = "none";
const FFI = "scriptc-ffi";

/** How data reaches native code on scriptc's FFI (docs/methodology.md). */
const OWNERSHIP = {
  borrowed: "borrowed",
  /** A Uint8Array aliasing the Int32Array's memory, created once per case. */
  byteAlias: "borrowed-byte-alias",
  /** scriptc strings are UTF-8 already: native code borrows them as they are. */
  borrowedString: "borrowed-utf8-string",
  value: "value",
  jsFill: "js-alloc+js-fill",
  jsObjects: "js-objects",
};

// ---- boundary ---------------------------------------------------------------

function noopTsLoop(iterations: number): number {
  for (let i = 0; i < iterations; i++) ts.noop();
  return iterations;
}

function noopFfiLoop(iterations: number): number {
  for (let i = 0; i < iterations; i++) isotsbench_noop();
  return iterations;
}

function addTsLoop(iterations: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = ts.add_i32(acc, i);
  return acc;
}

function addFfiLoop(iterations: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = isotsbench_add_i32(acc, i);
  return acc;
}

function sumTsLoop(iterations: number, data: Int32Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + ts.sum_i32(data)) | 0;
  return acc;
}

function sumFfiLoop(iterations: number, bytes: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + isotsbench_scriptc_sum_i32(bytes)) | 0;
  return acc;
}

/** A Uint8Array over the same memory as `data`; no copy. */
function byteAlias(data: Int32Array<ArrayBuffer>): Uint8Array {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function boundaryCases(select: (id: string) => boolean): Case[] {
  const out: Case[] = [];
  if (select("noop/ts")) out.push({ id: "noop/ts", op: "noop", impl: "ts", binding: TS, size: null, run: noopTsLoop });
  if (select("noop/ffi")) {
    out.push({ id: "noop/ffi", op: "noop", impl: "ffi", binding: FFI, size: null, run: noopFfiLoop });
  }
  if (select("add_i32/ts")) {
    out.push({ id: "add_i32/ts", op: "add_i32", impl: "ts", binding: TS, size: null, run: addTsLoop });
  }
  if (select("add_i32/ffi")) {
    out.push({ id: "add_i32/ffi", op: "add_i32", impl: "ffi", binding: FFI, size: null, run: addFfiLoop });
  }
  for (let i = 0; i < SUM_I32_SIZES.length; i++) {
    const size = SUM_I32_SIZES[i]!;
    const payload = { kind: "int32array" as const, bytes: size * 4 };
    if (select(`sum_i32/ts/${size}`)) {
      const data = makeI32Data(size);
      out.push({
        id: `sum_i32/ts/${size}`,
        op: "sum_i32",
        impl: "ts",
        binding: TS,
        size,
        payload,
        run: (iterations: number) => sumTsLoop(iterations, data),
      });
    }
    if (select(`sum_i32/ffi/${size}`)) {
      const bytes = byteAlias(makeI32Data(size));
      out.push({
        id: `sum_i32/ffi/${size}`,
        op: "sum_i32",
        impl: "ffi",
        binding: FFI,
        size,
        payload,
        ownership: OWNERSHIP.byteAlias,
        run: (iterations: number) => sumFfiLoop(iterations, bytes),
      });
    }
  }
  return out;
}

// ---- payload ----------------------------------------------------------------

function stringLenTsLoop(iterations: number, value: string): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + ts.string_len(value)) | 0;
  return acc;
}

function stringLenFfiLoop(iterations: number, value: string): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + isotsbench_scriptc_string_len(value)) | 0;
  return acc;
}

function bytesLenTsLoop(iterations: number, data: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + ts.bytes_len(data)) | 0;
  return acc;
}

function bytesLenFfiLoop(iterations: number, data: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + isotsbench_scriptc_bytes_len(data)) | 0;
  return acc;
}

function checksumTsLoop(iterations: number, data: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + ts.checksum_bytes(data)) | 0;
  return acc;
}

function checksumFfiLoop(iterations: number, data: Uint8Array): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + isotsbench_scriptc_checksum_bytes(data)) | 0;
  return acc;
}

function stringCases(select: (id: string) => boolean, variant: StringVariant): Case[] {
  const out: Case[] = [];
  for (let i = 0; i < PAYLOAD_SIZES.length; i++) {
    const bytes = PAYLOAD_SIZES[i]!;
    const payload = { kind: variant === "ascii" ? "string-ascii" as const : "string-utf8" as const, bytes };
    if (select(`string_len/ts/${variant}/${bytes}`)) {
      const value = stringPayload(variant, bytes);
      out.push({
        id: `string_len/ts/${variant}/${bytes}`,
        op: "string_len",
        impl: "ts",
        binding: TS,
        size: bytes,
        variant,
        payload,
        run: (iterations: number) => stringLenTsLoop(iterations, value),
      });
    }
    // Named path: scriptc borrows its own UTF-8 string storage, where
    // Node-API and Bun/Deno FFI transcode and copy (docs/methodology.md).
    if (select(`string_len/ffi.borrowed/${variant}/${bytes}`)) {
      const value = stringPayload(variant, bytes);
      out.push({
        id: `string_len/ffi.borrowed/${variant}/${bytes}`,
        op: "string_len",
        impl: "ffi",
        binding: FFI,
        size: bytes,
        variant,
        payload,
        strategy: "borrowed",
        ownership: OWNERSHIP.borrowedString,
        run: (iterations: number) => stringLenFfiLoop(iterations, value),
      });
    }
  }
  return out;
}

function bufferCases(select: (id: string) => boolean, op: "bytes_len" | "checksum_bytes"): Case[] {
  const out: Case[] = [];
  for (let i = 0; i < PAYLOAD_SIZES.length; i++) {
    const bytes = PAYLOAD_SIZES[i]!;
    const payload = { kind: "uint8array" as const, bytes };
    if (select(`${op}/ts/${bytes}`)) {
      const data = bytesPayload(bytes);
      out.push({
        id: `${op}/ts/${bytes}`,
        op,
        impl: "ts",
        binding: TS,
        size: bytes,
        payload,
        run: op === "bytes_len"
          ? (iterations: number) => bytesLenTsLoop(iterations, data)
          : (iterations: number) => checksumTsLoop(iterations, data),
      });
    }
    if (select(`${op}/ffi/${bytes}`)) {
      const data = bytesPayload(bytes);
      out.push({
        id: `${op}/ffi/${bytes}`,
        op,
        impl: "ffi",
        binding: FFI,
        size: bytes,
        payload,
        ownership: OWNERSHIP.borrowed,
        run: op === "bytes_len"
          ? (iterations: number) => bytesLenFfiLoop(iterations, data)
          : (iterations: number) => checksumFfiLoop(iterations, data),
      });
    }
  }
  return out;
}

// ---- return -----------------------------------------------------------------

function returnF64TsLoop(iterations: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc += ts.return_f64();
  return acc;
}

function returnF64FfiLoop(iterations: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc += isotsbench_return_f64();
  return acc;
}

function returnBytesTsLoop(iterations: number, bytes: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + ts.return_bytes(bytes)[bytes - 1]!) | 0;
  return acc;
}

function returnRowsTsLoop(iterations: number, count: number): number {
  let acc = 0;
  for (let i = 0; i < iterations; i++) acc = (acc + ts.return_rows(count)[count - 1]!.id) | 0;
  return acc;
}

function returnCases(select: (id: string) => boolean): Case[] {
  const out: Case[] = [];
  if (select("return_f64/ts")) {
    out.push({
      id: "return_f64/ts",
      op: "return_f64",
      impl: "ts",
      binding: TS,
      size: null,
      ownership: OWNERSHIP.value,
      run: returnF64TsLoop,
    });
  }
  if (select("return_f64/ffi")) {
    out.push({
      id: "return_f64/ffi",
      op: "return_f64",
      impl: "ffi",
      binding: FFI,
      size: null,
      ownership: OWNERSHIP.value,
      run: returnF64FfiLoop,
    });
  }
  for (let i = 0; i < PAYLOAD_SIZES.length; i++) {
    const bytes = PAYLOAD_SIZES[i]!;
    if (select(`return_bytes/ts/${bytes}`)) {
      out.push({
        id: `return_bytes/ts/${bytes}`,
        op: "return_bytes",
        impl: "ts",
        binding: TS,
        size: bytes,
        payload: { kind: "uint8array", bytes },
        ownership: OWNERSHIP.jsFill,
        run: (iterations: number) => returnBytesTsLoop(iterations, bytes),
      });
    }
  }
  for (let i = 0; i < ROW_COUNTS.length; i++) {
    const count = ROW_COUNTS[i]!;
    if (select(`return_rows/ts/${count}`)) {
      out.push({
        id: `return_rows/ts/${count}`,
        op: "return_rows",
        impl: "ts",
        binding: TS,
        size: count,
        payload: { kind: "rows", count },
        ownership: OWNERSHIP.jsObjects,
        run: (iterations: number) => returnRowsTsLoop(iterations, count),
      });
    }
  }
  return out;
}

/** Builds only the selected cases, in the same canonical order as bench/common/cases.ts. */
export function buildCases(select: (id: string) => boolean): Case[] {
  const out: Case[] = boundaryCases(select);
  for (let v = 0; v < STRING_VARIANTS.length; v++) {
    for (const c of stringCases(select, STRING_VARIANTS[v]!)) out.push(c);
  }
  for (const c of bufferCases(select, "bytes_len")) out.push(c);
  for (const c of bufferCases(select, "checksum_bytes")) out.push(c);
  for (const c of returnCases(select)) out.push(c);
  return out;
}

/** Every case id scriptc supports, in canonical order; builds nothing. */
export function buildCaseIds(): string[] {
  const ids: string[] = [];
  buildCases((id: string) => {
    ids.push(id);
    return false;
  });
  return ids;
}

/**
 * Post-measurement checks for the suites this process measured, through the
 * shared checks (bench/common/checks.ts) with scriptc's FFI adapters.
 */
export function checkEquivalence(suites: Suite[]): void {
  if (suites.includes("boundary")) {
    // scriptc cannot compare a void result with undefined; noop's result has
    // no value to check here, so the checks only confirm it can be called.
    ts.noop();
    checkBoundary([{
      name: "ffi",
      noopReturnsUndefined: () => {
        isotsbench_noop();
        return true; // a void native function has no JS value to inspect
      },
      add_i32: (a: number, b: number) => isotsbench_add_i32(a, b),
      sum_i32: (data: Int32Array) => isotsbench_scriptc_sum_i32(byteAlias(data as Int32Array<ArrayBuffer>)),
    }]);
  }
  if (suites.includes("payload")) {
    checkPayload([{
      name: "ffi",
      string_len: (value: string) => isotsbench_scriptc_string_len(value),
      bytes_len: (data: Uint8Array) => isotsbench_scriptc_bytes_len(data),
      checksum_bytes: (data: Uint8Array) => isotsbench_scriptc_checksum_bytes(data),
    }]);
  }
  if (suites.includes("return")) {
    checkScalarReturn([{ name: "ffi", return_f64: () => isotsbench_return_f64() }]);
  }
}
