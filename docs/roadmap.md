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
| v0.6.0 (unreleased) | WebAssembly boundary paths in Node.js, Bun and Deno: inlineable and no-inline calls, copy and resident input, default and `simd128` builds ([wasm.md](wasm.md)) |

v0.6.0 has one pinned official-profile run of the boundary suite ([findings.md](findings.md#webassembly)). It does not meet the official criteria: those need the performance governor and turbo disabled, which the benchmark runner records but cannot set.

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

### Browsers and Workers

- JavaScript → WASM in browsers (Node.js, Bun and Deno run the boundary suite already)
- Browser: JavaScript → Worker → WASM, measured separately from JS → WASM, because a Worker adds a message, copy or transfer boundary

This will add a `bench/browser/` directory. WASM payload and return paths in the existing runtimes also remain deferred until their transfer semantics can be named and compared honestly.

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

- normalised datasets (`results/normalized/results.json`, `results.csv`) and charts (`results/charts/`)
- a public report answering *how expensive is crossing the TypeScript native boundary?* It would include:
  - methodology and environment
  - raw data and normalised datasets
  - comparison tables
  - latency and throughput charts
  - break-even curves
  - interpretation and limitations
- confidence intervals or statistical tests instead of the 5% spread heuristic

### Continuous integration

CI would check that everything compiles, that every integration still runs, and that performance has not regressed catastrophically. It would never produce official numbers (see [methodology.md](methodology.md#publishing-results)).

### Platforms

Verify macOS; support Windows (Node-API linking against `node.lib`).
