// Deterministic payloads for the marshalling cases, identical in every
// runtime. Sizes are in bytes: UTF-8 bytes for strings, byteLength for
// typed arrays. Payloads are generated once per process and shared by the
// cases that use them (read-only).

export type PayloadKind = "string-ascii" | "string-utf8" | "uint8array" | "int32array" | "rows";

/** What crosses the boundary: `bytes` for byte-sized data, `count` for records. */
export interface Payload {
  kind: PayloadKind;
  bytes?: number;
  count?: number;
}

/** 16 B, 64 B, 1 KiB, 64 KiB, 1 MiB, 16 MiB. */
export const PAYLOAD_SIZES = [16, 64, 1024, 64 * 1024, 1024 * 1024, 16 * 1024 * 1024];
/** sum_i32 element counts. */
export const SUM_I32_SIZES = [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000];
export type StringVariant = "ascii" | "utf8";
export const STRING_VARIANTS: readonly StringVariant[] = ["ascii", "utf8"];
/** UTF-8 bytes of the returned strings. */
export const RETURN_STRING_SIZES = [16, 64, 1024, 64 * 1024];
export const ROW_COUNTS = [1, 10, 100, 1_000, 10_000];

function lcg(seed: number): () => number {
  let x = seed | 0;
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    return x >>> 8;
  };
}

/**
 * Joins single-code-point strings in chunks. join() produces a flat string,
 * so no case pays for flattening a rope; it also avoids typed-array and
 * `apply` tricks that not every runtime (scriptc) supports.
 */
class StringBuilder {
  private readonly chunks: string[] = [];
  private parts: string[] = [];

  push(part: string): void {
    this.parts.push(part);
    if (this.parts.length === 4096) {
      this.chunks.push(this.parts.join(""));
      this.parts = [];
    }
  }

  build(): string {
    this.chunks.push(this.parts.join(""));
    return this.chunks.join("");
  }
}

/** Printable ASCII (0x20–0x7e): one byte per UTF-16 code unit. */
function asciiString(bytes: number): string {
  const next = lcg(0x13579bdf);
  const out = new StringBuilder();
  for (let i = 0; i < bytes; i++) out.push(String.fromCharCode(0x20 + (next() % 95)));
  return out.build();
}

/**
 * Mixed UTF-8 widths, uniformly 1, 2, 3 or 4 bytes per code point:
 * ASCII, Latin-1 Supplement (U+00A0–U+00FF), CJK (U+4E00–U+5DFF) and
 * emoji (U+1F600–U+1F64F, surrogate pairs in UTF-16). Exactly `bytes`
 * UTF-8 bytes.
 */
function utf8String(bytes: number): string {
  const next = lcg(0x2468ace0);
  const out = new StringBuilder();
  for (let left = bytes; left > 0;) {
    const draw = 1 + (next() % 4);
    const width = draw < left ? draw : left;
    left -= width;
    if (width === 1) out.push(String.fromCharCode(0x20 + (next() % 95)));
    else if (width === 2) out.push(String.fromCharCode(0xa0 + (next() % 0x60)));
    else if (width === 3) out.push(String.fromCharCode(0x4e00 + (next() % 0x1000)));
    else {
      const cp = 0x1f600 + (next() % 0x50) - 0x10000;
      out.push(String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)));
    }
  }
  return out.build();
}

function uint8array(bytes: number): Uint8Array {
  const next = lcg(0x0badf00d);
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) data[i] = next();
  return data;
}

const strings = new Map<string, string>();
// A short list rather than a Map: scriptc cannot store Uint8Array values in a Map.
const buffers: { bytes: number; data: Uint8Array }[] = [];

export function stringPayload(variant: "ascii" | "utf8", bytes: number): string {
  const key = `${variant}:${bytes}`;
  let value = strings.get(key);
  if (value === undefined) {
    value = variant === "ascii" ? asciiString(bytes) : utf8String(bytes);
    strings.set(key, value);
  }
  return value;
}

export function bytesPayload(bytes: number): Uint8Array {
  for (const entry of buffers) if (entry.bytes === bytes) return entry.data;
  const data = uint8array(bytes);
  buffers.push({ bytes, data });
  return data;
}

/** Deterministic pseudo-random i32 values (LCG), for sum_i32. */
export function makeI32Data(size: number): Int32Array<ArrayBuffer> {
  const data = new Int32Array(size);
  let x = 0x2545f491;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    data[i] = x;
  }
  return data;
}
