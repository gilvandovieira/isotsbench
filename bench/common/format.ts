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
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}
