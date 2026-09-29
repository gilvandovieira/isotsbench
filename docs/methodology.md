# Methodology

How measurements are taken, isolated, controlled, checked and recorded. What is measured is in [benchmarks.md](benchmarks.md); measured results are in [findings.md](findings.md); caveats are in [limitations.md](limitations.md).

## Shared TypeScript

`bench/` is plain TypeScript run directly by Node.js 24.2+ (built-in type stripping), Bun and Deno. It uses only erasable syntax and `node:` built-ins; nothing is transpiled or bundled. These runtimes load the same WASM artifacts (default and `simd128` builds) through direct `WebAssembly` APIs. `bench/scriptc/` and the shared modules it imports are additionally compiled by scriptc.

Browsers run `bench/browser/` and the shared modules it imports. A local server strips their types with Node's `stripTypeScriptTypes` and serves them unbundled; see [Browsers and Workers](#browsers-and-workers).

## Measurement inside one process

For each case, in `bench/common/harness.ts`:

1. **Calibrate.** Double the batch size until one batch takes at least `--sample-ms` (default 20 ms), then scale the batch to that target. The resulting `iterations` is fixed for the case and recorded.
2. **Warmup.** Run `--warmup` batches (default 5). Their timings are saved as `warmup_ns` and left out of the statistics.
3. **Sample.** Run `--samples` batches (default 30). Each one is timed as a whole: with `process.hrtime.bigint()` under Node.js, Bun and Deno (ns resolution in all three), and with `performance.now()` under scriptc, which has no hrtime. Each result file records its `timer`.

Timing whole batches rather than single calls keeps timer overhead negligible even for operations that take a nanosecond. ns/op = batch ns / iterations. The reported statistics (median, mean, sample stddev, min, max) are computed over the per-sample ns/op values. ops/s = 1e9 / median ns/op. p95/p99 are not reported: with 30 batched samples they would not be meaningful.

How the loops avoid common microbenchmark errors:

- **Monomorphic loops.** Each case owns its loop and calls one hoisted function reference. A shared generic loop that took callbacks would turn polymorphic and penalise whichever case ran later.
- **No dead code.** Each loop folds call results into its return value, and that value is stored in a module-level sink.
- **Only the selected case is built.** A process allocates benchmark data only for the cases it runs.

## Correctness checks

Once timing is done, `checkEquivalence()` checks that every available native or WASM path returns exactly what the TypeScript reference returns. Those paths are Node-API, FFI in Bun and Deno, WASM in all three, and scriptc's FFI paths. The checks themselves are shared (`bench/common/checks.ts`). A process checks every operation of the suites it measured, and only those:

- **boundary:**
  - `noop` returning `undefined`
  - i32 overflow
  - empty arrays
  - every `sum_i32` size and an offset subarray view

- **payload:**
  - `string_len` on every payload size of both variants, plus an empty string, lone and trailing surrogates, and a sliced string. The TS `string_len` is itself checked against `TextEncoder` on every string.
  - `bytes_len` and `checksum_bytes` on every payload size, an empty buffer and an offset view
- **return:**
  - `return_f64`.
  - `return_string` at every size plus 0 and 23 bytes (the utf8 pattern tail). Each string must equal the expected string exactly and have the right UTF-8 length.
  - A returned string must survive a later call that overwrites the native buffer, so it cannot alias native memory.
  - `return_bytes` at every size plus 0, compared byte for byte with the TS result. Each must be a `Uint8Array` at offset 0 that owns a whole `ArrayBuffer` of exactly its size (not a view into a pool or into native memory), and two results must be independent.
  - Every row strategy at every count plus 0, compared field by field with the TS rows, including property order.

For WASM, the boundary check covers both builds, with the same copy into linear memory as the `copy` paths. Browser pages run the same boundary check on the main thread. They send the same inputs through every Worker path and also check each strategy's ownership claims ([browser.md](browser.md#correctness)).

A process that measured payload cases generates and scans the 16 MiB payloads, which takes about 0.7–1 s; other processes skip that. All of this runs after timing and is not measured.

A mismatch fails the process. The orchestrator records the unit as failed and discards its results, so a failed check means the results are never accepted. This was tested by deliberately breaking a function by one: the C ABI's `sum_i32` for Bun and Deno, and scriptc's `string_len` adapter. Every affected unit failed and the run exited 1.

The check runs *after* timing on purpose. Calling the functions first with overflowing and edge-case inputs would shape the JIT's type feedback for the code about to be measured.

## Process isolation and order

`scripts/bench.ts` runs one process per *unit*, one after another, never in parallel.

- `--isolation case` (default for `make bench`): each (runtime, case) pair gets a fresh process. No case inherits JIT, inline-cache or GC state from another case. Results describe a process that has run only that case.
- `--isolation runtime` (used by `make bench-quick`): one process per runtime runs every case in canonical order. It's faster. Results describe a process with one particular history: earlier cases can change how later cases are compiled.
- `--isolation both` (required for official runs): both kinds of unit in the same repetitions, interleaved by the shuffle. Every result records its `isolation`. Summaries and variance are computed separately per mode and never pooled.

**Both modes are reported because neither is the single right answer.** For some cases V8 reaches different steady states depending on JIT history (see [findings](findings.md#jit-history-fresh-versus-shared-processes)). When both modes are present, `scripts/bench.ts` and `scripts/compare.ts` print an **isolation divergence** table. A case appears there when:

- its per-run medians in the two modes don't overlap, **and**
- the two medians differ by more than 5%.

A divergent case must be reported with both numbers. Those rows are a finding about the runtime, not noise.

### Canonical order is part of the shared-process protocol

In a shared process, the cases run in **canonical order**:

- suite by suite;
- within a suite, operation by operation (and size by size);
- all paths of one operation and size together, in a fixed sequence: `ts`, then `napi`, `ffi`, then WASM.

Because earlier cases shape how later ones are compiled, this order is part of what a shared-process result means, not just code organisation. A path placed elsewhere would run after a different history than the paths it is compared with. `environment.json → methodology.cases` records the canonical list, and `tests/wasm.test.ts` checks that WASM paths sit with their operation.

Before this rule was enforced, the WASM cases ran after the whole payload and return suites. Shared-process WASM results recorded in that state are not comparable with the other paths and have been withdrawn (see [findings](findings.md#webassembly)).

### Process groups

Some diagnostics need the engine started with different flags, currently `wasm.no-inline` (V8 with JS→WASM inlining disabled; see [wasm.md](wasm.md)). Their cases belong to a separate **process group**, and a process only ever runs cases of one group:

- a fresh process per case uses its case's group;
- a shared process exists per runtime *and group*.

So a flag never changes what another case measures. `bench/run.ts --process-group` selects the group, and `environment.json → methodology.processGroupCommands` records the exact commands. Each result records `process.processGroup`, the `v8Flags` requested, and whether they were verified inside the process: `true`, or `null` where the runtime cannot show them (Deno's `--v8-flags`).

Within each repetition, `--order shuffle` (the default) randomly permutes all units across runtimes, cases and isolation modes. The permutation comes from a seeded PRNG (mulberry32), so `--seed` from `environment.json` reproduces the schedule exactly. Shuffling stops slow drifts (temperature, background load, turbo headroom) from always landing on the same runtime or case. Every result records its `run` and `sequence` (position in the schedule), so order effects can be analysed afterwards.

## Browsers and Workers

`scripts/bench-browser.ts` applies the same principles in Chromium and Firefox. [browser.md](browser.md) has the details.

- **Same protocol.** Calibrate, warmup and samples, with raw `warmup_ns` and `samples_ns`, the same statistics and the same options. Main-thread cases use `harness.ts` itself. Worker cases use a copy of its protocol for batches that complete asynchronously.
- **Clock.** `performance.now()` on the page's main thread. Pages are served cross-origin isolated, which gives the finest resolution browsers allow. Each page records the step it observed (5 µs in Chromium and 20 µs in Firefox on the reference machine: at most 0.1% of a 20 ms batch). The orchestrator warns when a page is not isolated or its step exceeds 0.1% of a batch.
- **Isolation.** `case` is a fresh browser with a fresh profile per case; `runtime` is one page per browser and thread, in canonical order. `both`, `--runs`, the seeded shuffle and `--cpus` work as above. Pinning covers the whole browser process group, and every process in it is verified.
- **Threads are never mixed.** A page measures main-thread cases or Worker cases, never both. They are written to separate files (`<browser>.main.json`, `<browser>.worker.json`) and summarised in separate tables.
- **Worker messaging is its own boundary.** It is never reported as part of a WASM call. Each Worker path names how its input moves (`clone`, `copy`, `transfer`) or that it does not move (`resident`). The orchestrator prints the round trip, the work behind it and each strategy's transfer cost as separate numbers.
- **Correctness after measurement,** per thread, as above. A failed check fails the unit, and its results are discarded.
- **Artifacts.** Each page hashes the WASM bytes it fetched, in the page and in the Worker. A run stops if they differ from the artifacts it built and recorded.

Browser runs are separate run directories. They do not change any server-runtime result, and `scripts/compare.ts` reads them like server runs.

## CPU pinning (Linux)

`--cpus LIST` starts every benchmark process with `taskset -c LIST`. The mask covers the whole process: the runtime's main thread and also its JIT compiler and GC helper threads. Each process reports the affinity it actually got:

- `process.allowedCpuCount`, via `os.availableParallelism()`, which respects the affinity mask in Node.js, Bun and Deno. scriptc has no `os.availableParallelism`, so it counts the CPUs in its affinity list.
- `process.affinity`, the kernel's `Cpus_allowed_list`, for Node.js, Bun and scriptc. Deno refuses to read `/proc` without `--allow-all`. Granting that only for bookkeeping would change how Deno is launched, so its value is `null`.

If either value disagrees with the requested set, the orchestrator aborts the run.

On a platform other than Linux, `--cpus` is rejected. It doesn't silently fall back to running unpinned.

**Choosing the set.** Use CPUs of **one class** (same core type and max frequency), **without SMT siblings**, and preferably not CPU 0, which handles more interrupts. Use at least two CPUs so helper threads don't have to share the benchmark thread's CPU. The harness warns when the set spans CPU classes or contains SMT siblings. Use the `system.cpuClasses` and `system.cpus[].smtSiblings` fields in any `environment.json` to choose. Pinning to one CPU or to several did not change steady-state results (see [findings](findings.md#cpu-pinning)).

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

The benchmark runners **never change system settings**. `make setup` does, and only when you run it (Linux, root through `sudo`):

- It saves the current value of every setting it manages to `.official-setup.json` (git-ignored).
- It sets every cpufreq policy's governor and energy-performance preference to `performance`, turns turbo off (`intel_pstate/no_turbo`, or `cpufreq/boost`), and sets the ACPI platform profile to `performance` when offered.
- It verifies each write, then prints the warnings that remain (add `CPUS=…` to include the pinning checks).

`make teardown` writes the saved values back, governors before EPP, and removes the state file. `make setup` refuses to run while a state file exists, so the original settings are never overwritten by already-changed ones. `node scripts/system-setup.ts apply --dry-run` (or `restore --dry-run`) lists the writes without making them.

```bash
make setup CPUS=8,10
make bench-official CPUS=8,10
make teardown
```

A daemon that manages power settings (for example power-profiles-daemon) can change them again if its profile changes during a run. The conditions are checked once, when a run starts.

The same settings by hand (root required; restore them afterwards):

```bash
sudo cpupower frequency-set -g performance                             # governor
echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo        # intel_pstate: disable turbo
echo 0 | sudo tee /sys/devices/system/cpu/cpufreq/boost                # acpi-cpufreq / amd-pstate: disable boost
echo performance | sudo tee /sys/firmware/acpi/platform_profile        # or: powerprofilesctl set performance
```

## Run-to-run variance

A single process can have tight samples and still be wrong: see the [short-warmup effect](findings.md#short-warmups). Numbers only become defensible when separate processes agree.

- `--runs N` repeats the complete matrix N times in one invocation.
- `scripts/compare.ts DIR [DIR ...]` (`make compare RUNS="..."`) treats every repetition of each isolation mode in every run directory as one complete run. Directories recorded before `--isolation both` use the mode stored in their `environment.json`.
  - For each runtime and case it reports the median of the per-run medians, the min and max run, and the spread `(max − min) / median`.
  - Cases above 5% spread are flagged `unstable`.
  - When given several directories, it adds one column per directory and lists any settings that differ between them: commit, runtime versions, isolation, CPUs, harness options, governor, turbo and so on.

When `--runs` > 1, `scripts/bench.ts` prints the same variance table and computes its summary from the median of run medians.

## Official-run procedure

1. Use a machine you control, not shared CI. Close other applications and keep it plugged in.
2. Prepare the conditions with `make setup CPUS=<list>` or by hand (above), and pick a CPU set (above).
3. `make bench-official CPUS=<list>`. This runs `--official`, which requires `--cpus`, `--isolation both`, `--order shuffle` and at least 3 runs. Keep the default harness options (warmup, samples, sample-ms) unless you are deliberately changing the methodology: some V8 results depend on how long a process runs (see [findings](findings.md#jit-history-fresh-versus-shared-processes)), so runs are only comparable with identical options.
4. The run ends by printing either `official criteria met` or `official criteria NOT met`. The result is also stored as `conditions.officialCriteriaMet`, which is true only for the official profile with no condition warnings and no failed units.
5. Publish the fresh-process and shared-process results side by side. In the variance table, report every `unstable` case as unstable, not as a single number. Report every case in the isolation divergence table with both numbers.
6. Restore the machine with `make teardown`.
7. To publish, commit the whole `results/raw/<run-id>/` directory. `results/raw/*` is git-ignored, so add it with `git add -f results/raw/<run-id>`.

## Output

`results/raw/<run-id>/` (git-ignored; commit a run on purpose when you publish it):

- `environment.json`
  - hardware and OS, plus `system` (above) and load averages
  - runtime, rustc and cargo versions, `RUSTFLAGS`, git commit and dirty flag
  - `methodology`: profile, isolation (`case`, `runtime` or `both`), runs, order, seed, CPUs and the exact `taskset` command and version, the runtime command lines, filter, canonical case list, `casesByRuntime` (each runtime lists only the cases it supports), and when equivalence is checked
  - `options`: warmup, samples, sample-ms
  - `conditions`: warnings and `officialCriteriaMet`
  - `failedUnits`
  - `native`: path, byte size and SHA-256 of the Node-API addon and the C ABI library that were measured. When scriptc ran, `native.scriptc` adds the compiler version, the build command, and the byte size and SHA-256 of the executable, static archive and FFI manifest.
  - `wasm`: the WASM target and `rustc -vV`, and for each build (`default`, `simd128`) the exact release Cargo command, effective `RUSTFLAGS`, and artifact path, byte size and SHA-256. It is null for a scriptc-only run, or when the target is not installed.
- `<runtime>.json` (schema 2, including `scriptc.json`)
  - `process.versions` as the runtime reports it (empty for scriptc, whose compiler version is in `environment.json`), the `timer` and options
  - one entry per case per run:
    - identity: `id`, `op`, `impl`, `binding`, `suite`, `size`, `variant`, `payload`, `strategy`, `ownership` (described in [benchmarks.md](benchmarks.md))
    - schedule: `run`, `isolation`, `sequence`, `process` (pid, affinity, allowed CPU count, execArgv, start/end time)
    - measurement: `iterations`, raw `warmup_ns` and `samples_ns`, derived `ns_per_op` statistics and `ops_per_s`

Raw sample arrays are copied unchanged from each process's output into these files.

Browser runs write `environment.json` with `kind: "browser"`, plus `<browser>.main.json` and `<browser>.worker.json`. Their extra metadata includes browser and engine versions, page-reported user agent, timer and isolation, fetched artifact hashes, WASM target features and the Worker configuration; see [browser.md](browser.md#recorded-metadata).

## Publishing results

- **Record the environment.** Results without `environment.json` should not be treated as authoritative. It records the hardware, OS, CPU topology and power settings, every runtime and compiler version, the native artifact hashes, the commit and every methodology setting.
- **Keep raw data.** Aggregated numbers never replace raw measurements. Commit the whole run directory, so the numbers can be re-analysed without rerunning them.
- **Separate facts from interpretation.** "Node-API `noop` median: X ns/op" is a measured fact. "FFI reduced call overhead in this environment" is an interpretation. Never present an interpretation as a measured fact.
- **Not from shared CI.** Virtualisation, noisy neighbours, power management and unknown hardware make shared CI runners unsuitable for official numbers. CI can check that everything builds and runs, but there is no CI yet (see [roadmap.md](roadmap.md)).
