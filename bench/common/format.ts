// Plain-text table output shared by the runtime runner and the orchestrator.

export function formatNs(ns: number): string {
  if (ns < 10) return `${ns.toFixed(2)} ns`;
  if (ns < 1e3) return `${ns.toFixed(1)} ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${(ns / 1e6).toFixed(2)} ms`;
}

export function formatRate(perSecond: number): string {
  if (perSecond >= 1e9) return `${(perSecond / 1e9).toFixed(2)} G`;
  if (perSecond >= 1e6) return `${(perSecond / 1e6).toFixed(2)} M`;
  if (perSecond >= 1e3) return `${(perSecond / 1e3).toFixed(2)} k`;
  return perSecond.toFixed(1);
}

export function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => rows.reduce((w, r) => (r[i].length > w ? r[i].length : w), h.length));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

/**
 * A case id without its implementation segment ("string_len/napi/utf8/64"
 * → "string_len/utf8/64"): the key that TS and native results are compared on.
 */
export function caseGroup(id: string): string {
  const parts = id.split("/");
  parts.splice(1, 1);
  return parts.join("/");
}

// bytes_len only hands a buffer over and never reads it, and a "borrowed"
// path (scriptc's string ingress) passes the string's own bytes without
// reading or converting them: their time does not depend on the payload
// size, so a data rate would be meaningless.
const PAYLOAD_NOT_READ = new Set(["bytes_len"]);

/**
 * Payload throughput: bytes/s for byte-sized payloads, records/s for rows,
 * or "-" when there is no payload or it is not read.
 */
export function formatDataRate(
  op: string,
  payload: { bytes?: number; count?: number } | null | undefined,
  nsPerOp: number,
  strategy?: string | null,
): string {
  if (!payload || PAYLOAD_NOT_READ.has(op) || strategy === "borrowed") return "-";
  if (payload.count !== undefined) return `${formatRate((payload.count * 1e9) / nsPerOp)}rows/s`;
  if (payload.bytes !== undefined) return `${formatRate((payload.bytes * 1e9) / nsPerOp)}B/s`;
  return "-";
}
