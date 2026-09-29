# Design

Why isotsbench exists, what it asks, and how its results are meant to be used. What exists today is in [benchmarks.md](benchmarks.md); what is planned is in [roadmap.md](roadmap.md).

## Motivation

TypeScript applications can execute native code through several mechanisms:

- Node-API
- runtime-specific FFI (`bun:ffi`, Deno FFI)
- compiled TypeScript with native FFI (scriptc)
- WebAssembly, and Web Workers running WebAssembly

These have very different execution models. A native implementation may run an operation much faster than JavaScript, but the application still pays for:

- entering native code
- converting arguments
- copying or borrowing buffers
- converting strings
- allocating return values
- constructing JavaScript objects
- resolving async operations
- crossing worker boundaries

For large enough workloads that overhead may be negligible. For tiny operations repeated millions of times it may dominate. isotsbench measures that boundary: when crossing it is cheap enough to be useful, when it becomes the bottleneck, and how much work must happen on the native side before the crossing pays for itself.

## Guiding principle

The architectural idea under test is:

> **TypeScript describes; native code executes.**

This does **not** mean every small operation should cross into native code. The benchmark should help find the right granularity for native-backed TypeScript libraries:

```text
Chatty                                 Coarse

TypeScript → native call               TypeScript
TypeScript → native call                 ↓ describe the operation
TypeScript → native call               one native call
                                         ↓
                                       native execution over the whole workload
```

This is the model used by ecosystems such as NumPy: the high-level language describes the operation, and native code does the expensive work.

## Questions

Each question is marked with where it is answered today, or with *planned* (see [roadmap.md](roadmap.md)).

| Question | Status |
| --- | --- |
| What is the minimum overhead of a JS → native → JS call? | `noop` (boundary suite) |
| How does that overhead differ between runtimes and bindings? | boundary suite, all runtimes |
| How expensive is scalar argument marshalling? | `add_i32`, `return_f64` |
| How expensive are strings, in and out? | `string_len`, `return_string` |
| How expensive are buffers and typed arrays? Can they cross without copying? | `bytes_len`, `checksum_bytes`, `return_bytes` |
| What does returning JavaScript objects, or thousands of rows, cost? | `return_rows` (named strategies) |
| At what workload size does native beat pure TypeScript? | break-even tables for every sized operation |
| How much faster is runtime-specific FFI than portable Node-API? | Bun and Deno, `napi` vs `ffi` |
| How does compiled TypeScript with native FFI compare? | scriptc |
| How do synchronous and asynchronous native calls differ? | *planned* |
| How expensive are chatty APIs, and how much does batching help? | *planned* |
| How does WebAssembly compare with native bindings? What does a Web Worker add? | WASM boundary suite in Node.js, Bun and Deno; Worker *planned* |
| Does binding overhead still matter once real I/O or database work exists? | *planned* (realistic workload suite) |

## Target matrix

The long-term goal is to run equivalent workloads on every comparable path:

| Environment | Paths | Status |
| --- | --- | --- |
| Node.js | TypeScript; Node-API → Rust; WASM → Rust | implemented, WASM boundary suite only |
| Bun | TypeScript; Node-API → Rust; `bun:ffi` → C ABI → Rust; WASM → Rust | implemented, WASM boundary suite only |
| Deno | TypeScript; Node-API → Rust; Deno FFI → C ABI → Rust; WASM → Rust | implemented, WASM boundary suite only |
| scriptc | compiled TypeScript; native FFI → C ABI → Rust | implemented, with gaps ([scriptc.md](scriptc.md)) |
| Browser | JavaScript → WASM | *planned* |
| Browser | application → `postMessage`/transfer → Worker → WASM | *planned* |

The goal is not to declare a winner, but to understand the **cost profile of each boundary**.

## What isotsbench is not trying to prove

It is not meant to show that:

- Rust is always faster than TypeScript, or that native code is always better
- one runtime is faster than another
- FFI is always better than Node-API
- WASM is equivalent to native code
- a single microbenchmark represents application performance

It is also not meant to be a production native-backed framework, an ORM or database abstraction, a web-framework benchmark, or a ranking of languages or runtimes. Its focus is intentionally narrow: **measure runtime and native execution boundaries.**

## Using the results

The results are meant to inform decisions like these:

- **If call overhead is negligible,** native-backed libraries become attractive even for small operations.
- **If runtime-specific FFI is much faster than Node-API,** the data shows whether that justifies maintaining several bindings.
- **If chatty APIs perform poorly,** native-backed libraries should accumulate work on the TypeScript side and cross the boundary only for coarse operations.
- **If returning large JavaScript structures dominates,** other representations deserve investigation: typed arrays, packed buffers, columnar layouts, shared memory, Arrow-like formats. The `return_rows` strategies are a first measurement of this.
- **If Worker overhead dominates in browsers,** browser code may need coarser operations than server code.
- **If native execution only wins for very large workloads,** the benchmark should say so. That is still a useful result.

Different domains have very different break-even points. Examples: database drivers, image processing, compression, cryptography, parsers, serialization, machine learning, filesystem operations, data processing, scientific computing and application runtimes.

## Philosophy

A native boundary is neither good nor bad. It is a cost, and native execution is a capability. The interesting engineering question is the relationship between the two:

```text
boundary cost  vs  work performed behind the boundary
```

**TypeScript describes. Native code executes. Measure where that model makes sense.**
