# Roadmap

What has been built, and what is planned but not implemented. Current capabilities are described in [benchmarks.md](benchmarks.md); current caveats in [limitations.md](limitations.md).

## Implemented

| Release | Adds |
| --- | --- |
| v0.1.0 | Rust core, raw Node-API binding, shared TypeScript harness for Node.js, Bun and Deno; `noop`, `add_i32`, `sum_i32` |
| v0.2.0 | Methodology hardening: fresh process per case, seeded shuffle, CPU pinning, run-condition checks, run-to-run variance, official profile |
| v0.3.0 | Plain C ABI; Bun and Deno FFI paths |
| v0.4.0 | Payload ingress and return-path suites; suite selection |
| v0.5.0 | scriptc: compiled TypeScript and scriptc native FFI ([scriptc.md](scriptc.md)) |
| v0.6.0 | WebAssembly boundary paths in Node.js, Bun and Deno: inlineable and no-inline calls, copy and resident input, default and `simd128` builds ([wasm.md](wasm.md)) |
| v0.7.0 | Browsers (Chromium, Firefox): the boundary suite on the main thread, and main → Worker → TypeScript/WASM paths that separate structured clone, explicit copy and transfer ([browser.md](browser.md)) |
| v0.7.1 | Finalized official evidence and report publication: two official runs, the normalized dataset and the bilingual GitHub Pages report; editorial completion with no benchmark or methodology changes |

The first runs to meet the official criteria cover every runtime path and every browser path of v0.7.0. Their raw data is committed ([findings.md](findings.md#official-results)), with a normalized dataset in `results/normalized/` ([methodology.md](methodology.md#normalized-dataset)). Earlier pinned runs were development runs with `powersave` and turbo on.

## Planned

None of the following exists yet. Each item names its motivating question from [design.md](design.md#questions).

### More operations

The original specification also listed two operations that have not been built:

- `reverse_bytes(data)`: receive a buffer, do work, return a buffer. It would measure a full round trip of data in one call.
- `make_small_object()`: return a single small object. `return_rows` with a count of 1 covers part of this.

A third, `make_rows(count)`, was implemented as `return_rows`, with named row strategies.

### Chatty versus batched APIs

Compare the same logical work done three ways:

- a pure TypeScript loop
- N native calls, for example `native.increment(1)` 100,000 times
- one native call doing N operations, for example `native.incrementMany(100_000)`

This gives direct guidance for API design.

### Asynchronous calls

Measure `await native.addAsync(a, b)` separately from synchronous calls. Async paths add:

- Promise allocation
- task scheduling and runtime queues
- worker pools (for example Tokio)
- callback dispatch

Results must never mix synchronous and asynchronous measurements.

### Browsers and Workers, continued

v0.7.0 runs the boundary suite in Chromium and Firefox, on the main thread and through a Worker ([browser.md](browser.md#not-covered)). Still open:

- WebKit/Safari, which needs a headless WebKit launcher
- `wasm.no-inline` in browsers, if an engine flag can be applied and verified
- `SharedArrayBuffer` + `Atomics` as a zero-copy alternative to messaging, and pipelined messages (throughput rather than round-trip latency)
- payload and return suites through WASM and Workers, once their transfer semantics can be named in both directions. WASM payload and return paths in the server runtimes remain deferred for the same reason.

### Realistic workload suite

Microbenchmarks show how expensive the boundary is, but not whether that matters in an application. A realistic suite using SQLite would measure the operations below. The aim is not to prove native drivers faster, but to find **what fraction of total time the boundary costs once useful work exists behind it.**

- `SELECT 1`
- select by primary key
- selects returning 1, 10, 100, 1,000 or 10,000 rows
- a single insert
- many inserts, individually and batched
- update and delete
- short transactions
- many operations versus one transaction or batch

### Return strategies

A zero-copy return of native-owned memory would be measured as its own named strategy, with its lifetime guarantees documented per binding. The candidates are `napi_create_external_arraybuffer`, `bun:ffi` `toArrayBuffer` with a deallocator, and scriptc if it gains pointer returns. See [marshalling.md](marshalling.md#return-path-native--js) for why this is not done yet.

### Results and publication

- a public report answering *how expensive is crossing the TypeScript native boundary?* A first version is in `site/`: English and Brazilian Portuguese, with interpretation, links to methodology, raw runs and the normalized dataset, and charts drawn from `results/normalized/`. It is published by `.github/workflows/pages.yml`. Still missing: break-even curves and throughput charts.
- confidence intervals or statistical tests instead of the 5% spread heuristic

### Continuous integration

CI would check that everything compiles, that every integration still runs, and that performance has not regressed catastrophically. It would never produce official numbers (see [methodology.md](methodology.md#publishing-results)). The Pages workflow already checks the dataset and the report on every push to `main`, but builds no native code and runs no benchmark.

### Platforms

Verify macOS; support Windows (Node-API linking against `node.lib`).
