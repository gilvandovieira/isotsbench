# isotsbench

**A reproducible benchmark suite that measures the cost of crossing from TypeScript into native code.**

A native function can be much faster than JavaScript and still lose once you count the cost of calling it: entering native code, converting arguments, copying strings and buffers, building results. isotsbench measures that boundary across runtimes and bindings. It shows when crossing is cheap enough to be useful, when it becomes the bottleneck, and how much work must happen on the native side before the crossing pays for itself.

It reports **cost profiles, not winners**: absolute costs, ratios against each runtime's own TypeScript baseline, and break-even sizes.

**Try it:** `make bench-quick`. It needs Rust and Node.js 24+, and uses Bun, Deno, scriptc and the `wasm32-unknown-unknown` Rust target if they are installed. See [Quick start](#quick-start).

## What it measures

| Suite | Operations | What it isolates |
| --- | --- | --- |
| `boundary` | `noop`, `add_i32`, `sum_i32` (1 … 1M elements) | the call itself, scalar conversion, break-even with work |
| `payload` | `string_len` (ASCII, UTF-8), `bytes_len`, `checksum_bytes`, 16 B … 16 MiB | getting strings and buffers into native code |
| `return` | `return_f64`, `return_string`, `return_bytes`, `return_rows` | getting scalars, strings, buffers and row objects back to JS |

Every native path calls the same Rust core, and every native result is checked against a TypeScript reference after measurement. Definitions: [docs/benchmarks.md](docs/benchmarks.md).

## Runtimes and bindings

| Path | Node.js | Bun | Deno | scriptc |
| --- | --- | --- | --- | --- |
| TypeScript baseline (`ts`) | ✓ | ✓ | ✓ | ✓ (compiled) |
| Node-API → Rust (`napi`) | ✓ | ✓ | ✓ | — |
| FFI → C ABI → Rust (`ffi`) | — | ✓ `bun:ffi` | ✓ `Deno.dlopen` | partial |
| WebAssembly → Rust (`wasm`) | boundary | boundary | boundary | — |

A dash means the runtime has no such mechanism:

- Node.js has no stable FFI.
- scriptc has no JavaScript engine, so it has no Node-API.

scriptc's FFI covers the boundary and payload suites and `return_f64`. Its string ingress is measured under its own path name, `ffi.borrowed`, because it borrows the string's bytes with no conversion. See [docs/scriptc.md](docs/scriptc.md).

WASM paths name what they measure:

- **`wasm.inlineable`:** the runtime's default call. V8 inlines small calls, so for `noop` no boundary remains to measure.
- **`wasm.no-inline`:** the same call with inlining disabled (Node.js and Deno).
- **`wasm.copy` / `wasm.resident`:** with and without a per-call copy into linear memory.
- **`wasm.simd128.*`:** the same source built with SIMD.

Payload and return cases over WASM are deferred. See [docs/wasm.md](docs/wasm.md). Browsers, Workers, async calls and a realistic database workload remain planned: [docs/roadmap.md](docs/roadmap.md).

## Quick start

Requirements:

- Linux x86_64, the only verified platform
- Rust (stable); for the WASM paths also `rustup target add wasm32-unknown-unknown` (skipped with a warning when missing)
- Node.js 24+
- optionally Bun, Deno and [scriptc](https://scriptc.dev) (`npm install -g scriptc`); runtimes missing from `PATH` are skipped

The project installs no npm packages or crates.

```bash
make bench-quick                  # smoke run of every suite (numbers not meaningful)
make bench                        # fresh process per case, 1 run
make bench SUITE=payload          # one suite only
make compare RUNS="results/raw/<a> results/raw/<b>"   # compare runs
```

`make` builds everything first:

- the Node-API addon and the C ABI library, into `build/`;
- when the WASM target is installed, `build/isotsbench.wasm` and `build/isotsbench-simd128.wasm` from the shared Rust core;
- when scriptc is installed, `build/isotsbench-scriptc`, which runs without Node.js, Bun or Deno.

Each run writes raw samples and full environment metadata to `results/raw/<run-id>/` and prints summary tables. They show latency, native/TS ratio and throughput per path, and break-even sizes.

For publishable numbers, use the official profile on a prepared machine:

```bash
make bench-official CPUS=8,10     # pinned, fresh and shared processes, shuffled, 3 runs
```

It never changes system settings. It warns when the governor, turbo, pinning or CPU topology make a run unsuitable, and records whether the official criteria were met. See the [official-run procedure](docs/methodology.md#official-run-procedure).

## Documentation

| Document | Contents |
| --- | --- |
| [benchmarks.md](docs/benchmarks.md) | suites, operations, sizes, payloads, case ids, how to read the numbers |
| [methodology.md](docs/methodology.md) | how measurements are taken, isolated, pinned, checked and recorded; options; output format |
| [marshalling.md](docs/marshalling.md) | what each binding copies, borrows, converts or allocates, in both directions; the native libraries |
| [scriptc.md](docs/scriptc.md) | the scriptc integration and how it differs from the other runtimes |
| [wasm.md](docs/wasm.md) | WASM paths: inlining, linear-memory transfer, SIMD builds |
| [findings.md](docs/findings.md) | measured observations so far (development runs, not official results) |
| [limitations.md](docs/limitations.md) | known caveats |
| [design.md](docs/design.md) | motivation, questions, non-goals, how to use the results |
| [roadmap.md](docs/roadmap.md) | what has been built and what is planned |

## Repository layout

```text
native/rust-core/   Rust implementations of every operation; no binding code
native/napi/        raw Node-API binding (the same .node file for Node.js, Bun and Deno)
native/ffi/         plain C ABI for bun:ffi and Deno.dlopen
native/scriptc/     static archive of the same C ABI for scriptc, and its FFI manifest
native/wasm/        WebAssembly ABI over the shared Rust core
bench/run.ts        entry point for Node.js, Bun and Deno
bench/scriptc/      entry point compiled by scriptc
bench/common/       shared harness, cases, checks, payloads and TypeScript references
scripts/            build, orchestration, system probing, run comparison
docs/               documentation
results/raw/        raw run output (git-ignored until published)
```

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.
