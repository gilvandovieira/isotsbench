// Browser and Worker paths, run in real headless browsers. A browser that is
// not installed is skipped (set CHROMIUM_PATH / FIREFOX_PATH to point at one).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildCaseIds } from "../bench/common/cases.ts";
import { suiteOf } from "../bench/common/suites.ts";
import { BROWSER_NAMES, findBrowser, runPage, startServer } from "../scripts/browser.ts";

const server = await startServer();
test.after(() => server.close());

const sha256 = (path: string) => createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex");
const ARTIFACTS: Record<string, string> = {
  default: sha256("../build/isotsbench.wasm"),
  simd128: sha256("../build/isotsbench-simd128.wasm"),
};

test("the server serves type-stripped modules with cross-origin isolation, and nothing outside bench/ and build/", async () => {
  const page = await fetch(`${server.origin}/bench/browser/worker-cases.ts`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(page.headers.get("cross-origin-embedder-policy"), "require-corp");
  const source = await page.text();
  assert.doesNotMatch(source, /import type|: Promise<number>/);
  for (const path of ["/Cargo.toml", "/bench/../Cargo.toml", "/scripts/browser.ts", "/bench/browser/missing.ts"]) {
    assert.equal((await fetch(`${server.origin}${path}`)).status, 404, path);
  }
});

/** The server runtimes' boundary cases that exist in a browser: TypeScript and WASM, without the flag-only no-inline paths. */
const expectedMain = buildCaseIds().filter((id) => {
  const path = id.split("/")[1];
  return suiteOf(id.split("/")[0]) === "boundary" && (path === "ts" || (path.startsWith("wasm.") && path !== "wasm.no-inline"));
});

for (const name of BROWSER_NAMES) {
  const browser = findBrowser(name);
  const skip = browser ? false : `${name} not found (set ${name.toUpperCase()}_PATH)`;
  const open = (query: Record<string, string>) =>
    runPage(browser!, server, new URLSearchParams(query), { timeoutMs: 120_000 }).then((run) => run.data as any);

  test(`${name}: every main-thread and Worker path matches TypeScript, and transfers keep their ownership semantics`, { skip }, async () => {
    // check mode runs every case's batch against the TypeScript case and the
    // post-measurement checks of both threads; any mismatch rejects.
    const data = await open({ mode: "check" });
    assert.deepEqual(data.main, expectedMain);
    const strategies = ["clone", "copy", "transfer", "resident"];
    assert.equal(data.worker.length, 4 + 7 * 2 * strategies.length);
    assert.ok(data.worker.every((id: string) => id.split("/")[1].startsWith("worker.")));
    assert.equal(data.info.crossOriginIsolated, true);
    for (const artifact of data.info.wasm) assert.equal(artifact.sha256, ARTIFACTS[artifact.variant], artifact.variant);
  });

  test(`${name}: bench mode records raw samples for each thread separately`, { skip }, async () => {
    const options = { mode: "bench", warmup: "1", samples: "3", "sample-ms": "2" };
    const main = await open({ ...options, thread: "main", case: "sum_i32/wasm.copy/1000" });
    assert.equal(main.thread, "main");
    assert.equal(main.worker, null);
    assert.deepEqual(main.results.map((r: any) => r.id), ["sum_i32/wasm.copy/1000"]);
    assert.equal(main.results[0].samples_ns.length, 3);
    assert.equal(main.results[0].ownership, "js-to-wasm-memory-copy");

    // A filter selects every matching case of the thread, in canonical order.
    const worker = await open({ ...options, thread: "worker", filter: "worker.wasm.transfer/10" });
    assert.equal(worker.thread, "worker");
    assert.equal(worker.worker.type, "module");
    assert.equal(worker.worker.wasm.sha256, ARTIFACTS.default);
    assert.deepEqual(
      worker.results.map((r: any) => r.id),
      [10, 100, 1000, 10_000, 100_000, 1_000_000].map((size) => `sum_i32/worker.wasm.transfer/${size}`),
    );
    for (const r of worker.results) {
      assert.equal(r.samples_ns.length, 3);
      assert.equal(r.warmup_ns.length, 1);
      assert.equal(r.strategy, "transfer");
      assert.equal(r.ownership, "transfer+wasm-memory-copy+transfer-back");
    }
  });

  test(`${name}: a page error fails the run instead of hanging`, { skip }, async () => {
    await assert.rejects(open({ mode: "bench", thread: "main", case: "noop/napi" }), /no main-thread case matches/);
  });
}
