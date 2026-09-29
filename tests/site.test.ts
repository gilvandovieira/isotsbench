// The static site: both languages carry the same keys and placeholders, every
// key the page uses exists, no copy is left unused, inline markup is balanced,
// and the qualitative claims in the copy hold for the normalized dataset.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("../site/", import.meta.url));
const html = readFileSync(join(SITE, "index.html"), "utf8");
const chartsJs = readFileSync(join(SITE, "charts.js"), "utf8");
// deno-lint-ignore no-explicit-any
type Json = any;
const catalogs: Record<string, Json> = Object.fromEntries(
  readdirSync(join(SITE, "i18n")).map((
    f,
  ) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(SITE, "i18n", f), "utf8"))]),
);

/** Every leaf as "path: type", arrays by index. */
function shape(node: Json, prefix = ""): string[] {
  if (typeof node === "string") return [`${prefix}: string`];
  if (Array.isArray(node)) {
    return [
      `${prefix}: array(${node.length})`,
      ...node.flatMap((v, i) => shape(v, `${prefix}.${i}`)),
    ];
  }
  return Object.entries(node).flatMap(([k, v]) => shape(v, prefix ? `${prefix}.${k}` : k));
}
const strings = (catalog: Json) => shape(catalog).filter((s) => s.endsWith(": string")).map((s) => s.split(": ")[0]);

const lookup = (catalog: Json, key: string) => key.split(".").reduce((node, part) => node?.[part], catalog);
const attr = (name: string) => [...html.matchAll(new RegExp(`${name}="([^"]+)"`, "g"))].map((m) => m[1]);
const charts = attr("data-chart");
/** Chart builders in charts.js: the methods of `const CHARTS = { … }`. */
const chartNames = [...chartsJs.matchAll(/^ {2}(\w+)\(data, t, f\) \{$/gm)].map((m) => m[1]);
const usedKeys = [
  ...attr("data-i18n"),
  ...attr("data-i18n-code"),
  ...attr("data-i18n-list"),
  ...attr("data-i18n-attr").flatMap((v) => v.split(";").map((pair) => pair.split(":")[1])),
  "meta.title",
  "meta.description",
  ...new Set([...chartsJs.matchAll(/"(charts\.[\w.]+)"/g)].map((m) => m[1])),
  ...chartNames.flatMap((name) => ["title", "reading", "description", "axis"].map((k) => `charts.${name}.${k}`)),
];

test("English and Brazilian Portuguese have the same keys and placeholders", () => {
  assert.deepEqual(Object.keys(catalogs).sort(), ["en", "pt-BR"]);
  assert.deepEqual(shape(catalogs["pt-BR"]), shape(catalogs.en));
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of strings(catalogs.en)) {
    assert.deepEqual(placeholders(lookup(catalogs["pt-BR"], key)), placeholders(lookup(catalogs.en, key)), key);
  }
});

test("every key the page uses exists, as a string or a list of strings", () => {
  for (const key of usedKeys) {
    const value = lookup(catalogs.en, key);
    const list = attr("data-i18n-list").includes(key);
    if (list) assert.ok(Array.isArray(value) && value.every((v: Json) => typeof v === "string"), key);
    else assert.equal(typeof value, "string", key);
  }
});

test("no copy is left unused", () => {
  const used = (leaf: string) => usedKeys.some((key) => leaf === key || leaf.startsWith(`${key}.`));
  assert.deepEqual(strings(catalogs.en).filter((leaf) => !used(leaf)), []);
});

test("every chart container has a builder, and every builder a container", () => {
  assert.ok(chartNames.length > 0);
  assert.deepEqual([...charts].sort(), [...chartNames].sort());
});

test("inline markup is balanced and links are https or in-page", () => {
  for (const [lang, catalog] of Object.entries(catalogs)) {
    for (const key of strings(catalog)) {
      if (attr("data-i18n-code").includes(key)) continue;
      const text: string = lookup(catalog, key);
      assert.equal((text.match(/`/g) ?? []).length % 2, 0, `${lang} ${key}: unbalanced backticks`);
      assert.equal((text.match(/\*\*/g) ?? []).length % 2, 0, `${lang} ${key}: unbalanced **`);
      for (const [, href] of text.matchAll(/\]\(([^)]*)\)/g)) assert.match(href, /^(https:\/\/|#)/, `${lang} ${key}`);
      assert.doesNotMatch(text, /<[a-z/]/i, `${lang} ${key}: HTML is not interpreted`);
    }
  }
});

test("the language switch offers every catalog", () => {
  assert.deepEqual(attr("data-lang").sort(), Object.keys(catalogs).sort());
});

test("the page reads the normalized dataset and quotes no times of its own", () => {
  assert.match(chartsJs, /fetch\("data\/results\.json"\)/);
  const linked = readFileSync(join(SITE, "data", "results.json"), "utf8");
  const generated = readFileSync(join(SITE, "..", "results", "normalized", "results.json"), "utf8");
  assert.equal(linked, generated);
  for (const [lang, catalog] of Object.entries(catalogs)) {
    for (const key of strings(catalog)) {
      // "20 ms" is the harness's batch length (a setting), not a measurement.
      const text = lookup(catalog, key).replaceAll("20 ms", "");
      assert.doesNotMatch(text, /\d\s?(ns|µs|ms)\b/, `${lang} ${key} quotes a time`);
    }
  }
});

// ---- The copy's qualitative claims, checked against the data.

const records: Json[] = JSON.parse(readFileSync(join(SITE, "..", "results", "normalized", "results.json"), "utf8"));
const byKey = new Map(records.map((r) => [`${r.environment}|${r.isolation}|${r.id}`, r]));
const get = (env: string, isolation: string, id: string): number => {
  const r = byKey.get(`${env}|${isolation}|${id}`);
  assert.ok(r, `no record ${env} ${isolation} ${id}`);
  return r.median_ns;
};
const MODES = ["case", "runtime"];

test("claim: FFI was the cheapest real call in each runtime that has it; Node-API cost several times more, most in Bun", () => {
  const realCalls: Record<string, string[]> = {
    bun: ["napi", "wasm.inlineable"],
    deno: ["napi", "wasm.no-inline"],
    scriptc: [],
  };
  for (const [env, others] of Object.entries(realCalls)) {
    for (const path of others) {
      assert.ok(get(env, "case", "noop/ffi") < get(env, "case", `noop/${path}`), `${env} ${path}`);
    }
  }
  for (const env of ["bun", "deno"]) assert.ok(get(env, "case", "noop/napi") > 3 * get(env, "case", "noop/ffi"), env);
  for (const env of ["node", "deno"]) assert.ok(get("bun", "case", "noop/napi") > get(env, "case", "noop/napi"), env);
});

test("claim: in Node.js and Deno the default WebAssembly call costs exactly the empty loop", () => {
  for (const env of ["node", "deno"]) {
    for (const mode of MODES) {
      const ratio = get(env, mode, "noop/wasm.inlineable") / get(env, mode, "noop/ts");
      assert.ok(Math.abs(ratio - 1) < 0.01, `${env} ${mode}: ${ratio}`);
    }
  }
});

test("claim: at 10⁶ elements every Node-API and FFI sum converges", () => {
  const values = [["node", "napi"], ["bun", "napi"], ["bun", "ffi"], ["deno", "napi"], ["deno", "ffi"], [
    "scriptc",
    "ffi",
  ]]
    .flatMap(([env, p]) => MODES.map((m) => get(env, m, `sum_i32/${p}/1000000`)));
  assert.ok(Math.max(...values) / Math.min(...values) < 1.1);
});

test("claim: WebAssembly copy and code generation are comparable; the copy exceeds the native sum; simd128 nears native", () => {
  for (const env of ["node", "bun", "deno"]) {
    const copy = get(env, "case", "sum_i32/wasm.copy/1000000");
    const resident = get(env, "case", "sum_i32/wasm.resident/1000000");
    const native = get(env, "case", "sum_i32/napi/1000000");
    const share = (copy - resident) / (resident - native);
    assert.ok(share > 0.5 && share < 2, `${env}: ${share}`);
    assert.ok(copy - resident > native, env);
    assert.ok(get(env, "case", "sum_i32/wasm.simd128.resident/1000000") / native < 1.6, env);
  }
});

test("claim: through Node-API, mixed UTF-8 never beat TypeScript in Node.js or Deno", () => {
  for (const env of ["node", "deno"]) {
    for (const size of [16, 64, 1024, 65536, 1048576, 16777216]) {
      for (const mode of MODES) {
        const native = get(env, mode, `string_len/napi/utf8/${size}`);
        assert.ok(native >= get(env, mode, `string_len/ts/utf8/${size}`), `${env} ${size} ${mode}`);
      }
    }
  }
});

test("claim: ASCII in and a new buffer out were faster through Node-API at 16 MiB", () => {
  for (const env of ["node", "bun", "deno"]) {
    for (const mode of MODES) {
      assert.ok(get(env, mode, "string_len/napi/ascii/16777216") < get(env, mode, "string_len/ts/ascii/16777216"));
      assert.ok(get(env, mode, "return_bytes/napi/16777216") < get(env, mode, "return_bytes/ts/16777216"));
    }
  }
});

test("claim: no native row strategy beat TypeScript at any size", () => {
  const strategies = [
    ["node", "napi.objects"],
    ["node", "napi.packed"],
    ["bun", "napi.objects"],
    ["bun", "napi.packed"],
    [
      "bun",
      "ffi.packed",
    ],
    ["deno", "napi.objects"],
    ["deno", "napi.packed"],
    ["deno", "ffi.packed"],
  ];
  for (const [env, strategy] of strategies) {
    for (const size of [1, 10, 100, 1000, 10000]) {
      for (const mode of MODES) {
        const native = get(env, mode, `return_rows/${strategy}/${size}`);
        assert.ok(native > get(env, mode, `return_rows/ts/${size}`), `${env} ${strategy} ${size} ${mode}`);
      }
    }
  }
});

test("claim: a Worker round trip costs thousands of main-thread calls, and moving input outweighs the work", () => {
  for (const browser of ["chromium", "firefox"]) {
    const trip = get(`${browser}.worker`, "case", "noop/worker.ts");
    assert.ok(trip > 1000 * get(`${browser}.main`, "case", "add_i32/wasm.inlineable"), browser);
    const resident = get(`${browser}.worker`, "case", "sum_i32/worker.wasm.resident/1000000");
    for (const strategy of ["copy", "clone"]) {
      const added = get(`${browser}.worker`, "case", `sum_i32/worker.wasm.${strategy}/1000000`) - resident;
      assert.ok(added > resident - trip, `${browser} ${strategy}`);
    }
  }
});

test("claim: the JIT examples diverge in opposite directions and the controls do not", () => {
  const divergent = (env: string, id: string) => byKey.get(`${env}|case|${id}`).divergent;
  assert.equal(divergent("node", "sum_i32/ts/1000000"), true);
  assert.equal(divergent("deno", "checksum_bytes/ts/16777216"), true);
  assert.ok(get("node", "runtime", "sum_i32/ts/1000000") < get("node", "case", "sum_i32/ts/1000000"));
  assert.ok(get("deno", "runtime", "checksum_bytes/ts/16777216") > get("deno", "case", "checksum_bytes/ts/16777216"));
  assert.equal(divergent("bun", "sum_i32/ts/1000000"), false);
  assert.equal(divergent("scriptc", "sum_i32/ts/1000000"), false);
});

/** Largest shared/fresh factor (either direction) among one environment's divergent cases. */
function largestDivergence(env: string): number {
  let largest = 1;
  // Only divergent cases: an unstable case whose run ranges overlap is not evidence either way.
  for (const r of records.filter((r) => r.environment === env && r.isolation === "case" && r.divergent)) {
    const shared = get(env, "runtime", r.id);
    largest = Math.max(largest, shared / r.median_ns, r.median_ns / shared);
  }
  return largest;
}

test("claim: fresh/shared differences of several times appeared only in V8; scriptc stayed close", () => {
  for (const env of ["node", "deno", "chromium.main"]) assert.ok(largestDivergence(env) > 5, env);
  for (const env of ["bun", "firefox.main", "firefox.worker"]) assert.ok(largestDivergence(env) < 1.5, env);
  assert.ok(largestDivergence("scriptc") < 1.1);
});

test("claim: a new 16-byte buffer cost more through Node-API than in TypeScript in Node.js and Bun", () => {
  for (const env of ["node", "bun"]) {
    for (const mode of MODES) {
      assert.ok(get(env, mode, "return_bytes/napi/16") > get(env, mode, "return_bytes/ts/16"), `${env} ${mode}`);
    }
  }
});
