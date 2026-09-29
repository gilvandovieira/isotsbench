// The normalized dataset: complete, traceable to raw records, deterministic, and
// refusing anything that is not a clean official run.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generate, OFFICIAL_RUNS } from "../scripts/normalize-results.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const official = generate();

/** Minimal RFC 4180 reader: quoted fields may hold commas and doubled quotes. */
function parseCsv(text: string): string[][] {
  return text.trimEnd().split("\n").map((line) => {
    const fields: string[] = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') field += c, i++;
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") fields.push(field), field = "";
      else field += c;
    }
    fields.push(field);
    return fields;
  });
}

test("every official case appears once per isolation mode, with every run", () => {
  for (const dir of OFFICIAL_RUNS) {
    const env = JSON.parse(readFileSync(join(ROOT, dir, "environment.json"), "utf8"));
    for (const [environment, ids] of Object.entries(env.methodology.casesByRuntime as Record<string, string[]>)) {
      const mine = official.results.filter((r) => r.source === env.runId && r.environment === environment);
      assert.equal(mine.length, ids.length * 2, `${env.runId} ${environment}`);
      for (const id of ids) {
        const pair = mine.filter((r) => r.id === id);
        assert.deepEqual(pair.map((r) => r.isolation).sort(), ["case", "runtime"], id);
        assert.ok(pair.every((r) => r.run_count === env.methodology.runs), id);
        assert.equal(pair[0].divergent, pair[1].divergent, id);
      }
    }
  }
  assert.equal(official.results.length, 1572);
});

test("every per-run median points to the raw record it came from", () => {
  const raw = new Map<string, Json[]>();
  for (const r of official.results) {
    for (const p of r.runs) {
      if (!raw.has(p.file)) raw.set(p.file, JSON.parse(readFileSync(join(ROOT, p.file), "utf8")).results);
      const record = raw.get(p.file)![p.index];
      assert.equal(record.id, r.id, r.key);
      assert.equal(record.isolation, r.isolation, r.key);
      assert.equal(record.run, p.run, r.key);
      assert.equal(record.ns_per_op.median, p.median_ns, r.key);
      assert.equal(record.op, r.op, r.key);
      assert.equal(record.strategy ?? null, r.strategy, r.key);
    }
  }
});

test("unstable records keep their range and are never presented as stable", () => {
  for (const r of official.results) {
    assert.equal(r.stability === "unstable", (r.max_run_ns - r.min_run_ns) / r.median_ns > 0.05, r.key);
    assert.ok(r.min_run_ns <= r.median_ns && r.median_ns <= r.max_run_ns, r.key);
  }
  assert.equal(official.results.filter((r) => r.stability === "unstable").length, 287);
});

test("the CSV holds the same records as the JSON", () => {
  const [header, ...rows] = parseCsv(official.files["results.csv"]);
  assert.equal(rows.length, official.results.length);
  for (const row of rows) assert.equal(row.length, header.length);
  const col = (name: string) => header.indexOf(name);
  rows.forEach((row, i) => {
    const r = official.results[i];
    assert.equal(row[col("key")], r.key);
    assert.equal(Number(row[col("median_ns")]), r.median_ns);
    assert.deepEqual([1, 2, 3].map((n) => Number(row[col(`run${n}_ns`)])), r.runs.map((p) => p.median_ns));
    assert.equal(row[col("version")], r.version);
  });
});

test("metadata records the raw files unchanged since generation", () => {
  const meta = JSON.parse(official.files["metadata.json"]);
  for (const source of meta.sources) {
    for (const file of source.files) {
      const sha = createHash("sha256").update(readFileSync(join(ROOT, file.path))).digest("hex");
      assert.equal(sha, file.sha256, file.path);
    }
    assert.equal(source.official_criteria_met, true);
    assert.equal(source.git.dirty, false);
  }
});

test("generation is deterministic and the committed dataset is current", () => {
  const again = generate();
  for (const [name, content] of Object.entries(official.files)) {
    assert.equal(again.files[name], content, name);
    const path = join(ROOT, "results", "normalized", name);
    assert.ok(existsSync(path), `${path} missing: run node scripts/normalize-results.ts`);
    assert.equal(readFileSync(path, "utf8"), content, `${name} is stale: run node scripts/normalize-results.ts`);
  }
});

// deno-lint-ignore no-explicit-any
type Json = any;

/** A one-case official run directory: `noop/ts` in both modes, 3 runs. */
function fixture(edit: (env: Json, results: Json[]) => void = () => {}): string {
  const root = mkdtempSync(join(os.tmpdir(), "isotsbench-normalize-"));
  const dir = join(root, "results", "raw", "fixture");
  mkdirSync(dir, { recursive: true });
  const env: Json = {
    runId: "fixture",
    runtimes: { node: "v24.21.0" },
    methodology: {
      isolation: "both",
      runs: 3,
      cases: ["noop/ts"],
      casesByRuntime: { node: ["noop/ts"] },
      cpus: "8,10",
    },
    options: { warmup: 5, samples: 30, sampleMs: 20 },
    conditions: { warnings: [], officialCriteriaMet: true },
    failedUnits: [],
    git: { commit: "0".repeat(40), dirty: false },
  };
  const results: Json[] = [];
  for (const isolation of ["case", "runtime"]) {
    for (const run of [1, 2, 3]) {
      results.push({
        id: "noop/ts",
        op: "noop",
        impl: "ts",
        binding: "none",
        size: null,
        variant: null,
        payload: null,
        suite: "boundary",
        strategy: null,
        ownership: null,
        ns_per_op: { median: 1 + run / 100 },
        run,
        isolation,
        sequence: results.length,
      });
    }
  }
  edit(env, results);
  writeFileSync(join(dir, "environment.json"), JSON.stringify(env));
  writeFileSync(join(dir, "node.json"), JSON.stringify({ schema: 2, runtime: "node", results }));
  return root;
}

test("a complete fixture normalizes to one record per mode", () => {
  const root = fixture();
  try {
    const { results } = generate(["results/raw/fixture"], root);
    assert.deepEqual(results.map((r) => r.key), ["fixture/node/case/noop/ts", "fixture/node/runtime/noop/ts"]);
    assert.equal(results[0].median_ns, 1.02);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validation fails on missing runs, missing cases and non-official runs", () => {
  const cases: [string, (env: Json, results: Json[]) => void, RegExp][] = [
    ["missing run", (_, results) => results.splice(1, 1), /runs 1,3, expected 1,2,3/],
    ["missing case", (env) => env.methodology.casesByRuntime.node.push("add_i32/ts"), /add_i32\/ts: missing/],
    ["not official", (env) => env.conditions.officialCriteriaMet = false, /not an official run/],
    ["dirty tree", (env) => env.git.dirty = true, /git tree dirty/],
    ["failed unit", (env) => env.failedUnits.push({}), /failed units present/],
  ];
  for (const [name, edit, error] of cases) {
    const root = fixture(edit);
    try {
      assert.throws(() => generate(["results/raw/fixture"], root), error, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
