# Methodology

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

Every runtime loads the **same `build/isotsbench_napi.node` file** the same way: `createRequire(import.meta.url)(path)`. Deno runs with `--allow-read --allow-write --allow-ffi`; the benchmark code has no runtime-specific branches.

`sum_i32` borrows the `Int32Array` backing store via `napi_get_typedarray_info`. It does not copy.

## Shared TypeScript

`bench/` is plain TypeScript run directly by each runtime (Node.js 24+ with built-in type stripping, Bun, Deno). It uses only erasable syntax and `node:` built-ins. Nothing is transpiled or bundled.

## Measurement inside one process

For each case, in `bench/common/harness.ts`:

1. **Calibrate.** Double the batch size until one batch takes at least `--sample-ms` (default 20 ms), then scale the batch to that target. The resulting `iterations` is fixed for the case and recorded.
2. **Warmup.** Run `--warmup` batches (default 5). Their timings are saved as `warmup_ns` and left out of the statistics.
3. **Sample.** Run `--samples` batches (default 30). Each one is timed as a whole with `process.hrtime.bigint()`, which has ns resolution in all three runtimes.

ns/op = batch ns / iterations. The reported statistics (median, mean, sample stddev, min, max) are computed over the per-sample ns/op values. ops/s = 1e9 / median ns/op. p95/p99 are not reported: with 30 batched samples they would not be meaningful.

- **Correctness is checked after measurement.** Once timing is done, `checkEquivalence()` checks that TS and native return identical results: i32 overflow, empty arrays, every benchmark size and an offset subarray view. A mismatch fails the process, and the orchestrator records the unit as failed. The check runs *after* timing on purpose. Calling the functions first with overflowing and edge-case inputs would shape the JIT's type feedback for the code about to be measured.
- **Monomorphic loops.** Each case owns its loop and calls one hoisted function reference. A shared generic loop that took callbacks would turn polymorphic and penalise whichever case ran later.
- **No dead code.** Each loop folds call results into its return value, and that value is stored in a module-level sink.
- **Only the selected case is built.** A process allocates benchmark data only for the cases it runs.

## Process isolation and order

`scripts/bench.ts` runs one process per *unit*, one after another, never in parallel.

- `--isolation case` (default for `make bench`): each (runtime, case) pair gets a fresh process. No case inherits JIT, inline-cache or GC state from another case. Results describe a process that has run only that case.
- `--isolation runtime` (used by `make bench-quick`): one process per runtime runs every case in canonical order. It's faster. Results describe a process with one particular history: earlier cases can change how later cases are compiled.
- `--isolation both` (required for official runs): both kinds of unit in the same repetitions, interleaved by the shuffle. Every result records its `isolation`. Summaries and variance are computed separately per mode and never pooled.

**Both modes are reported because neither is the single right answer.** For some cases V8 reaches different steady states depending on JIT history (see [Evidence](#evidence)). When both modes are present, `scripts/bench.ts` and `scripts/compare.ts` print an **isolation divergence** table. A case appears there when:

- its per-run medians in the two modes don't overlap, **and**
- the two medians differ by more than 5%.

A divergent case must be reported with both numbers. Those rows are a finding about the runtime, not noise.

Within each repetition, `--order shuffle` (the default) randomly permutes all units across runtimes, cases and isolation modes. The permutation comes from a seeded PRNG (mulberry32), so `--seed` from `environment.json` reproduces the schedule exactly. Shuffling stops slow drifts (temperature, background load, turbo headroom) from always landing on the same runtime or case. Every result records its `run` and `sequence` (position in the schedule), so order effects can be analysed afterwards.

## CPU pinning (Linux)

`--cpus LIST` starts every benchmark process with `taskset -c LIST`. The mask covers the whole process: the runtime's main thread and also its JIT compiler and GC helper threads. Each process reports the affinity it actually got:

- `process.allowedCpuCount` via `os.availableParallelism()`, which respects the affinity mask in all three runtimes.
- `process.affinity`, the kernel's `Cpus_allowed_list`, for Node and Bun. Deno refuses to read `/proc` without `--allow-all`. Granting that only for bookkeeping would change how Deno is launched, so its value is `null`.

If either value disagrees with the requested set, the orchestrator aborts the run.

On a platform other than Linux, `--cpus` is rejected. It doesn't silently fall back to running unpinned.

**Choosing the set.** Use CPUs of **one class** (same core type and max frequency), **without SMT siblings**, and preferably not CPU 0, which handles more interrupts. Use at least two CPUs so helper threads don't have to share the benchmark thread's CPU. The harness warns when the set spans CPU classes or contains SMT siblings. Use the `system.cpuClasses` and `system.cpus[].smtSiblings` fields in any `environment.json` to choose. See also [Evidence](#evidence).

## Run conditions

`scripts/system.ts` reads Linux sysfs **without changing anything** and records it under `environment.json → system`:

- per-CPU core type (Intel hybrid `cpu_core`/`cpu_atom`), max frequency, capacity, core/package id, SMT siblings, scaling governor and energy-performance preference
- CPU classes and a `heterogeneous` flag
- scaling driver, intel_pstate status and `no_turbo`, cpufreq `boost`, SMT state, ACPI platform profile
- load average at the start and end of the run

`assessConditions` turns this into `conditions.warnings`, which are printed at the start of every run (and again at the end of official runs). It warns when:

- the run isn't pinned, or the pinned CPUs span CPU classes or include SMT siblings
- the governor isn't `performance` on the relevant CPUs
- the energy-performance preference isn't `performance`
- turbo/boost is enabled
- the platform profile isn't `performance`

On other platforms, the only warning says that conditions are unverified.

The harness **never changes system settings**. To prepare a Linux machine by hand (root required; restore the settings afterwards):

```bash
sudo cpupower frequency-set -g performance                             # governor
echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo        # intel_pstate: disable turbo
echo 0 | sudo tee /sys/devices/system/cpu/cpufreq/boost                # acpi-cpufreq / amd-pstate: disable boost
echo performance | sudo tee /sys/firmware/acpi/platform_profile        # or: powerprofilesctl set performance
```

## Run-to-run variance

A single process can have tight samples and still be wrong: see the tiering effect in [Evidence](#evidence). Numbers only become defensible when separate processes agree.

- `--runs N` repeats the complete matrix N times in one invocation.
- `scripts/compare.ts DIR [DIR ...]` (`make compare RUNS="..."`) treats every repetition of each isolation mode in every run directory as one complete run. Directories recorded before `--isolation both` use the mode stored in their `environment.json`.
  - For each runtime and case it reports the median of the per-run medians, the min and max run, and the spread `(max − min) / median`.
  - Cases above 5% spread are flagged `unstable`.
  - When given several directories, it adds one column per directory and lists any settings that differ between them: commit, runtime versions, isolation, CPUs, harness options, governor, turbo and so on.

When `--runs` > 1, `scripts/bench.ts` prints the same variance table and computes its summary from the median of run medians.

## Official-run procedure

1. Use a machine you control, not shared CI. Close other applications and keep it plugged in.
2. Prepare the conditions by hand (above) and pick a CPU set (above).
3. `make bench-official CPUS=<list>`. This runs `--official`, which requires `--cpus`, `--isolation both`, `--order shuffle` and at least 3 runs. Keep the default harness options (warmup, samples, sample-ms) unless you are deliberately changing the methodology; see below for why they matter.
4. The run ends by printing either `official criteria met` or `official criteria NOT met`. The result is also stored as `conditions.officialCriteriaMet`, which is true only for the official profile with no condition warnings and no failed units.
5. Publish the fresh-process and shared-process results side by side. In the variance table, report every `unstable` case as unstable, not as a single number. Report every case in the isolation divergence table with both numbers.
6. To publish, commit the whole `results/raw/<run-id>/` directory.

## Reading the results

- `noop/ts` and `add_i32/ts` get inlined by the JIT and reduce to an empty loop (about one cycle per iteration). The `napi/ts` ratio for these rows therefore compares the boundary against almost nothing. The meaningful number is the absolute native ns/op, which is the boundary cost.
- `sum_i32` compares realistic implementations, not just the boundary. The Rust loop is auto-vectorised and the JS loop is not. Both use wrapping i32 addition.
- **Break-even** is the smallest measured size from which native is faster than TS at that size *and every larger measured size*. The sizes are decades, so the true crossover lies somewhere between the reported size and the one below it.

## Output

`results/raw/<run-id>/` (git-ignored; commit a run on purpose when you publish it):

- `environment.json`
  - hardware and OS, plus `system` (above) and load averages
  - runtime, rustc and cargo versions, `RUSTFLAGS`, git commit and dirty flag
  - `methodology`: profile, isolation (`case`, `runtime` or `both`), runs, order, seed, CPUs and the exact `taskset` command and version, the runtime command lines, filter, canonical case list, and when equivalence is checked
  - `options`: warmup, samples, sample-ms
  - `conditions`: warnings and `officialCriteriaMet`
  - `failedUnits`
- `<runtime>.json` (schema 2)
  - `process.versions` as the runtime reports it, the timer and options
  - one entry per case per run: `run`, `isolation`, `sequence`, `process` (pid, affinity, allowed CPU count, execArgv, start/end time), `iterations`, raw `warmup_ns` and `samples_ns`, derived `ns_per_op` statistics and `ops_per_s`

Raw sample arrays are copied unchanged from each process's output into these files.

## Evidence

Measured on 2026-09-28:

- **Machine:** i7-12700H (hybrid: CPUs 0–11 are P-cores with SMT pairs; 4–7 boost to 4.7 GHz, the other P-cores to 4.6 GHz; CPUs 12–19 are E-cores at 3.5 GHz).
- **Settings:** `powersave` governor with intel_pstate EPP `performance`, turbo on.
- **Software:** Node 24.21.0, Bun 1.4.2, Deno 2.9.7.
- **Default harness options** unless stated.

These observations support the choices above. They are not official results.

**Pinning doesn't materially distort steady state.** One process per runtime, `--samples 10 --sample-ms 10`, comparing unpinned, `taskset -c 2` and `taskset -c 2,4,6,8`:

| Runtime | Case | Unpinned | 1 CPU | 4 CPUs |
|---|---|---|---|---|
| Node | `noop/napi` | 6.64 ns | 6.73 ns | 6.85 ns |
| Node | `sum_i32/ts/1000` | 547 ns | 558 ns | 548 ns |
| Bun | `add_i32/napi` | 49.7 ns | 44.7 ns | 49.3 ns |
| Bun | `sum_i32/ts/1000` | 214 ns | 217 ns | 213 ns |

The differences are within the run-to-run spread measured below.

**A short warmup can be bimodal in a fresh process.** 8 fresh Node processes each ran only `add_i32/ts`:

- With `--warmup 1 --samples 3 --sample-ms 2`: 3 of 8 processes stayed at about 3.5 ns/op for the whole run; the rest ran at 0.27 ns/op. The samples inside each process were tight either way, so the within-process stddev can't detect this.
- With default settings: 8 of 8 processes ran at 0.270–0.274 ns/op.

**Case isolation versus a shared process: V8 pure-TS loops over large arrays depend on JIT history.** Two runs of the full matrix with `--cpus 8,10 --runs 3`:

- run A: `--isolation case`, shuffled
- run B: `--isolation runtime`, fixed canonical order

Agreement:

- Every Node-API case and every case up to `sum_i32/*/1000` agreed between A and B within the run-to-run noise.
- Every Bun case agreed except `noop/ts`, which differed by 5% at 0.13 ns.

Disagreement: Node and Deno `sum_i32/ts` at 10k, 100k and 1M elements. Each value is the median of 3 runs:

| Case | Node A | Node B | Deno A | Deno B |
|---|---|---|---|---|
| `sum_i32/ts/10000` | 46.6 µs | 5.49 µs | 41.2 µs | 3.88 µs |
| `sum_i32/ts/100000` | 467 µs | 54.8 µs | 413 µs | 36.4 µs |
| `sum_i32/ts/1000000` | 3.60 ms | 550 µs | 4.15 ms | 358 µs |

Cause, from `--trace-opt --trace-deopt`:

1. In a fresh process, V8 first compiles `sum_i32` itself with TurboFan.
2. Then `sumTsLoop` becomes hot and Maglev compiles it, inlining `sum_i32`. Each batch calls `sumTsLoop` only once and loops only a few times inside it, so the hot inner loop keeps running in Maglev code.
3. How long that lasts depends on the size:
   - At 10k elements, `sumTsLoop` reaches TurboFan after about 40 warmup batches and then matches run B (5.4 µs).
   - At 1M elements it stayed in Maglev for all 180 batches of a 150-warmup run, and even slowed from 3.5 to 4.6 ms/op.

In run B, the small-size cases had already pushed `sumTsLoop` into TurboFan with many short calls, so the large sizes inherited faster code.

Neither number is the single right answer. Run A is how a fresh process behaves; run B is how a process behaves after this particular history. That is why official runs measure and report both (`--isolation both`).

**Fresh-process V8 results for these rows also depend on how long the process runs.** For example, Deno `sum_i32/ts/1000000`:

- In run A (5 warmup + 30 samples), a fresh process measured 4.15 ms.
- In a later fresh-process run with `--samples 5`, it measured 360 µs, because the process ended before the slowdown.

**The first official-profile run confirmed this and found smaller divergences in Bun.** It used `make bench-official CPUS=8,10` (3 runs, both modes, 171 processes), with `powersave` and turbo still on, so it is not an official result. The divergence table flagged 9 cases:

- the six V8 `sum_i32/ts` rows at 10k–1M elements, with the same 0.09–0.15× ratios as above
- Bun `noop/napi` (fresh 36.9 ns vs shared 30.6 ns)
- Bun `add_i32/napi` (50.0 vs 44.6 ns)
- Bun `sum_i32/ts/100` (24.7 vs 18.5 ns)

The Bun rows were slower and noisier in fresh processes. Every other case agreed between the modes.

Results are therefore only comparable when the harness options are identical. `scripts/compare.ts` lists warmup, samples and sample-ms among the settings that differ between directories.

## Known limitations

- **V8 JIT-history sensitivity is reported, not resolved.** For V8 (Node, Deno), `sum_i32/ts` at 10k elements and above differs by up to about 10× between a fresh process per case and a shared process. In a fresh process it also depends on how long the process runs (see [Evidence](#evidence)). JSC (Bun) doesn't show the large-array effect, but a few small Bun cases differ by 11–25% between modes. Official runs publish both modes and flag the divergence. The harness deliberately doesn't work around it with V8-specific flags or changes to the benchmark code, so V8-vs-JSC ratios for these rows must be read per mode.
- **Settings are recorded, not enforced.** The harness warns about the governor, turbo and platform profile but never changes them. Only the user can put a machine into official conditions.
- **Pinning includes helper threads.** `taskset` restricts the whole process, so JIT and GC threads compete for the same CPU set. Pinning only the main thread would require code inside each runtime, which the runtimes don't offer in a comparable way.
- **Deno's affinity is checked by count only**, because of its permission model (see above).
- **A fixed warmup count doesn't guarantee a steady state.** Run-to-run comparison detects a failure to reach steady state; it doesn't prevent one.
- **No statistical test yet.** The 5% threshold is a heuristic. There are no confidence intervals or tests of whether one run differs from another.
- **Platforms.** Only Linux x86_64 has been verified. `native/napi/build.rs` includes the usual macOS `dynamic_lookup` link flags, but they are untested. Windows would need linking against `node.lib` and is unsupported. Topology, condition checks and pinning are Linux-only.
- There are no normalised JSON/CSV datasets, charts, or regression checks yet.
