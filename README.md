# isotsbench

**A reproducible benchmark suite for measuring the cost of crossing TypeScript/JavaScript runtime boundaries into native code.**

`isotsbench` compares the overhead and behavior of native execution paths across modern TypeScript runtimes and environments, including Node.js, Bun, Deno, browsers, WebAssembly, and compiled TypeScript runtimes such as `scriptc`.

The project asks a simple question:

> **How expensive is crossing the TypeScript native boundary?**

Rather than assuming native code is automatically faster, `isotsbench` measures when crossing that boundary is cheap enough to be useful, when it becomes a bottleneck, and how much work must be performed on the native side before the transition pays for itself.

---

## Status and Usage

Implemented so far:

- operations: `noop()`, `add_i32(a, b)`, `sum_i32(Int32Array)`
- paths, all calling the same Rust core:

| Path | Node.js | Bun | Deno |
| --- | --- | --- | --- |
| pure TypeScript (`ts`) | ✓ | ✓ | ✓ |
| Node-API → Rust (`napi`); the same `.node` file everywhere | ✓ | ✓ | ✓ |
| runtime FFI → C ABI → Rust (`ffi`), via `bun:ffi` / `Deno.dlopen` | none (no stable FFI) | ✓ | ✓ |

Every result records its path (`impl`) and binding mechanism (`binding`). The FFI `sum_i32` receives the typed array as a borrowed pointer plus an explicit length; see [docs/methodology.md](docs/methodology.md#native-libraries).

WASM, browser, scriptc, async, SQLite, normalised datasets and charts are not implemented yet.

### Requirements

- Rust (stable) with `cargo`
- Node.js 24+ (runs the TypeScript directly and drives the benchmark)
- Bun and Deno (optional; any runtime missing from `PATH` is skipped)

No npm packages or crates are required.

### Commands

```bash
make bench                        # build, fresh process per case, shuffled, 1 run, unpinned
make bench-quick                  # smoke run: one process per runtime, short batches (numbers not meaningful)
make bench-official CPUS=8,10     # official profile: pinned via taskset, fresh and shared processes, shuffled, 3 runs (Linux)
make compare RUNS="results/raw/<a> results/raw/<b>"   # run-to-run variance across runs/directories
make build                        # cargo build --release; copies the Node-API addon and the C ABI library to build/
make test                         # Rust unit tests
make check                        # clippy + deno type check of the TypeScript
```

The same commands work without `make`:

```bash
node scripts/bench.ts [--runtimes node,bun,deno] [--isolation case|runtime|both] [--runs N] \
  [--order shuffle|fixed] [--seed N] [--cpus LIST] [--official] \
  [--warmup 5] [--samples 30] [--sample-ms 20] [--filter sum_i32]
node scripts/compare.ts results/raw/<run-id> [results/raw/<run-id> ...]
```

To run a single runtime by hand (after `make build`):

```bash
node bench/run.ts --list                      # case ids this runtime supports
bun  bench/run.ts --filter /ffi               # only the FFI path
node bench/run.ts --case sum_i32/napi/1000 --out node.json
bun  bench/run.ts --filter noop
deno run --allow-read --allow-write --allow-ffi bench/run.ts --out deno.json
```

Each run writes `results/raw/<run-id>/environment.json` plus one `<runtime>.json` per runtime.

- `environment.json` records the machine, the CPU topology, frequency and power settings, and every methodology setting.
- Each `<runtime>.json` holds the raw per-sample timings and the derived median/mean/stddev/min/max ns/op and ops/s.

The summary shows the median ns/op for each runtime, the native/TS ratio and the `sum_i32` break-even size. With `--runs` > 1 it also shows the run-to-run variance.

The harness warns when conditions are unsuitable for official results (unpinned, mixed core types, non-`performance` governor, turbo, …). It never changes system settings itself.

See [docs/methodology.md](docs/methodology.md) for how measurements are taken, the official-run procedure, and known limitations.

### Layout

```text
native/rust-core/   Rust implementations; no binding code
native/napi/        raw Node-API binding (cdylib) over rust-core
native/ffi/         plain C ABI (cdylib) over rust-core, for bun:ffi and Deno.dlopen
bench/run.ts        entry point executed by each runtime
bench/common/       shared cases, TS reference implementations, harness, Node-API and FFI loaders
scripts/            build, orchestration, system probing, run comparison
results/raw/        raw run output (git-ignored)
docs/               methodology
```

This differs from the proposed structure below in one way: there are no per-runtime `bench/node|bun|deno` directories. Every runtime runs the same entry point and the same cases. The only runtime-specific code is `bench/common/ffi.ts`, which picks `bun:ffi` or `Deno.dlopen` to load the same C ABI library.

---

## Motivation

Modern TypeScript applications can execute native code through several different mechanisms:

- Node-API / N-API
- runtime-specific FFI
- WebAssembly
- Web Workers + WebAssembly
- compiled TypeScript with native FFI

These mechanisms have very different execution models.

A native implementation may execute an operation much faster than JavaScript, but the application still has to pay for:

- entering native code;
- converting arguments;
- copying or borrowing buffers;
- converting strings;
- allocating return values;
- constructing JavaScript objects;
- resolving async operations;
- crossing worker boundaries.

For sufficiently large workloads, that overhead may become negligible.

For tiny operations repeated thousands or millions of times, it may dominate the workload entirely.

`isotsbench` exists to measure that boundary.

---

## Guiding Principle

The architectural idea we want to test is:

> **TypeScript describes; native code executes.**

This does **not** mean that every small operation should cross into native code.

Instead, the benchmark should help identify the appropriate granularity for native-backed TypeScript libraries.

For example:

```text
Bad

TypeScript
  ↓
native call
  ↓
TypeScript
  ↓
native call
  ↓
TypeScript
  ↓
native call
```

versus:

```text
Better

TypeScript
  ↓
describe operation
  ↓
one native call
  ↓
native execution over the entire workload
```

This is similar to the execution model used by ecosystems such as NumPy: the high-level language describes the operation while native code performs the expensive work.

---

# Questions

`isotsbench` should answer:

- What is the minimum overhead of a TypeScript/JavaScript → native → TypeScript/JavaScript call?
- How does that overhead differ between runtimes?
- How expensive is scalar argument marshalling?
- How expensive are strings?
- How expensive are buffers and typed arrays?
- Can buffers cross the boundary without copying?
- What is the cost of returning JavaScript objects from native code?
- How expensive is returning hundreds or thousands of rows?
- What is the difference between synchronous and asynchronous native calls?
- How much faster is runtime-specific FFI compared with portable Node-API?
- How does WebAssembly compare with native bindings?
- What additional cost does a Web Worker introduce?
- How expensive are highly chatty APIs?
- How much does batching improve native-backed APIs?
- At what workload size does native execution become faster than pure TypeScript?
- Does binding overhead remain relevant once realistic I/O or database work is introduced?

---

# Runtime Matrix

The benchmark should execute equivalent workloads across as many comparable paths as possible.

## Pure TypeScript

```text
Node.js
Bun
Deno
scriptc
Browser
```

These provide the runtime-local baselines.

## Node.js

```text
TypeScript
    ↓
Node-API
    ↓
Rust
```

## Bun

```text
TypeScript
    ├── Node-API → Rust
    │
    └── bun:ffi → C ABI → Rust
```

## Deno

```text
TypeScript
    ├── Node-API → Rust
    │
    └── Deno FFI → C ABI → Rust
```

## scriptc

```text
TypeScript
    ↓
native FFI
    ↓
C ABI
    ↓
Rust
```

## WebAssembly

```text
Node.js  → WASM
Bun      → WASM
Deno     → WASM
Browser  → WASM
```

## Browser Worker

```text
Application
    ↓
postMessage / transferable data
    ↓
Web Worker
    ↓
WASM
```

The goal is not to declare a universal winner.

The goal is to understand the **cost profile of each boundary**.

---

# Native Benchmark Core

The native implementation should remain intentionally small and deterministic.

Whenever possible, every binding should execute the same Rust implementation.

Initial operations:

```text
noop()
add_i32(a, b)
string_len(value)
bytes_len(data)
sum_i32(data)
reverse_bytes(data)
make_small_object()
make_rows(count)
```

Each operation isolates a different cost.

---

## `noop()`

Measures the minimum possible boundary cost.

```text
TS → native → TS
```

No meaningful work should happen inside the function.

This provides the lower bound for each integration mechanism.

---

## `add_i32(a, b)`

Measures scalar argument and return conversion.

```text
number
number
  ↓
native
  ↓
number
```

---

## `string_len(value)`

Measures UTF-8 / runtime string conversion.

Payload sizes should include values such as:

```text
16 B
64 B
1 KB
16 KB
64 KB
1 MB
```

---

## `bytes_len(data)`

Measures typed-array and buffer transfer.

Example payload sizes:

```text
16 B
64 B
1 KB
64 KB
1 MB
16 MB
```

This benchmark should help identify whether an integration performs:

```text
copy
```

or can use something closer to:

```text
borrow / shared backing memory
```

---

## `sum_i32(data)`

This is one of the most important benchmarks.

Equivalent implementations should exist in TypeScript and Rust.

Example workload sizes:

```text
1
10
100
1,000
10,000
100,000
1,000,000
```

This lets us identify the approximate **break-even point** where native execution compensates for boundary overhead.

---

## `reverse_bytes(data)`

Measures a workload that:

1. receives a buffer;
2. performs work;
3. returns a buffer.

This helps expose return-path and allocation costs.

---

## `make_small_object()`

Measures native → JavaScript object creation.

Example result:

```ts
{
  id: 1,
  active: true,
  score: 42.5,
  name: "example"
}
```

---

## `make_rows(count)`

Measures the cost of returning structured datasets.

Example sizes:

```text
1 row
10 rows
100 rows
1,000 rows
10,000 rows
```

This benchmark may reveal that native execution itself is cheap while constructing thousands of JavaScript objects becomes the dominant cost.

---

# Suite A — Boundary Cost

Suite A isolates the binding itself.

It must avoid:

- databases;
- filesystem access;
- network access;
- intentional sleeps;
- expensive external dependencies.

The purpose is to answer:

> **How much does crossing the boundary itself cost?**

Each native benchmark should have an equivalent pure TypeScript implementation whenever meaningful.

Results should therefore include both:

```text
absolute latency
```

and:

```text
relative cost vs runtime-local TypeScript
```

---

# Suite B — Break-Even and Granularity

Suite B measures when moving work into native code becomes worthwhile.

The primary experiment is:

```text
same algorithm
+
increasing workload size
+
TypeScript implementation
+
Rust implementation
```

For example:

```text
sum_i32
```

over:

```text
1
10
100
1k
10k
100k
1M
```

The resulting curve should make the break-even point visible.

Conceptually:

```text
latency
   │
   │\
   │ \
   │  \ TypeScript
   │   \
   │    \________
   │
   │──────────── Native
   │
   └──────────────────── workload
             ↑
         break-even
```

The exact shape will depend on runtime, binding and workload.

---

# Chatty vs Batched APIs

Native-backed libraries can accidentally create extremely chatty boundaries.

For example:

```ts
for (let i = 0; i < 100_000; i++) {
  native.increment(1);
}
```

versus:

```ts
native.incrementMany(100_000);
```

Both perform the same logical amount of work.

But one crosses the boundary 100,000 times.

The benchmark should compare:

```text
pure TypeScript loop

N native calls

one native call performing N operations
```

This provides practical guidance for API design.

---

# Sync vs Async

Synchronous and asynchronous calls must be benchmarked separately.

These are fundamentally different operations:

```ts
native.add(1, 2);
```

and:

```ts
await native.addAsync(1, 2);
```

Async paths may involve:

- Promise allocation;
- task scheduling;
- runtime queues;
- worker pools;
- Tokio scheduling;
- callback dispatch.

Results must therefore never mix synchronous and asynchronous measurements.

---

# Suite C — Realistic Workload

Microbenchmarks tell us how expensive the boundary is.

They do not tell us whether that cost matters in real applications.

A later benchmark suite should therefore introduce a realistic workload using SQLite.

Possible operations:

```text
SELECT 1

SELECT by primary key

SELECT returning:
1 row
10 rows
100 rows
1,000 rows
10,000 rows

INSERT one row

INSERT many rows individually

INSERT many rows in a batch

UPDATE

DELETE

short transaction

many operations vs transaction/batch
```

The purpose is not to prove that Rust or native drivers are faster.

The purpose is to determine:

> **What fraction of total execution time is caused by the runtime boundary once useful work exists behind it?**

---

# Browser and Isomorphic Execution

Browsers represent a different execution environment and should be benchmarked independently.

At minimum:

```text
JavaScript

JavaScript → WASM

JavaScript
    ↓
Worker
    ↓
WASM
```

A Worker is particularly important because CPU-intensive or storage-heavy browser operations often should not run on the main thread.

That introduces another boundary:

```text
Application
    ↓
message / copy / transfer
    ↓
Worker
    ↓
WASM
```

The benchmark should therefore measure both:

```text
JS → WASM
```

and:

```text
JS → Worker → WASM
```

independently.

---

# Methodology

Microbenchmarks are extremely sensitive to noise.

The benchmark harness should prioritize reproducibility over producing impressive numbers.

## Warmup

Every benchmark should include warmup runs before measurements begin.

This allows:

- JIT compilation;
- runtime initialization;
- caches;
- lazy native initialization;

to stabilize.

---

## Batched Timing

Avoid timing every individual operation.

For very small calls, timer overhead may exceed the cost of the operation being measured.

Instead:

```ts
const start = performance.now();

for (let i = 0; i < iterations; i++) {
  native.noop();
}

const elapsed = performance.now() - start;
```

Then derive:

```text
time / operation
```

from the entire batch.

---

## Multiple Samples

Each benchmark should run several independent samples.

For example:

```text
warmup runs:      5+
measurement runs: 30+
```

Exact values may evolve as the harness matures.

Raw samples must always be preserved.

---

# Metrics

The benchmark should report:

```text
ns/op
µs/op
ops/s

median
mean
standard deviation
minimum
maximum

p95
p99

relative ratio vs TypeScript baseline
```

For very small microbenchmarks, the primary metrics should be:

```text
median
ns/op
ops/s
```

Percentiles should only be reported when the sampling method makes them statistically meaningful.

---

# Break-Even Reporting

For scalable workloads such as:

```text
sum_i32
buffer processing
serialization
row generation
```

the benchmark should report the approximate workload size where:

```text
native execution + boundary cost
```

becomes competitive with:

```text
pure TypeScript execution
```

This is often more useful than the raw boundary cost itself.

---

# Benchmark Environment

Every published benchmark run must record its environment.

At minimum:

```text
CPU
architecture
CPU core count
RAM

operating system
kernel

CPU governor / power profile when relevant

Node.js version
Bun version
Deno version
scriptc version
browser version

rustc version
Rust target
compiler profile
compiler flags

repository commit
```

Results without environment information should not be treated as authoritative.

---

# CI Policy

CI should validate:

```text
does it compile?
does it run?
does every integration still work?
did performance regress catastrophically?
```

CI should **not** be used to generate official performance numbers.

Shared runners introduce too much variation from:

- virtualization;
- CPU scheduling;
- noisy neighbors;
- power management;
- unknown hardware;
- dynamic host load.

Official published results should come from controlled machines with documented environments.

---

# Raw Data

Aggregated numbers must never replace raw measurements.

Suggested structure:

```text
results/
├── raw/
│   └── <run-id>/
│       ├── environment.json
│       ├── node.json
│       ├── bun.json
│       ├── deno.json
│       ├── browser.json
│       └── scriptc.json
│
├── normalized/
│   ├── results.json
│   └── results.csv
│
└── charts/
```

This allows future analysis without rerunning historical benchmarks.

---

# Proposed Repository Structure

```text
isotsbench/
├── native/
│   ├── rust-core/
│   ├── napi/
│   ├── ffi/
│   └── wasm/
│
├── bench/
│   ├── common/
│   ├── node/
│   ├── bun/
│   ├── deno/
│   ├── browser/
│   └── scriptc/
│
├── results/
│   ├── raw/
│   ├── normalized/
│   └── charts/
│
├── scripts/
│
├── docs/
│   ├── methodology.md
│   └── interpretation.md
│
└── README.md
```

Ideally, one command should execute all benchmarks supported by the current machine:

```bash
make bench
```

or an equivalent cross-platform command.

The command should:

1. build the native implementations;
2. execute supported runtime benchmarks;
3. store raw samples;
4. normalize results;
5. generate JSON and CSV datasets;
6. generate or update charts and reports.

---

# Result Presentation

Published results should clearly separate:

## Measured facts

Examples:

```text
Node N-API noop median: X ns/op
Bun FFI noop median: Y ns/op
Deno N-API noop median: Z ns/op
```

## Interpretation

Examples:

```text
FFI reduced call overhead in this environment.

The difference became insignificant once the workload exceeded N elements.

Object construction dominated execution when returning 10,000 rows.
```

Interpretation should never be presented as measured fact.

---

# What We Are Not Trying to Prove

`isotsbench` is not intended to prove that:

- Rust is always faster than TypeScript;
- native code is always better;
- Bun is faster than Node;
- Node is faster than Deno;
- FFI is always better than Node-API;
- WASM is equivalent to native code;
- a single microbenchmark represents application performance.

The project exists specifically to avoid these kinds of assumptions.

---

# Non-Goals

`isotsbench` is not currently intended to:

- build a production native-backed framework;
- design an ORM;
- design a database abstraction;
- design application-level APIs;
- benchmark entire web frameworks;
- rank programming languages;
- produce runtime rankings from a single test;
- use shared CI runners as authoritative performance environments.

Its focus is intentionally narrow:

> **measure runtime and native execution boundaries.**

---

# Decision Framework

The results should help answer architectural questions.

### If native call overhead is negligible

Native-backed TypeScript libraries become attractive even for relatively small operations.

### If runtime-specific FFI is dramatically faster than Node-API

We can measure whether the performance improvement justifies maintaining multiple binding implementations.

### If chatty APIs perform poorly

Native-backed libraries should accumulate work on the TypeScript side and cross the boundary only for coarse operations.

### If returning large JavaScript structures dominates execution

Alternative representations may need investigation:

```text
TypedArrays
packed buffers
columnar layouts
shared memory
Arrow-like formats
```

### If Worker overhead dominates browser execution

Browser architecture may require larger operation granularity than server runtimes.

### If native execution only wins for very large workloads

The benchmark should say so.

That is still a useful result.

---

# Publication Goal

`isotsbench` should eventually produce a public report answering:

> **How expensive is crossing the TypeScript native boundary?**

The report should include:

- methodology;
- hardware and software environment;
- raw benchmark data;
- normalized datasets;
- comparison tables;
- latency charts;
- throughput charts;
- break-even curves;
- interpretation;
- limitations.

Because all raw data and benchmark source code are published, results should be independently reproducible.

---

# Potential Applications

Although `isotsbench` is intentionally application-agnostic, its findings may be useful when designing native-backed TypeScript libraries for workloads such as:

```text
database drivers
image processing
compression
cryptography
parsers
serialization
machine learning
filesystem operations
data processing
scientific computing
application runtimes
```

Different domains may have very different break-even points.

The goal of `isotsbench` is to provide the data needed to reason about those trade-offs.

---

# Philosophy

A native boundary is neither inherently good nor inherently bad.

It is a cost.

Native execution is also a capability.

The interesting engineering question is the relationship between the two:

```text
boundary cost
       vs
work performed behind the boundary
```

`isotsbench` exists to measure that relationship.

**TypeScript describes. Native code executes. Measure where that model makes sense.**

---

# License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.
