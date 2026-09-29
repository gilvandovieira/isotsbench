# AGENTS.md

Guide for coding agents working on isotsbench. Read it before changing code, running benchmarks or reporting results. Details live in `docs/`; this file says where, and what must not be broken.

## What this project is

A benchmark suite measuring the cost of crossing from TypeScript into native code, across runtimes and bindings. It reports **cost profiles, not winners**: absolute ns/op, ratios against each runtime's own TypeScript baseline, and break-even sizes. The value of the project is that its numbers are comparable and honest. Protect that above everything else.

Current scope (v0.7.0): three suites (`boundary`, `payload`, `return`), all synchronous microbenchmarks. It has no async native calls, chatty/batched API comparison, or SQLite workload; those are planned in `docs/roadmap.md`.

## Execution paths

Every native path calls the same Rust core (`native/rust-core`). The path segment of a case id names what is measured.

| Path | Where | Mechanism | Suites |
| --- | --- | --- | --- |
| `ts` | Node.js, Bun, Deno (JIT); scriptc (compiled AOT); browsers | TypeScript reference, `bench/common/ts-impl.ts` | all (browsers: boundary) |
| `napi` | Node.js, Bun, Deno | raw Node-API addon `native/napi` | all |
| `ffi` | Bun (`bun:ffi`), Deno (`Deno.dlopen`); scriptc partial | plain C ABI `native/ffi` (scriptc: static archive `native/scriptc`) | all (scriptc: boundary, payload, `return_f64`) |
| `wasm.*` | Node.js, Bun, Deno, browser main thread | `native/wasm`, `wasm32-unknown-unknown`, no wasm-bindgen | boundary |
| `worker.ts*`, `worker.wasm*` | browsers | main → `postMessage` → dedicated Worker → TS or WASM → back | boundary |

Strategy suffixes exist when semantics differ; never merge them into the plain path:

- `napi.objects` / `napi.packed` / `ffi.packed`: row return strategies.
- `ffi.borrowed`: scriptc string ingress. It borrows UTF-8 bytes, so it is not comparable with the other runtimes' `ffi`.
- `wasm.inlineable`: the engine's default call. V8 may inline it away entirely.
- `wasm.no-inline`: the same call in a V8 started with `--no-turbo-inline-js-wasm-calls`, in its own process group (Node.js, Deno only).
- `wasm.copy` / `wasm.resident`: input copied into linear memory on every call, or once outside timing.
- `wasm.simd128.*`: the same source built with `+simd128`.
- `worker.<impl>.clone|copy|transfer|resident`: how the input reaches the Worker. A Worker round trip is a **messaging** boundary, never a WASM boundary.

Case ids are `op/path[/variant][/size]`, e.g. `sum_i32/wasm.copy/1000`, `string_len/napi/utf8/65536`, `sum_i32/worker.wasm.transfer/1000`.

## Layout

```text
native/rust-core/     operations, no binding code
native/{napi,ffi,scriptc,wasm}/   bindings over the core
bench/run.ts          entry point for Node.js, Bun, Deno
bench/common/         shared harness (harness.ts), cases (cases.ts), checks.ts, payloads.ts, ts-impl.ts,
                      suites.ts, process-groups.ts, wasm-abi.ts; also compiled by scriptc and served to browsers
bench/scriptc/        scriptc entry point and cases (compiled to build/isotsbench-scriptc)
bench/browser/        browser page, main-thread cases, Worker (worker.ts) and its cases
scripts/bench.ts      runtime orchestrator      scripts/bench-browser.ts  browser orchestrator
scripts/build.ts      builds build/*            scripts/browser.ts        browser launch + local server
scripts/compare.ts    run-to-run variance       scripts/system.ts         read-only sysfs probe
tests/                wasm.test.ts, browser.test.ts
results/raw/<run-id>/ raw output (git-ignored)
docs/                 see "Documentation to keep current"
```

## Toolchain

- Linux x86_64 is the only verified platform. Pinning and condition checks are Linux-only.
- Rust stable. `rustup target add wasm32-unknown-unknown` for the WASM and browser paths; without it the WASM cases do not exist.
- **Node.js 24.2+**: `scripts/` rely on `import.meta.main`. Node runs `.ts` directly; no npm packages, no bundler, no transpiler.
- Optional, skipped when missing from `PATH`: Bun, Deno, scriptc 0.1.7 (`npm install -g scriptc`).
- Deno is required by `make check`.
- Browsers: Chromium/Chrome and/or Firefox. Set `CHROMIUM_PATH` / `FIREFOX_PATH` when they are not on `PATH`; otherwise browser tests are skipped, not failed.

## Commands

```bash
make check                        # cargo clippy -D warnings + deno check of every entry point and test
make test                         # cargo test, build (no scriptc), tests/{wasm,browser,system-setup}.test.ts
make build                        # everything in build/, including scriptc when installed

make bench-quick                  # smoke: one shared process per runtime, short batches. Numbers meaningless.
make bench                        # fresh process per case, shuffled, 1 run
make bench SUITE=payload BENCH_ARGS="--runtimes node,bun --filter string_len"
make setup CPUS=8,10              # official conditions via sudo; saves the originals (Linux)
make bench-official CPUS=8,10     # pinned, --isolation both, shuffled, 3 runs
make teardown                     # restores the saved settings

make bench-browser-quick          # smoke: one page per browser and thread, short batches
make bench-browser                # fresh browser per case, 1 run
make bench-browser-official CPUS=2,8,10

make compare RUNS="results/raw/<a> results/raw/<b>"
```

- Runtime orchestrator options (`node scripts/bench.ts`): `--runtimes`, `--isolation case|runtime|both`, `--runs`, `--order shuffle|fixed`, `--seed`, `--cpus`, `--official`, `--suite`, `--warmup`, `--samples`, `--sample-ms`, `--filter`.
- Browser orchestrator (`node scripts/bench-browser.ts`): the same, minus `--runtimes` and `--suite` (the browser covers the boundary suite only), plus `--browsers chromium,firefox`, `--threads main,worker` and `--timeout-s`.
- One runtime by hand: `node bench/run.ts --case sum_i32/ts/1000`, or `--list` to print case ids in canonical order.
- `--official` requires `--cpus`, `--isolation both`, `--order shuffle` and `--runs` ≥ 3. Choose CPUs of one class with no SMT siblings, avoiding CPU 0. Use `system.cpuClasses` and `system.cpus[].smtSiblings` in any `environment.json`. Browsers need at least 3: page main thread, Worker, everything else.
- The benchmark runners **never change system settings**; they record and warn. `make setup` (Linux, `sudo`) saves the current settings to `.official-setup.json`. It then sets the governor and EPP to `performance`, turbo off, and the platform profile to `performance`. `make teardown` restores exactly the saved values. Both change the machine: run them only when the user asks. `node scripts/system-setup.ts apply --dry-run` is safe.
- Do not run other heavy work while a benchmark runs. Browser pages load `bench/` from disk on every launch, so **do not edit `bench/` during a browser run**.

## How measurement works (do not break)

- **Batched timing.** Calibrate the batch to about `--sample-ms`, then `--warmup` batches, then `--samples` batches. Statistics come from per-batch ns/op. Raw `warmup_ns` and `samples_ns` are always kept.
- **Fresh vs shared.**
  - `--isolation case`: a fresh process (or browser) per case.
  - `--isolation runtime`: one process per runtime, or one page per browser and thread, running every case.

  They can legitimately disagree. Summaries never pool them. Official runs report both.
- **Canonical order is part of what a shared-process result means.** Suite by suite, operation by operation, size by size. Within one operation and size: `ts`, `napi`, `ffi`, then WASM. A new path must sit next to its operation, not at the end. `tests/wasm.test.ts` enforces this for WASM.
- **Process groups.** Cases needing engine flags (`wasm.no-inline`) run only in processes of their group, never alongside other cases (`bench/common/process-groups.ts`).
- **Correctness after measurement.** Each process (and page) checks every operation of the suites it measured against the TS reference **after** timing. Checking before would shape JIT feedback. A mismatch fails the unit, and its results are discarded. Check adapters must do exactly what the benchmark loop does.
- **Seeded shuffle** (`--seed`, recorded) reproduces the schedule exactly.
- **Browsers.** The main thread and Worker run in separate pages and are written to separate files (`<browser>.main.json`, `<browser>.worker.json`). Pages are cross-origin isolated for `performance.now` resolution, and each records its observed timer step. A browser that never loads the page within 30 s is relaunched, and `launchAttempts` is recorded.

## Results and metadata

- `results/raw/<run-id>/environment.json`: hardware, OS, CPU topology, governor/turbo, runtime and compiler versions, artifact SHA-256, git commit and `dirty`, full methodology, seed, options, `conditions.warnings`, `conditions.officialCriteriaMet`, `failedUnits`. Browser runs add `kind: "browser"`, browser and engine versions, page-reported timer and isolation, fetched WASM hashes, WASM target features and the Worker configuration.
- `<runtime>.json` (or `<browser>.<thread>.json`): every result with raw samples, `run`, `isolation`, `sequence`, `process`.
- `results/raw/*` is git-ignored. Publishing a run means committing the whole directory: `git add -f results/raw/<run-id>`. Only do that when asked.

**Development vs official.**

- A result is official only if its `environment.json` has `conditions.officialCriteriaMet: true`: the official profile, no condition warnings and no failed units.
- Only the two runs under "Official results" in `docs/findings.md` meet it; their directories are committed in `results/raw/`. Everything else in `findings.md` is a development result (`powersave`, turbo on). Say which one you cite. Never compare absolute times across the two kinds: with turbo off they are about twice as long.
- Also check `git.dirty` and whether harness options match: runs with different warmup, samples or sample-ms are not comparable.

## Interpreting numbers

- **Ratios** (`napi/ts` etc.) compare against the *same runtime's* TS path. For `noop`, `add_i32` and `bytes_len`, TS inlines to almost nothing, so the absolute native ns/op is the meaningful number, not the ratio.
- **Break-even** is the smallest measured size from which a path beats TS at that size and every larger one. The true crossover lies between that size and the one below. `never` means within the measured sizes.
- **Variance.** A case whose per-run medians spread more than 5% is `unstable`: report its range, not one number. Tight samples inside one process prove nothing about another process.
- **Isolation divergence.** Fresh and shared per-run medians don't overlap and differ by more than 5%. Report both numbers; it is a finding about the engine, not noise.
- **Worker numbers** are sequential round-trip latencies. Read them against `noop/worker.ts` (messaging only) and `worker.<impl>.resident` (no data moved). The orchestrator's decomposition subtracts independent medians, so it is approximate and can go negative.

## Known pitfalls

- **V8 JIT history.** Some pure-TS loops, e.g. `sum_i32/ts` at 10k+ elements, run several times slower in a fresh process than in a shared one, in Node.js, Deno and Chromium. Fresh-process results also depend on how long the process runs. Never "fix" this with engine flags or by reshaping the TS loop.
- **WASM inlining.** V8 can inline a trivial JS→WASM call, so `noop/wasm.inlineable` may measure an empty loop. Use `wasm.no-inline` to see the call. Whether JSC (Bun) or SpiderMonkey inline it is not established.
- **Linear-memory copies.** `wasm.copy` copies the input on every call, while Node-API and FFI borrow it. The WASM penalty is transfer *plus* code generation: compare `copy − resident`, then `resident` vs `simd128.resident`.
- **SIMD.** The default `wasm32` build has no SIMD, while native Rust is auto-vectorised. `simd128` is a separate artifact and path, never a silent replacement.
- **Worker semantics.**
  - `clone`: postMessage copies the array; the caller keeps it.
  - `copy`: the caller `slice()`s and transfers the copy.
  - `transfer`: the caller's buffer is detached until the Worker sends it back, so the round trip carries two transfers.
  - `resident`: the input already lives in the Worker.
  - WASM in a Worker always copies received input into linear memory: linear memory cannot adopt a transferred buffer.
- **Browser clocks** are clamped even when cross-origin isolated. Each page records its observed step (`timer.minNs`), and the orchestrator warns when it exceeds 0.1% of a batch. Don't lower `--sample-ms` below 20 without checking that warning.
- **scriptc** compiles `bench/common/`. It rejects default imports, `unknown`, `Math.max`, `Uint16Array`, tuple indexing with a variable, `Map` values of `Uint8Array`, and more (see `docs/scriptc.md`). Run `make build` after touching shared modules.

## Adding or changing a case

- Each case owns its loop over one hoisted function reference. Never route cases through a shared generic loop: it turns polymorphic.
- Fold every call's result into the loop's return value so it cannot be dead-code eliminated.
- Build data only for selected cases; allocate outside timing.
- Give the case the right `op`, `impl`, `binding`, `size`, `payload`, `strategy` and `ownership`. Use a new path name whenever the transfer or ownership semantics differ from an existing path of the same name.
- Place it in canonical order. Keep `buildCaseIds()` / `--list` data-free.
- Every native path needs a TypeScript reference with identical semantics (i32 wrap, UTF-8 rules) and a post-measurement check that does exactly what the loop does. Add a test, and prove the check can fail: break the function by one, see the unit fail, revert.
- Engine flags need a process group, and the flag must be verified inside the process where possible (`v8FlagsVerified`).
- `bench/browser/main-cases.ts` copies loops from `bench/common/cases.ts`. Change both identically.
- If a benchmark cannot keep its semantics on some runtime, split it into a named path or defer it, and document why. Never force equivalence.

**Comparability is the product.**

- Never tune a workload, loop, flag, build profile or data set to make a result look better.
- Never drop inconvenient samples, cases or runs.
- A change that affects what is measured (harness, shared code, build profile, artifacts) must be recorded, and its effect on existing results checked or stated.
- The release profile is the default on purpose (`Cargo.toml`).

## Before claiming a finding

- [ ] The run directory exists, with `environment.json` and raw samples; cite its id.
- [ ] No failed units; every correctness check passed.
- [ ] Development or official? State `officialCriteriaMet`, the governor/turbo warnings and `git.dirty`.
- [ ] Three or more runs; unstable cases (> 5% spread) reported as ranges.
- [ ] Fresh and shared reported separately; divergent cases given with both numbers.
- [ ] Compared only runs with identical harness options and artifacts (`make compare` lists differing settings).
- [ ] The comparison is between paths with the same semantics, or the difference (copy, borrow, inline, SIMD, clone/transfer) is named.
- [ ] Measured facts kept separate from interpretation; unknown mechanisms stated as "not established".

## Documentation to keep current

| Change | Update |
| --- | --- |
| suites, operations, sizes, case ids, result fields | `docs/benchmarks.md` |
| harness, isolation, order, checks, output format | `docs/methodology.md` |
| what a binding copies, borrows or allocates | `docs/marshalling.md` |
| WASM paths or builds | `docs/wasm.md` |
| browser or Worker paths, launch, metadata | `docs/browser.md` |
| scriptc integration | `docs/scriptc.md` |
| new measured observations (with run id and conditions) | `docs/findings.md` |
| caveats | `docs/limitations.md` |
| a release or a planned item done | `docs/roadmap.md`, `README.md`, `docs/design.md` (questions table) |

Releases follow `feat:` / `test:` / `docs:` commits, then `chore: release vX.Y.Z`. That commit bumps `[workspace.package] version` in `Cargo.toml` and `Cargo.lock` to match an annotated `vX.Y.Z` tag.
