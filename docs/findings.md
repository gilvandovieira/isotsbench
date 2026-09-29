# Findings

Measured results from one machine. [Official results](#official-results) reports the first runs that met the official criteria; their raw data is committed under `results/raw/`. Everything after [Setup](#setup-development-runs) comes from **development runs**. Those explain methodological choices and show what the benchmark can reveal, but they are not official results: the machine ran with the `powersave` governor and turbo enabled (see [methodology.md](methodology.md#official-run-procedure)). Their raw data was not kept.

## Summary

Cost profiles observed so far. The official runs reproduced each of them, with every absolute time about twice as long, consistent with turbo off (see [Official results](#official-results)). The sections below give the numbers.

- **Boundary cost varies by binding and runtime.** A call through Bun or Deno FFI costs 1–3 ns; Node-API costs 7–45 ns depending on the runtime. See [Boundary](#boundary-node-api-and-ffi).
- **Past about 1M elements, borrowed native bindings converge.** Node-API and FFI run `sum_i32` over 10^6 elements in about 60 µs.
- **Node-API and FFI borrow input buffers.** Handing over a `Uint8Array` costs the same at 16 B and at 16 MiB on those paths.
- **The optimizer can remove the boundary.** V8 inlines a trivial JS→WASM call, so `noop/wasm.inlineable` costs the same as an empty loop. With inlining disabled, the call costs 2.7–3.0 ns. See [WebAssembly](#webassembly).
- **WASM's array penalty is transfer plus code generation.** At 10^6 elements, copying into linear memory costs 100–145 µs per call. The default (non-SIMD) build's sum costs more than that; built with `simd128`, the resident sum comes within 1.1–1.4× of native.
- **Strings have a cost profile of their own.** ASCII ingress runs at roughly memory speed, but mixed UTF-8 is no faster than counting bytes in JS, and in Node and Deno never beat it.
- **Returning structured data is where native paths lose.** Building rows as JS objects through Node-API is 30–60× slower than building them in JS in Node and Deno. Packed records decoded in JS are 3–5× faster than that, but still slower than plain JS at every size.
- **V8 results can depend on JIT history.** Some pure-TS loops differ by up to about 10× between a fresh process and a shared one, which is why official runs report both.
- **Ahead-of-time compiled TypeScript has a different profile.** Under scriptc:
  - an FFI call costs about 1.8 ns;
  - string ingress is a size-independent borrow;
  - fresh and shared processes agree;
  - the compiled TS loops are slower than the JIT runtimes' steady state, so native code wins from smaller sizes.

  See [scriptc](#scriptc).
- **Browsers reproduce the server WASM profile on the main thread.** Chromium's `wasm.copy`, `wasm.resident` and `simd128` sums match Node.js within about 6%. Firefox's resident sums are within 5–21% of Chromium's. See [Browsers and Workers](#browsers-and-workers).
- **A Worker round trip costs 8–10 µs before any data moves.** That is thousands of times a main-thread WASM call. For inputs up to 1,000 elements it dominates every Worker path, TypeScript or WASM alike.
- **How the input reaches a Worker matters more than what runs there.** At 10^6 elements:
  - a transfer adds about 10 µs;
  - an explicit copy adds 1.0–1.4 ms;
  - a structured clone adds 1.8–2.8 ms.

  WASM in a Worker adds its own copy into linear memory (about 200 µs) on top of any of them.

## Official results

Two runs met the official criteria (`conditions.officialCriteriaMet: true`). They had no condition warnings and no failed units, and ran on commit `da569f4` with a clean tree.

| Run | Command | Scope |
| --- | --- | --- |
| `results/raw/2026-09-29T10-24-40-196Z` | `make bench-official CPUS=8,10` | Node 24.21.0, Bun 1.4.2, Deno 2.9.7, scriptc 0.1.7; every suite; 1,782 processes, 1 h 25 min |
| `results/raw/2026-09-29T11-49-48-358Z` | `make bench-browser-official CPUS=2,8,10` | Chrome for Testing 153 (V8 15.3.76.4), Firefox 156.0.1; main thread and Worker; 606 pages (no relaunches), 26 min |

Conditions (applied with `make setup`):

- `performance` governor and energy-performance preference;
- turbo off;
- `performance` platform profile;
- 3 runs, both isolation modes, seeded shuffle, default harness options.

Values are medians of 3 per-run medians, fresh process (or browser) per case. When the shared mode differs by more than 5%, the value is given as fresh / shared.

**Absolute times are about twice the development runs'.** The factor is the same across unrelated cases:

- `sum_i32/napi/1000000` in Node.js: 62.8 → 127 µs;
- `checksum_bytes` at 16 MiB: about 15 → 29.4 ms;
- `noop/ts` in Node.js: 0.28 → 0.55 ns;
- `noop/worker.ts` in Chromium: 7.95 → 15.2 µs.

That is consistent with the CPU running at its base clock with turbo off; the frequency itself was not measured. Ratios and break-even sizes can be compared with the development runs; absolute times cannot.

### Runtimes

| Case | Node | Bun | Deno | scriptc |
| --- | ---: | ---: | ---: | ---: |
| `noop/ts` | 0.55 ns | 0.25 ns | 0.55 ns | 0.87 ns |
| `noop/napi` | 13.1 ns | 71.6 / 55.0 ns | 14.0 ns | – |
| `noop/ffi` | – | 2.19 ns | 4.44 ns | 3.50 ns |
| `noop/wasm.inlineable` | 0.55 ns | 2.68 ns | 0.55 ns | – |
| `noop/wasm.no-inline` | 5.80 ns | – | 5.18 ns | – |
| `sum_i32/ts/1000000` | 7.17 / 1.10 ms | 453 µs | 8.22 ms / 931 µs | 6.63 ms |
| `sum_i32/napi` or `ffi` `/1000000` | 127 µs | 122 µs | 122–128 µs | 121 µs |
| `sum_i32/wasm.copy/1000000` | 711 µs | 625 / 561 µs | 704 µs | – |
| `sum_i32/wasm.resident/1000000` | 446 µs | 360 / 295 µs | 452 µs | – |
| `sum_i32/wasm.simd128.resident/1000000` | 141 / 128 µs | 180 / 166 µs | 159 / 144 µs | – |
| `string_len/ts/ascii/16777216` | 62.6 / 36.7 ms | 19.9 ms | 36.7 ms | 164 / 176 ms |
| `string_len/napi/ascii/16777216` | 5.77 ms | 2.17 ms | 1.87 ms | – |
| `string_len/ts/utf8/16777216` | 36.6 / 33.1 ms | 20.8 ms | 32.6 ms | 397 ms |
| `string_len/napi/utf8/16777216` | 47.3 ms | 17.9 ms | 35.5 ms | – |
| `checksum_bytes/ts/16777216` | 29.4 ms | 35.5 ms | 29.4 / 102.9 ms | 117 ms |
| `checksum_bytes/napi` or `ffi` `/16777216` | 29.4 ms | 29.4 ms | 29.4 ms | 29.4 ms |
| `return_bytes/ts/16777216` | 29.5 / 31.1 ms | 14.5 / 17.6 ms | 37.5 / 13.5 ms | 69.3 ms |
| `return_bytes/napi/16777216` | 2.31 / 2.46 ms | 2.10 ms | 2.00 ms | – |
| `return_rows/ts/10000` | 309 / 184 µs | 849 / 639 µs | 274 µs | 1.47 ms |
| `return_rows/napi.objects/10000` | 9.67 ms | 4.69 ms | 10.3 ms | – |
| `return_rows/napi.packed/10000` | 2.10 ms | 1.68 / 1.53 ms | 2.23 ms | – |

Reproduced from the development runs:

- **Boundary cost.**
  - V8 still inlines a trivial WASM call away: `noop/wasm.inlineable` costs exactly what `noop/ts` costs in Node.js and Deno.
  - Node-API costs 13–72 ns per call, FFI 2–4.5 ns.
  - At 10^6 elements every native `sum_i32` path converges on about 122–128 µs.
- **WASM transfer and code generation.** At 10^6 elements the copy into linear memory (`copy − resident`) costs 252–266 µs in every runtime. `simd128` brings the resident sum within 1.0–1.5× of native (Node.js 1.0–1.1×, Deno 1.1–1.2×, Bun 1.4–1.5×).
- **Strings.** ASCII ingress is 6–20× faster than counting bytes in TS. Mixed UTF-8 is no cheaper through native code in Node.js and Deno.
- **Returned data.** No native row strategy breaks even at any size, in any runtime. Returning a 16 MiB buffer is 7–19× faster through native code than filling it in TS.
- **scriptc** is the most stable runtime (1 of 158 results unstable). `string_len/ffi.borrowed` costs 8.9 ns at every size, and FFI `sum_i32` breaks even from 1 element.

Break-even against each runtime's TS, fresh / shared where they differ:

| Path | `sum_i32` | `string_len/ascii` | `string_len/utf8` | `checksum_bytes` | `return_bytes` |
| --- | --- | --- | --- | --- | --- |
| Node `napi` | from 100 | from 64 | never | never / from 65536 | from 1024 |
| Bun `napi` | from 1000 | from 1024 | from 65536 / from 1024 | from 1024 | from 1024 |
| Bun `ffi` | from 100 | from 16 | from 1024 | from 16 | from 16 |
| Deno `napi` | from 1000 / from 100 | from 64 | never | from 16777216 / from 65536 | from 65536 |
| Deno `ffi` | from 100 | from 64 | never / from 1048576 | from 16777216 / from 64 | from 64 |
| scriptc `ffi` | from 1 | from 16 (`ffi.borrowed`) | from 16 (`ffi.borrowed`) | from 16 | – |

`bytes_len` never breaks even: its TS baseline is `data.byteLength`. The WASM `sum_i32` paths break even from 10–100 elements, except Bun `wasm.copy` (never) and Bun `wasm.simd128.copy` (from 1000).

Observed more clearly than before:

- **Node.js TS matches native `checksum_bytes`.** Both take 29.4 ms at 16 MiB. So `napi` never breaks even in a fresh Node.js process, where the development runs had a small native advantage.
- **More V8 JIT-history effects.** 101 cases diverged between fresh and shared processes. Besides the known `sum_i32/ts` rows (shared 0.11–0.15× fresh from 10k elements):
  - Deno `checksum_bytes/ts`: **3.5× slower in a shared process** (102.9 vs 29.4 ms at 16 MiB). Node.js shows the same at 1 MiB.
  - Node.js `bytes_len/ts` from 64 KiB: 7.17 ns fresh vs 1.31 ns shared.
  - Node.js `string_len/ts/ascii` from 1 MiB: shared 0.59× fresh.
  - Deno `return_bytes/ts` from 64 KiB: fresh 2.7–2.8× slower than shared.
- **Stability.** 186 of 1,176 mode/case results exceeded 5% run-to-run spread, against 22–30% in the development runs:

  | Runtime | Unstable |
  | --- | ---: |
  | Bun | 99 of 372 |
  | Deno | 50 of 376 |
  | Node.js | 36 of 270 |
  | scriptc | 1 of 158 |

### Browsers

| Case | Chromium | Firefox |
| --- | ---: | ---: |
| `noop/ts` | 0.55 ns | 0.49 ns |
| `noop/wasm.inlineable` | 0.82 ns | 3.31 ns |
| `sum_i32/ts/10000` | 71.2 / 9.87 µs | 7.03 / 8.08 µs |
| `sum_i32/wasm.copy/1000000` | 706 µs | 866 / 704 µs |
| `sum_i32/wasm.resident/1000000` | 438 µs | 440 µs |
| `sum_i32/wasm.simd128.resident/1000000` | 148 / 136 µs | 159 / 163 µs |
| `noop/worker.ts` (round trip) | 15.2 µs | 19.3 µs |
| `sum_i32/worker.wasm.resident/1000000` | 585 / 507 µs | 489 µs |
| `sum_i32/worker.wasm.transfer/1000000` | 924 / 881 µs | 877 / 904 µs |
| `sum_i32/worker.wasm.copy/1000000` | 3.08 ms | 2.28 / 2.33 ms |
| `sum_i32/worker.wasm.clone/1000000` | 5.18 ms | 3.85 / 3.43 ms |

Reproduced from the development run:

- **The main-thread WASM profile.** Chromium's WASM sums match Node.js within about 5%. `simd128` makes the resident sum 3.0× faster in Chromium and 2.8× in Firefox.
- **Firefox makes a real WASM call** (3.31 ns against a 0.49 ns empty loop).
- **Chromium's TS `sum_i32`** at 10k–100k elements runs 7× slower in a fresh browser (shared 0.14×).
- **Firefox `wasm.copy/1000000`** is slower in a fresh browser, now in two runs: shared 0.81× fresh here, 0.77× before.
- **Messaging costs.** A round trip costs 15–19 µs, and up to 1,000 elements it is most of every Worker path's cost. With the input moved to the Worker (WASM paths, 10^6 elements, added to `resident`):
  - a transfer adds 339–388 µs, almost all of it the copy into linear memory;
  - an explicit copy adds 1.8–2.5 ms;
  - a structured clone adds 3.4–4.6 ms.

  With TS in Firefox the transfer adds 69 µs.

Not reproduced:

- **TypeScript inside Chromium's Worker from 10^5 elements.** `worker.ts.resident/1000000` took 7.71 ms fresh and 9.51 ms shared, against 511 µs fresh in the development run. That makes its decomposition differences negative. In that range the Chromium Worker TS numbers describe V8's tiering of a once-per-message handler, not the messaging. The WASM decomposition is unaffected.
- **Stability.** 101 of 396 mode/case results exceeded 5% spread; 90 of them are Worker cases. 81 cases diverged between fresh and shared pages.

## Setup (development runs)

Measured on 2026-09-28:

- **Machine:** i7-12700H (hybrid: CPUs 0–11 are P-cores with SMT pairs; 4–7 boost to 4.7 GHz, the other P-cores to 4.6 GHz; CPUs 12–19 are E-cores at 3.5 GHz).
- **Settings:** `powersave` governor with intel_pstate EPP `performance`, turbo on.
- **Software:** Node 24.21.0, Bun 1.4.2, Deno 2.9.7, scriptc 0.1.7; Chrome for Testing 153.0.8010.12 (V8 15.3.76.4) and Firefox 156.0.1, both headless.
- **Default harness options** unless stated.

## Methodology evidence

These observations support choices described in [methodology.md](methodology.md).

### CPU pinning

**Pinning doesn't materially distort steady state.** One process per runtime, `--samples 10 --sample-ms 10`, comparing unpinned, `taskset -c 2` and `taskset -c 2,4,6,8`:

| Runtime | Case | Unpinned | 1 CPU | 4 CPUs |
|---|---|---|---|---|
| Node | `noop/napi` | 6.64 ns | 6.73 ns | 6.85 ns |
| Node | `sum_i32/ts/1000` | 547 ns | 558 ns | 548 ns |
| Bun | `add_i32/napi` | 49.7 ns | 44.7 ns | 49.3 ns |
| Bun | `sum_i32/ts/1000` | 214 ns | 217 ns | 213 ns |

The differences are within the run-to-run spread measured below.

### Short warmups

**A short warmup can be bimodal in a fresh process.** 8 fresh Node processes each ran only `add_i32/ts`:

- With `--warmup 1 --samples 3 --sample-ms 2`: 3 of 8 processes stayed at about 3.5 ns/op for the whole run; the rest ran at 0.27 ns/op. The samples inside each process were tight either way, so the within-process stddev can't detect this.
- With default settings: 8 of 8 processes ran at 0.270–0.274 ns/op.

### JIT history: fresh versus shared processes

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

Results are therefore only comparable when the harness options are identical.

### Shared-code changes for scriptc

Supporting scriptc changed shared code: an injected clock in the harness, the payload generator, and the correctness checks. The payloads were proven byte-identical. To check that measurements did not move, a boundary-suite official-profile run of Node.js, Bun and Deno after the change (`results/raw/2026-09-29T00-06-49-069Z`) was compared with the last boundary run before it (`2026-09-28T22-25-19-935Z`):

- The median after/before ratio over all 144 mode/case pairs was 1.001.
- 135 pairs agreed within 5%, or their per-run ranges overlapped.
- 9 differed by 5–19%, all faster except one. Eight of the nine are small Bun or Deno FFI cases.

The FFI library had also changed between the two runs: return functions were added in between. So these nine cannot be attributed with confidence to the shared-code change, to the library change, or to noise.

## Boundary: Node-API and FFI

One official-profile run was made with the `uint32_t` ABI: CPUs 8,10, 3 runs, both modes, 225 processes, no failed units, and `powersave` and turbo still on, so it is not an official result. Median ns/op, fresh process per case:

| Case | Bun napi | Bun ffi | Deno napi | Deno ffi |
| --- | --- | --- | --- | --- |
| `noop` | 37.3 | 1.12 | 7.45 | 2.58 |
| `add_i32` | 44.7 | 1.12 | 30.8 | 2.37 |
| `sum_i32/1` | 67.5 | 2.64 | 41.3 | 10.1 |
| `sum_i32/1000000` | 60,430 | 60,070 | 61,850 | 60,340 |

- At 10^6 elements every native path converges on about 60 µs. At that size the boundary cost no longer matters.
- The FFI paths agreed between the two isolation modes, except Deno `noop/ffi` (2.58 vs 2.36 ns, flagged as divergent). `scripts/compare.ts` lists warmup, samples and sample-ms among the settings that differ between directories.

## Payload ingress

One official-profile run: `results/raw/2026-09-28T22-25-19-935Z`.

- CPUs 8,10, 3 runs, both modes
- 801 processes, no failed units, about 32 minutes
- `powersave` and turbo still on, so it is not an official result

All values are medians of 3 fresh-process runs.

### Buffers are borrowed

`bytes_len` time, 16 B → 16 MiB:

| Path | 16 B | 16 MiB | Max/min across all six sizes |
| --- | --- | --- | --- |
| Node napi | 25.4 ns | 25.8 ns | 1.03 |
| Bun napi | 60.1 ns | 56.9 ns | 1.06 |
| Bun ffi | 1.7 ns | 1.9 ns | 1.19 |
| Deno napi | 31.0 ns | 30.4 ns | 1.04 |
| Deno ffi | 8.9 ns | 8.8 ns | 1.05 |

Copying 16 MiB would take around a millisecond, so none of the five native paths copies the buffer.

### String ingress

At 16 MiB:

| Variant | Path | Node | Bun | Deno |
| --- | --- | --- | --- | --- |
| `ascii` | `ts` | 31.9 ms | 10.2 ms | 18.8 ms |
| `ascii` | `napi` | 2.91 ms | 1.42 ms | 1.35 ms |
| `ascii` | `ffi` | – | 1.01 ms | 1.02 ms |
| `utf8` | `ts` | 19.3 ms | 10.6 ms | 16.8 ms |
| `utf8` | `napi` | 24.3 ms | 9.20 ms | 18.2 ms |
| `utf8` | `ffi` | – | 7.92 ms | 17.0 ms |

- **ASCII (one-byte strings)** converts at roughly memory speed on every native path. Ingress is 7–18× faster than counting UTF-8 bytes in JS.
- **Mixed UTF-8 (two-byte strings with surrogate pairs)** converts about as fast as, or slower than, the JS count. In Node and Deno, native `string_len` never beat `ts` at any measured size.
- **Small strings.** Deno's `encodeInto` + FFI path costs about 70 ns at 16 B, against about 14 ns in Bun.

### `checksum_bytes`

Every native path reaches about 57 µs at 64 KiB and about 15 ms at 16 MiB, the same Rust loop in all runtimes. For JS at 16 MiB, 15–18 ms is close to native.

### History and stability

**V8 JIT history reaches the TS payload loops too.** The divergence table flagged 27 cases, including:

- Node `string_len/ts/ascii` at 1 MiB and above (shared 0.58× fresh)
- Node and Deno `checksum_bytes/ts` at 1 MiB (fresh runs ranged 1.11–2.82 ms in Node)
- the known `sum_i32/ts` rows

**Stability.** 142 of 528 mode/case results exceeded 5% run-to-run spread, far more than in shorter runs. Over 32 minutes on a laptop with `powersave` and turbo, thermal and frequency drift is the likely cause. That is not established.

## Return path

One official-profile run of the return suite only (`make bench-official CPUS=8,10 SUITE=return`): `results/raw/2026-09-28T23-13-03-574Z`.

- 3 runs, both modes, 462 processes, no failed units
- `powersave` and turbo still on, so it is not an official result

All values are medians of 3 fresh-process runs.

| Case | Path | Node | Bun | Deno |
| --- | --- | --- | --- | --- |
| `return_f64` | `napi` | 15.3 ns | 34.3 ns | 17.5 ns |
| | `ffi` | – | 1.8 ns | 2.4 ns |
| `return_string/utf8/1024` | `napi` | 3.0 µs | 1.2 µs | 753 ns |
| | `ffi` | – | 775 ns | 833 ns |
| `return_bytes/16` | `ts` | 28 ns | 10 ns | 943 ns |
| | `napi` | 1.0 µs | 216 ns | 1.1 µs |
| | `ffi` | – | 7 ns | 921 ns |
| `return_bytes/16777216` | `ts` | 15.2 ms | 7.5 ms | 19.1 ms |
| | `napi` | 1.81 ms | 1.60 ms | 1.53 ms |
| | `ffi` | – | 1.57 ms | 1.56 ms |
| `return_rows/10000` | `ts` | 155 µs | 360 µs | 156 µs |
| | `napi.objects` | 5.15 ms | 2.44 ms | 5.56 ms |
| | `napi.packed` | 1.08 ms | 811 µs | 1.17 ms |
| | `ffi.packed` | – | 784 µs | 1.19 ms |

- **Buffer allocation dominates small returns in some runtimes.** A new 16-byte buffer costs:
  - about 1 µs via `napi_create_arraybuffer` in Node and Deno (216 ns in Bun)
  - about 1 µs in Deno even as a plain JS `new Uint8Array(16)`, against 10–28 ns in Bun and Node

  Filling a buffer is cheap by comparison, and from 64 KiB native filling wins everywhere. The mechanism (for example, how each runtime allocates `ArrayBuffer` backing stores) is not established.
- **Building JS objects through Node-API is the most expensive way to return rows.** `napi.objects` is 30–60× slower than building the same objects in JS in Node and Deno, and 7–20× in Bun. The packed strategy is 3–5× faster than `napi.objects`. `napi.packed` and `ffi.packed` perform the same, as their identical semantics predict. JS-side materialisation stays slower than building rows in JS at every size, so no native row path ever breaks even.
- **Returning a scalar through FFI** costs 2–3 ns, against 15–35 ns through Node-API.
- **Returning a string** costs about the same on both paths for ASCII.
  - For small strings, Deno FFI (`TextDecoder`) is about 2× Deno Node-API.
  - For UTF-8, Node's Node-API path is the slowest (3.0 µs at 1 KiB).
- **Stability and history.**
  - 90 of 302 mode/case results exceeded 5% run-to-run spread.
  - The divergence table flagged 20 cases, among them Deno `return_bytes/ts` at 64 KiB and 16 MiB. Fresh-process runs of the latter ranged from 7.3 to 19.3 ms, compared with 7.0 ms shared.
  - Allocation-heavy cases are the most sensitive to GC timing and JIT history.

### Repetitions

Two later official-profile executions of the boundary and return suites (`2026-09-29T01-33-33-823Z` and `2026-09-29T01-55-09-419Z`) had identical settings: `--cpus 8,10 --seed 20260929`, 3 runs, both modes, 759 processes each, no failed units, `powersave` and turbo on. In both, the return paths kept the direction above:

- **`return_bytes` at 16 MiB** was far cheaper through native code than in TS (fresh / shared):
  - Node `napi`: 0.118× / 0.115× TS
  - Bun `ffi`: 0.212× / 0.221× TS
  - Deno `napi`: 0.083× / 0.220× TS
- **At 10k rows, the packed paths stayed slower than TS** (fresh / shared):
  - Node `napi.packed`: 6.79× / 10.20× TS
  - Bun `ffi.packed`: 1.94× / 2.75× TS
  - Deno `napi.packed`: 7.23× / 7.11× TS

Across the two executions, 167 of 500 mode/case groups exceeded 5% spread. The return cases in these runs ran in canonical order, before the misplaced WASM cases, so these results are valid.

## scriptc

One official-profile run of scriptc alone, every suite it supports (`--official --cpus 8,10 --runtimes scriptc`): `results/raw/2026-09-28T23-49-59-309Z`.

- scriptc 0.1.7; 3 runs, both modes, 240 processes, no failed units
- `powersave` and turbo still on, so it is not an official result

All values are medians of 3 fresh-process runs. `ts` is TypeScript compiled ahead of time by scriptc, and there is no JIT.

| Case | `ts` | FFI |
| --- | --- | --- |
| `noop` | 0.44 ns | 1.76 ns |
| `add_i32` | 3.37 ns | 16.3 ns |
| `return_f64` | 0.44 ns | 1.79 ns |
| `sum_i32/1` | 4.54 ns | 4.62 ns |
| `sum_i32/1000` | 3.31 µs | 39.9 ns |
| `sum_i32/1000000` | 3.34 ms | 62.1 µs |
| `string_len/ascii/16` | 105 ns | 4.43 ns (`ffi.borrowed`) |
| `string_len/ascii/16777216` | 83.6 ms | 4.52 ns (`ffi.borrowed`) |
| `string_len/utf8/16777216` | 202 ms | 4.43 ns (`ffi.borrowed`) |
| `bytes_len/16777216` | 4.50 ns | 4.45 ns |
| `checksum_bytes/16777216` | 59.8 ms | 14.9 ms |
| `return_bytes/16777216` | 35.1 ms | – |
| `return_rows/10000` | 784 µs | – |

- **The FFI call itself costs 1.8 ns** for `noop` and `return_f64`, in line with Bun and Deno FFI. `add_i32` costs 16 ns, because its two `number` arguments are converted to `int32_t` on the way in.
- **Native work behind the boundary performs like the other runtimes:**
  - `sum_i32` over 10^6 elements takes 62 µs, against about 60 µs on every other native path;
  - `checksum_bytes` runs at 1.13 GB/s, the same Rust loop.

  From 10 elements, the FFI `sum_i32` is faster than the compiled TS loop.
- **String ingress has no size-dependent cost.** `ffi.borrowed` takes about 4.4 ns from 16 B to 16 MiB, because native code borrows scriptc's own UTF-8 bytes. This is the reason it is a separate path and is not compared with the other runtimes' `ffi`.
- **Compiled TypeScript loops are slower than the JIT runtimes' steady state on these kernels:**
  - `sum_i32` scans about 1.2 GB/s;
  - `string_len` through `charCodeAt` reads about 180 MB/s (ASCII) and 83–190 MB/s (mixed UTF-8);
  - `checksum_bytes` runs at about 280 MB/s.

  So the native share grows. `checksum_bytes` through FFI takes 0.24–0.25× the compiled TS time at every size from 1 KiB.
- **Stable.** Only 8 of 158 mode/case results exceeded 5% run-to-run spread, and one case diverged between isolation modes: `string_len/ts/ascii/16777216`, shared 1.12× fresh. Without a JIT, a fresh process and a shared one run the same machine code, as expected.

## WebAssembly

One official-profile run of the boundary suite: `results/raw/2026-09-29T08-44-48-230Z`.

- Command: `--official --cpus 8,10 --runtimes node,bun,deno --suite boundary --seed 20260929`.
- 3 runs, both modes, 513 processes, no failed units.
- `powersave` and turbo still on, so it is not an official result.

It includes every WASM path, in canonical order, and the `wasm-no-inline` process group. Values are medians of 3 per-run medians, fresh process per case unless stated. Shared-process values agree within about 6%, except the known V8 `sum_i32/ts` rows and some Bun WASM sums (see below).

### A WASM call can disappear

| Case | Node | Deno | Bun |
| --- | ---: | ---: | ---: |
| `noop/ts` | 0.28 ns | 0.28 ns | 0.14 ns |
| `noop/wasm.inlineable` | 0.28 ns | 0.28 ns | 1.36 ns |
| `noop/wasm.no-inline` | 3.01 ns | 2.73 ns | – |
| `add_i32/wasm.inlineable` | 1.54 ns | 1.39 ns | 1.13 ns |
| `add_i32/wasm.no-inline` | 3.36 ns | 2.80 ns | – |
| `noop/napi` | 6.87 ns | 7.35 ns | 30.7 ns |
| `noop/ffi` | – | 2.33 ns | 0.89 ns |

- **In Node.js and Deno, V8 inlines a trivial WASM call into the calling JavaScript.** `noop/wasm.inlineable` costs exactly what the empty TS loop costs, so there is no boundary left to measure. This is how applications run by default.
- **With inlining disabled, a real JS→WASM call costs 2.7–3.0 ns.** That is below Node-API in the same runtimes (6.9–7.4 ns) and close to Deno's FFI (2.3 ns).
- **In Bun, the default WASM call costs 1.1–1.4 ns**, near its FFI. Whether JSC inlines it is not established, and there is no switch to test it.

### The sum: transfer and code generation

At 10^6 elements:

| Path | Node | Bun | Deno |
| --- | ---: | ---: | ---: |
| `ts` (fresh / shared) | 3.67 ms / 568 µs | 224 / 228 µs | 4.19 ms / 504 µs |
| `napi` | 62.8 µs | 64.1 µs | 63.5 µs |
| `ffi` | – | 66.4 µs | 64.5 µs |
| `wasm.copy` | 371 µs | 283 µs | 373 µs |
| `wasm.resident` | 237 µs | 183 µs | 227 µs |
| `wasm.simd128.copy` | 223 µs | 237 µs | 224 µs |
| `wasm.simd128.resident` | 70.5 µs | 88.9 µs | 75.5 µs |

- **The transfer** (`copy − resident`) costs 100–145 µs per call: the `Int32Array.set` of 4 MB into linear memory.
- **The default build's sum is scalar.** Built with `simd128`, the same sum on resident data is 2.1–3.4× faster (237 → 70.5 µs in Node, 183 → 88.9 µs in Bun, 227 → 75.5 µs in Deno). That brings it within 1.1–1.4× of the native Rust paths.
- **The WASM penalty against Node-API and FFI is therefore transfer plus code generation, not the copy alone.** With the default build, the sum is the larger part (61–64% of `wasm.copy` in Node and Deno, 65% in Bun). With `simd128`, the copy dominates.
- An earlier copy-only / sum-only / copy+sum decomposition outside the harness agreed. At 10^6 elements the copy took 152–157 µs, the default sum 163–256 µs, and the `simd128` sum 70–88 µs.

Break-even against each runtime's TS (fresh processes; shared was the same except where noted):

| Path | Node | Bun | Deno |
| --- | --- | --- | --- |
| `wasm.copy` | from 100 | never | from 100 |
| `wasm.resident` | from 10 | from 100 | from 10 |
| `wasm.simd128.copy` | from 100 | never (shared: from 1,000) | from 100 |
| `wasm.simd128.resident` | from 10 | from 100 | from 10 |

In Bun, JSC's TS sum (224 µs at 10^6) beats every WASM path that copies. Only resident input breaks even. In Node and Deno, the fresh-process TS sum is slowed by the known V8 JIT-history effect, which makes WASM look better in fresh processes than in shared ones. Read the break-even per mode.

### Stability and divergence

- 72 of 332 mode/case results exceeded 5% run-to-run spread.
- 26 cases diverged between fresh and shared processes. Besides the known V8 `sum_i32/ts` rows, these were mostly Bun WASM sums (0.71–1.43× shared/fresh; `wasm.resident` at 10^6 elements was 153 µs shared against 183 µs fresh).

### Withdrawn results

Earlier WASM runs (`2026-09-29T01-11-43-837Z`, `2026-09-29T01-33-33-823Z` and `2026-09-29T01-55-09-419Z`) ran the WASM cases *after* the payload and return suites in each shared process. Their shared-process WASM results are therefore not comparable with the other paths, and are withdrawn. That includes the shared `wasm.copy`/TS ratios reported before, such as 0.641× in Node and 0.985× in Deno (see [methodology.md](methodology.md#canonical-order-is-part-of-the-shared-process-protocol)). Those runs also predate the `resident`, `simd128` and `no-inline` paths, so their fresh-process WASM numbers are superseded by the run above. Their return-path results were not affected and are kept under [Return path](#return-path).

## Browsers and Workers

One official-profile run of every browser path: `results/raw/2026-09-29T09-36-05-415Z`.

- Command: `node scripts/bench-browser.ts --official --cpus 2,8,10 --seed 20260929`.
- Chromium and Firefox, 3 runs, both modes (a fresh browser per case, and a shared page per browser and thread), 606 pages, about 21 minutes.
- No failed units and no relaunches. Both browsers were cross-origin isolated, with `performance.now` steps of 5 µs (Chromium) and 20 µs (Firefox).
- `powersave` and turbo still on, so it is not an official result.

Values are medians of 3 per-run medians, fresh browser per case unless stated. Where they differ from the shared page, both are given as fresh / shared.

### Main thread

| Case | Chromium | Firefox | Node (v0.6.0 run) |
| --- | ---: | ---: | ---: |
| `noop/ts` | 0.27 ns | 0.26 ns | 0.28 ns |
| `noop/wasm.inlineable` | 0.41 ns | 1.72 ns | 0.28 ns |
| `add_i32/ts` | 0.28 ns | 0.29 ns | – |
| `add_i32/wasm.inlineable` | 1.99 ns | 1.85 ns | 1.54 ns |
| `sum_i32/ts/1000000` | 360 / 495 µs | 371 / 390 µs | 3.67 ms / 568 µs |
| `sum_i32/wasm.copy/1000000` | 356 µs | 454 / 352 µs | 371 µs |
| `sum_i32/wasm.resident/1000000` | 222 µs | 233 / 220 µs | 237 µs |
| `sum_i32/wasm.simd128.copy/1000000` | 209 µs | 229 / 214 µs | 223 µs |
| `sum_i32/wasm.simd128.resident/1000000` | 71.0 µs | 85.9 / 81.8 µs | 70.5 µs |

- **The server-runtime WASM profile holds in browsers.** Chromium's sums are within about 6% of Node.js on the same machine, as the shared engine family suggests. Firefox is 5–21% slower on the resident sums; its fresh-page `wasm.copy` (454 µs) is the outlier.
  - The copy into linear memory (`copy − resident`) costs 134 µs at 10^6 elements in Chromium. In Firefox it costs 221 µs fresh and 131 µs shared.
  - `simd128` makes the resident sum 3.1× faster in Chromium and 2.7× in Firefox.
- **Firefox makes a real WASM call.** `noop/wasm.inlineable` costs 1.72 ns in Firefox, against 0.26 ns for the empty loop. So SpiderMonkey does not remove the call the way V8 does in Node.js. Chromium's 0.41 ns is close to its empty loop (0.27 ns) but not equal to it. Whether V8 inlines the call completely in Chromium is not established from this alone.
- **V8's JIT-history effect appears in Chromium too.** `sum_i32/ts` at 10k and 100k elements is 7× slower in a fresh browser than in a shared page (35.7 µs vs 4.94 µs, and 357 µs vs 49.4 µs), the same 0.14× ratio as in Node.js and Deno. At 10^6 elements the direction reverses (360 µs fresh, 495 µs shared). Firefox shows no large effect.
- **Break-even** against each browser's own TS sum, fresh / shared:

  | Path | Chromium | Firefox |
  | --- | --- | --- |
  | `wasm.copy` | from 100 | never (fresh, 454 vs 371 µs at 10^6) / from 100 |
  | `wasm.resident` | from 10 | from 100 |
  | `wasm.simd128.copy` | from 100 | from 100 |
  | `wasm.simd128.resident` | from 10 | from 10 |

### Worker round trips

| Case | Chromium | Firefox |
| --- | ---: | ---: |
| `noop/worker.ts` | 7.95 µs | 10.4 µs |
| `noop/worker.wasm` | 7.78 µs | 10.2 µs |
| `add_i32/worker.ts` | 9.26 µs | 10.8 µs |
| `add_i32/worker.wasm` | 9.23 µs | 10.9 µs |
| `sum_i32/worker.wasm.resident/1000` | 8.52 µs | 10.2 µs |

- **The round trip itself costs 8 µs in Chromium and 10.4 µs in Firefox**, with no data and no work. That is about 4,000–6,000 times a main-thread WASM `add_i32`.
- **Below about 1,000 elements, the round trip is almost the whole cost.** TypeScript or WASM behind it makes no measurable difference. Every path from 1 to 1,000 elements lies between 7.6 and 13.8 µs.
- **WASM does not make the messaging cheaper.** `noop` and `add_i32` cost the same through `worker.ts` and `worker.wasm`. The two boundaries are independent, and at these sizes the Worker one dominates.

### Moving the input

Costs added to the resident path (`worker.<impl>.<strategy> − worker.<impl>.resident`), fresh browser per case:

| Elements | Strategy | Chromium ts | Chromium wasm | Firefox ts | Firefox wasm |
| ---: | --- | ---: | ---: | ---: | ---: |
| 10,000 | clone | +28.3 µs | +28.4 µs | +16.0 µs | +16.1 µs |
| | copy | +16.8 µs | +16.2 µs | +15.1 µs | +15.9 µs |
| | transfer | +5.4 µs | +4.4 µs | +2.7 µs | +2.7 µs |
| 1,000,000 | clone | +2.75 ms | +3.04 ms | +1.83 ms | +2.18 ms |
| | copy | +1.42 ms | +1.71 ms | +0.95 ms | +1.22 ms |
| | transfer | +11 µs | +190 µs | +9 µs | +217 µs |

- **A transfer costs about the same at every size.** Moving a 4 MB buffer to the Worker and back adds about 10 µs, against 2–5 µs for 4 bytes.
- **An explicit copy is cheaper than a structured clone of the same bytes.** At 10^6 elements, `slice()` plus a transfer adds 0.95–1.42 ms, and postMessage's clone adds 1.83–2.75 ms. Both give the Worker an independent copy while the caller keeps its array. Why the clone costs more is not established; serialising and deserialising in two steps would explain it.
- **WASM in a Worker pays a second copy.** The received array must be copied into linear memory, because linear memory cannot adopt a transferred buffer. With `transfer`, that copy is almost the whole transfer cost for WASM (190–217 µs at 10^6, against 11 µs for TS). It is close to the main thread's `copy − resident` (131–221 µs).
- **Resident input changes the picture.** With input already in the Worker, `worker.wasm.resident/1000000` costs 235 µs in Chromium: less than the main-thread TS sum (360 µs), and about the main-thread `wasm.resident` (222 µs) plus one round trip. With a structured clone the same sum costs 3.28 ms, 9× the main-thread TS sum.

These are latencies of one request at a time. They do not measure what a Worker is usually for, keeping the main thread free, or throughput with several messages in flight (see [limitations](limitations.md#browsers-and-workers)).

### TypeScript inside a Worker

A Worker handler calls the operation once per message; a main-thread loop calls it many times. V8 treats the two differently:

- Chromium's `worker.ts.resident` costs 46 µs at 10k elements, against a 38 µs compute share (resident − round trip). The main thread's shared-page `sum_i32/ts/10000` takes 4.94 µs.
- At 10^6 elements it costs 511 µs in a fresh browser and 4.89 ms in a shared page, a 9.6× divergence.
- Firefox's Worker TS costs about what its main-thread loop does (410 µs vs 371 µs at 10^6), in both modes.

### Stability and divergence

- 88 of 396 mode/case results exceeded 5% run-to-run spread. 76 of them are Worker cases (37 Chromium, 39 Firefox), whose ~10 µs round trips depend on two threads waking each other. On the main thread, 4 Chromium and 8 Firefox results exceeded it.
- 101 cases diverged between fresh and shared pages. Most are Worker cases below 10^5 elements, where the shared page ran 5–15% faster in both browsers. Other divergent cases:
  - Chromium `sum_i32/ts` at every size: shared 1.2–1.7× fresh up to 1,000 elements, plus the rows above;
  - Chromium's Worker TS sums at 10^5–10^6 elements, and `worker.wasm.clone/100000` (shared 0.73× fresh);
  - Firefox `wasm.copy/1000000` (shared 0.77× fresh), and several Firefox main-thread WASM sums where the shared page was 5–10% faster.

