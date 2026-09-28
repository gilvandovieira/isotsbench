# Methodology (milestone 1)

This describes what the harness does today. The README describes where the project is heading.

## Scope

| Operation      | Implementations        | Sizes                                   |
| -------------- | ---------------------- | --------------------------------------- |
| `noop()`       | pure TS, Node-API/Rust | n/a                                     |
| `add_i32(a,b)` | pure TS, Node-API/Rust | n/a                                     |
| `sum_i32(arr)` | pure TS, Node-API/Rust | 1, 10, 100, 1k, 10k, 100k, 1M elements  |

Runtimes: Node.js, Bun, Deno. All synchronous. There are no WASM, FFI, browser, scriptc, async or SQLite paths yet.

## One addon, three runtimes

`native/napi` is a single `cdylib` written against the raw Node-API C ABI. It does not use napi-rs, so the numbers reflect Node-API itself and not the overhead of a binding framework. It calls into `native/rust-core`, which has no knowledge of Node-API.

Every runtime loads the **same `build/isotsbench_napi.node` file** the same way: `createRequire(import.meta.url)(path)`. Deno needs `--allow-read --allow-write --allow-ffi` to do this; the rest of the benchmark code has no runtime-specific branches.

`sum_i32` borrows the `Int32Array` backing store via `napi_get_typedarray_info`. It does not copy.

## Shared TypeScript

`bench/` is plain TypeScript run directly by each runtime (Node.js 24+ with built-in type stripping, Bun, Deno). It uses only erasable syntax and `node:` built-ins. Nothing is transpiled or bundled.

## Measurement

For each case, in `bench/common/harness.ts`:

1. **Calibrate.** Double the batch size until one batch takes at least `--sample-ms` (default 20 ms), then scale the batch to that target. The resulting `iterations` is fixed for the case and recorded.
2. **Warmup.** Run `--warmup` batches (default 5). Their timings are saved as `warmup_ns` and left out of the statistics.
3. **Sample.** Run `--samples` batches (default 30). Each one is timed as a whole with `process.hrtime.bigint()`, which has ns resolution in all three runtimes.

ns/op = batch ns / iterations. The reported statistics (median, mean, sample stddev, min, max) are computed over the per-sample ns/op values. ops/s = 1e9 / median ns/op. p95/p99 are not reported: with 30 batched samples they would not be meaningful.

### Avoiding common microbenchmark errors

- **Correctness first.** Before timing starts, `checkEquivalence()` checks that TS and native return identical results. The checks cover i32 overflow, empty arrays, every benchmark size and an offset subarray view. A mismatch aborts the run.
- **Monomorphic loops.** Each case owns its loop and calls one hoisted function reference. A shared generic loop that took callbacks would turn polymorphic and penalise whichever case ran later.
- **No dead code.** Each loop folds call results into its return value, and that value is stored in a module-level sink.
- **Isolation.** Each runtime runs in its own process, one after another, never in parallel. Inside that process the cases run in a fixed order.

## Reading the results

- `noop/ts` and `add_i32/ts` get inlined by the JIT and reduce to an empty loop (about one cycle per iteration). The `napi/ts` ratio for these rows therefore compares the boundary against almost nothing. The meaningful number is the absolute native ns/op, which is the boundary cost.
- `sum_i32` compares realistic implementations, not just the boundary. The Rust loop is auto-vectorised and the JS loop is not. Both use wrapping i32 addition.
- **Break-even** (printed by `scripts/bench.ts`) is the smallest measured size from which native is faster than TS at that size *and every larger measured size*. The sizes are decades, so the true crossover lies somewhere between the reported size and the one below it.

## Output

`results/raw/<run-id>/`:

- `environment.json`: CPU, cores, RAM, OS/kernel, CPU governor, platform power profile, runtime versions, rustc version/commit/target, cargo profile, `RUSTFLAGS`, git commit and dirty flag, and harness options.
- `<runtime>.json`: `process.versions` as the runtime reports it, the timer, options, and one entry per case with `iterations`, raw `warmup_ns`, raw `samples_ns`, derived `ns_per_op` stats and `ops_per_s`.

The raw run directories are git-ignored. Commit a run on purpose when you publish it.

## Known limitations

- **CPU frequency and topology are not controlled.** On hybrid CPUs (P/E cores) and under the `powersave` governor, results shift with scheduling. For publishable runs, set the `performance` governor, pin to one core type (for example `taskset -c 0 make bench`) and keep the machine idle. The harness records the governor but does not enforce it.
- Cases share one process per runtime, so JIT or GC state left by earlier cases can affect later ones.
- Only Linux x86_64 has been verified. `native/napi/build.rs` includes the usual macOS `dynamic_lookup` link flags, but they are untested. Windows would need linking against `node.lib` and is unsupported.
- There are no normalised JSON/CSV datasets, charts, or regression checks yet.
