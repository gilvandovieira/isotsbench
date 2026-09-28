// Benchmark suites: groups of operations that can be run, and officially
// measured, independently. A case's suite follows from its operation, so
// results recorded before suites existed can still be classified.

export const SUITES = {
  /** M1: call overhead and scalar/array arguments. */
  boundary: ["noop", "add_i32", "sum_i32"],
  /** M3: payload ingress, JS → native. */
  payload: ["string_len", "bytes_len", "checksum_bytes"],
  /** M3.5: return path, native → JS. */
  return: ["return_f64", "return_string", "return_bytes", "return_rows"],
} as const;

export type Suite = keyof typeof SUITES;

export const SUITE_NAMES = Object.keys(SUITES) as Suite[];

export function suiteOf(op: string): Suite {
  const suite = SUITE_NAMES.find((name) => (SUITES[name] as readonly string[]).includes(op));
  if (!suite) throw new Error(`operation "${op}" belongs to no suite`);
  return suite;
}

/** Parses a comma-separated suite list, rejecting unknown names. */
export function parseSuites(list: string): Suite[] {
  const names = list.split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    if (!(SUITE_NAMES as string[]).includes(name)) {
      throw new Error(`unknown suite "${name}" (expected ${SUITE_NAMES.join(", ")})`);
    }
  }
  if (!names.length) throw new Error("empty suite list");
  return names as Suite[];
}
