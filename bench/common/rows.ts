// The row-like record returned by the return_rows cases, and the JS half of
// the packed strategy. Must match native/rust-core (`row`, `fill_rows_packed`).

export interface Row {
  id: number;
  score: number;
  active: boolean;
  name: string;
}

/** Row `index` of the deterministic dataset; property order matches the native objects. */
export function makeRow(index: number): Row {
  return { id: index, score: index * 0.5 + 0.25, active: index % 3 === 0, name: "row-" + index };
}

/**
 * Bytes per packed row (little-endian): [0,4) id i32 · [4] active u8 ·
 * [5] name length u8 · [6,8) zero · [8,16) score f64 · [16,32) name bytes.
 */
export const PACKED_ROW_SIZE = 32;

const decoder = new TextDecoder();

/** Materialises `count` packed rows as JS objects. */
export function decodeRows(bytes: Uint8Array, count: number): Row[] {
  if (bytes.byteLength !== count * PACKED_ROW_SIZE) {
    throw new Error(`packed rows: expected ${count * PACKED_ROW_SIZE} bytes, got ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows = new Array<Row>(count);
  for (let i = 0, offset = 0; i < count; i++, offset += PACKED_ROW_SIZE) {
    rows[i] = {
      id: view.getInt32(offset, true),
      score: view.getFloat64(offset + 8, true),
      active: bytes[offset + 4] !== 0,
      name: decoder.decode(bytes.subarray(offset + 16, offset + 16 + bytes[offset + 5])),
    };
  }
  return rows;
}
