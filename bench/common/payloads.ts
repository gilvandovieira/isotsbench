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

function lcg(seed: number): () => number {
  let x = seed | 0;
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    return x >>> 8;
  };
}

function fromCodeUnits(units: Uint16Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < units.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, Array.from(units.subarray(i, i + 8192))));
  }
  // join() produces a flat string, so no case pays for flattening a rope.
  return chunks.join("");
}

/** Printable ASCII (0x20–0x7e): one byte per UTF-16 code unit. */
function asciiString(bytes: number): string {
  const next = lcg(0x13579bdf);
  const units = new Uint16Array(bytes);
  for (let i = 0; i < bytes; i++) units[i] = 0x20 + (next() % 95);
  return fromCodeUnits(units);
}

/**
 * Mixed UTF-8 widths, uniformly 1, 2, 3 or 4 bytes per code point:
 * ASCII, Latin-1 Supplement (U+00A0–U+00FF), CJK (U+4E00–U+5DFF) and
 * emoji (U+1F600–U+1F64F, surrogate pairs in UTF-16). Exactly `bytes`
 * UTF-8 bytes.
 */
function utf8String(bytes: number): string {
  const next = lcg(0x2468ace0);
  const units = new Uint16Array(bytes);
  let length = 0;
  for (let left = bytes; left > 0;) {
    const width = Math.min(1 + (next() % 4), left);
    left -= width;
    if (width === 1) units[length++] = 0x20 + (next() % 95);
    else if (width === 2) units[length++] = 0xa0 + (next() % 0x60);
    else if (width === 3) units[length++] = 0x4e00 + (next() % 0x1000);
    else {
      const cp = 0x1f600 + (next() % 0x50) - 0x10000;
      units[length++] = 0xd800 + (cp >> 10);
      units[length++] = 0xdc00 + (cp & 0x3ff);
    }
  }
  return fromCodeUnits(units.subarray(0, length));
}

function uint8array(bytes: number): Uint8Array {
  const next = lcg(0x0badf00d);
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) data[i] = next();
  return data;
}

const cache = new Map<string, string | Uint8Array>();

function cached<T extends string | Uint8Array>(key: string, make: () => T): T {
  let value = cache.get(key) as T | undefined;
  if (value === undefined) cache.set(key, value = make());
  return value;
}

export function stringPayload(variant: "ascii" | "utf8", bytes: number): string {
  return cached(`${variant}:${bytes}`, () => (variant === "ascii" ? asciiString(bytes) : utf8String(bytes)));
}

export function bytesPayload(bytes: number): Uint8Array {
  return cached(`bytes:${bytes}`, () => uint8array(bytes));
}
