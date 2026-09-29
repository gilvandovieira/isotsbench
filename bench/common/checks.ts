// Post-measurement correctness checks shared by every runtime's runner.
// Each runner passes adapters for its native paths; each adapter must do
// exactly what the corresponding benchmark loop does.
//
// Written in plain, explicitly typed TypeScript (no `unknown`, tuples or
// unguarded indexed reads) so the same checks also compile under scriptc.

import * as ts from "./ts-impl.ts";
import { bytesPayload, makeI32Data, PAYLOAD_SIZES, STRING_VARIANTS, stringPayload, SUM_I32_SIZES } from "./payloads.ts";

export interface BoundaryPath {
  name: string;
  /** Calls noop and reports whether it returned `undefined`. */
  noopReturnsUndefined(): boolean;
  add_i32(a: number, b: number): number;
  sum_i32(data: Int32Array): number;
}

export interface PayloadPath {
  name: string;
  string_len(value: string): number;
  bytes_len(data: Uint8Array): number;
  checksum_bytes(data: Uint8Array): number;
}

export interface ScalarReturnPath {
  name: string;
  return_f64(): number;
}

export function fail(label: string, actual: string, expected: string): never {
  throw new Error(`equivalence check failed: ${label}: got ${actual}, expected ${expected}`);
}

export function expectNumber(label: string, actual: number, expected: number): void {
  if (actual !== expected) fail(label, `${actual}`, `${expected}`);
}

export function expectString(label: string, actual: string, expected: string): void {
  if (actual !== expected) fail(label, JSON.stringify(actual), JSON.stringify(expected));
}

export function expectTrue(label: string, value: boolean): void {
  if (!value) fail(label, "false", "true");
}

interface LabelledString {
  label: string;
  value: string;
}

interface LabelledBytes {
  label: string;
  data: Uint8Array;
}

/** noop, i32 overflow, every sum_i32 size (including 0) and an offset view. */
export function checkBoundary(paths: BoundaryPath[]): void {
  const pairs: number[] = [0, 0, 2, 3, -7, 3, 2147483647, 1, -2147483648, -1];
  const view = makeI32Data(64).subarray(3, 40);
  const sizes: number[] = [0, ...SUM_I32_SIZES];
  for (const path of paths) {
    expectTrue(`${path.name} noop returns undefined`, path.noopReturnsUndefined());
    for (let i = 0; i < pairs.length; i += 2) {
      const a = pairs[i]!;
      const b = pairs[i + 1]!;
      expectNumber(`${path.name} add_i32(${a}, ${b})`, path.add_i32(a, b), ts.add_i32(a, b));
    }
    for (let i = 0; i < sizes.length; i++) {
      const data = makeI32Data(sizes[i]!);
      expectNumber(`${path.name} sum_i32 size ${sizes[i]!}`, path.sum_i32(data), ts.sum_i32(data));
    }
    expectNumber(`${path.name} sum_i32 offset view`, path.sum_i32(view), ts.sum_i32(view));
  }
}

/**
 * Every payload size of both string variants plus edge cases (empty, lone
 * and trailing surrogates, a sliced string), and every byte size plus an
 * empty buffer and an offset view. The TS string_len is itself checked
 * against TextEncoder.
 */
export function checkPayload(paths: PayloadPath[]): void {
  const encoder = new TextEncoder();
  const strings: LabelledString[] = [
    { label: "empty", value: "" },
    { label: "lone high surrogate", value: "a\ud800b" },
    { label: "trailing high surrogate", value: "ab\ud83d" },
    { label: "sliced utf8", value: stringPayload("utf8", 1024).slice(1, -1) },
  ];
  for (let v = 0; v < STRING_VARIANTS.length; v++) {
    const variant = STRING_VARIANTS[v]!;
    for (let i = 0; i < PAYLOAD_SIZES.length; i++) {
      const bytes = PAYLOAD_SIZES[i]!;
      const value = stringPayload(variant, bytes);
      expectNumber(`${variant} payload of ${bytes} B has that many UTF-8 bytes`, encoder.encode(value).length, bytes);
      strings.push({ label: `${variant} ${bytes} B`, value });
    }
  }
  for (const s of strings) {
    expectNumber(`ts string_len ${s.label} matches TextEncoder`, ts.string_len(s.value), encoder.encode(s.value).length);
  }
  const buffers: LabelledBytes[] = [{ label: "0 B", data: bytesPayload(0) }];
  for (let i = 0; i < PAYLOAD_SIZES.length; i++) {
    const bytes = PAYLOAD_SIZES[i]!;
    buffers.push({ label: `${bytes} B`, data: bytesPayload(bytes) });
  }
  buffers.push({ label: "offset view", data: bytesPayload(1024).subarray(3, 1000) });

  for (const path of paths) {
    for (const s of strings) {
      expectNumber(`${path.name} string_len ${s.label}`, path.string_len(s.value), ts.string_len(s.value));
    }
    for (const b of buffers) {
      expectNumber(`${path.name} bytes_len ${b.label}`, path.bytes_len(b.data), ts.bytes_len(b.data));
      expectNumber(`${path.name} checksum_bytes ${b.label}`, path.checksum_bytes(b.data), ts.checksum_bytes(b.data));
    }
  }
}

/** Scalar return: every path returns the TS value. */
export function checkScalarReturn(paths: ScalarReturnPath[]): void {
  expectNumber("ts return_f64", ts.return_f64(), 1.5);
  for (const path of paths) expectNumber(`${path.name} return_f64`, path.return_f64(), ts.return_f64());
}
