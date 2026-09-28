// Pure TypeScript reference implementations. Semantics match
// native/rust-core: i32 arithmetic wraps on overflow.

import { makeRow, type Row } from "./rows.ts";

export function noop(): void {}

export function add_i32(a: number, b: number): number {
  return (a + b) | 0;
}

export function sum_i32(data: Int32Array): number {
  let acc = 0;
  for (let i = 0; i < data.length; i++) acc = (acc + data[i]) | 0;
  return acc;
}

/**
 * UTF-8 byte length of a JS string, as TextEncoder would encode it: lone
 * surrogates count as U+FFFD (3 bytes).
 */
export function string_len(value: string): number {
  const n = value.length;
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < n) {
      const d = value.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function bytes_len(data: Uint8Array): number {
  return data.byteLength;
}

/** 32-bit FNV-1a, returned as an unsigned number. */
export function checksum_bytes(data: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 0x01000193);
  return h >>> 0;
}

// ---- Return path baselines: the same values produced in JS ----------------

export function return_f64(): number {
  return 1.5;
}

/** A new buffer where byte `i` is `(i * 131 + 17) mod 256`, as native `fill_bytes`. */
export function return_bytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 131 + 17) & 0xff;
  return out;
}

export function return_rows(count: number): Row[] {
  const rows = new Array<Row>(count);
  for (let i = 0; i < count; i++) rows[i] = makeRow(i);
  return rows;
}

/** Expected `return_string` results, for the correctness check only (native fill_ascii / fill_utf8). */
export function expectedReturnString(variant: "ascii" | "utf8", bytes: number): string {
  if (variant === "utf8") {
    const pattern = "aé€😀"; // 1 + 2 + 3 + 4 UTF-8 bytes
    return pattern.repeat(Math.floor(bytes / 10)) + "x".repeat(bytes % 10);
  }
  let s = "";
  for (let i = 0; i < bytes; i++) s += String.fromCharCode(33 + (i % 94));
  return s;
}
