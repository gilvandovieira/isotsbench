import assert from "node:assert/strict";
import test from "node:test";
import { buildCaseIds, buildCases, checkEquivalence } from "../bench/common/cases.ts";
import { processGroupOf } from "../bench/common/process-groups.ts";

test("WASM paths match TypeScript and disclose their transfer strategy", () => {
  const ids = [
    "noop/ts",
    "noop/wasm.inlineable",
    "add_i32/ts",
    "add_i32/wasm.inlineable",
    "sum_i32/ts/100",
    "sum_i32/wasm.copy/100",
    "sum_i32/wasm.resident/100",
    "sum_i32/wasm.simd128.copy/100",
    "sum_i32/wasm.simd128.resident/100",
  ];
  const cases = buildCases((id) => ids.includes(id));
  assert.equal(cases.length, ids.length);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const expected: [string, string][] = [
    ["noop/wasm.inlineable", "noop/ts"],
    ["add_i32/wasm.inlineable", "add_i32/ts"],
    ["sum_i32/wasm.copy/100", "sum_i32/ts/100"],
    ["sum_i32/wasm.resident/100", "sum_i32/ts/100"],
    ["sum_i32/wasm.simd128.copy/100", "sum_i32/ts/100"],
    ["sum_i32/wasm.simd128.resident/100", "sum_i32/ts/100"],
  ];
  for (const [wasmId, tsId] of expected) {
    assert.equal(byId.get(wasmId)?.run(5), byId.get(tsId)?.run(5), wasmId);
    assert.equal(byId.get(wasmId)?.impl, "wasm");
  }
  assert.equal(byId.get("sum_i32/wasm.copy/100")?.ownership, "js-to-wasm-memory-copy");
  assert.equal(byId.get("sum_i32/wasm.resident/100")?.ownership, "wasm-memory-resident");
  assert.equal(byId.get("sum_i32/wasm.simd128.copy/100")?.binding, "WebAssembly+simd128");
  checkEquivalence(["boundary"]);
});

test("WASM cases sit next to the other paths of the same operation (canonical order)", () => {
  const ids = buildCaseIds();
  const at = (id: string) => ids.indexOf(id);
  // Every path of an operation (and size) is contiguous: WASM right after FFI or Node-API.
  assert.ok(at("noop/wasm.inlineable") > at("noop/napi") && at("noop/wasm.inlineable") < at("add_i32/ts"));
  assert.ok(at("sum_i32/wasm.copy/1") < at("sum_i32/ts/10"));
  assert.ok(at("sum_i32/wasm.simd128.resident/1000000") < at(ids.find((id) => id.startsWith("string_len/"))!));
});

test("no-inline cases belong to their own process group", () => {
  assert.equal(processGroupOf("noop/wasm.no-inline"), "wasm-no-inline");
  assert.equal(processGroupOf("noop/wasm.inlineable"), "default");
  assert.equal(processGroupOf("sum_i32/wasm.copy/10"), "default");
});
