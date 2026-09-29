# Findings

Observations from development runs on one machine. They explain methodological choices and show what the benchmark can reveal. **None of them is an official result**: the reference machine ran with the `powersave` governor and turbo enabled (see [methodology.md](methodology.md#official-run-procedure)). Raw data for the runs named here is local to that machine (`results/raw/` is not committed).

## Summary

Cost profiles observed so far. The sections below give the numbers.

- **Boundary cost varies by binding and runtime.** A call through Bun or Deno FFI costs 1–3 ns; Node-API costs 7–45 ns depending on the runtime. See [Boundary](#boundary-node-api-and-ffi).
- **Past about 1M elements, the binding no longer matters.** Every native path runs `sum_i32` over 10^6 elements in about 60 µs.
- **Buffers cross without copying.** Handing over a `Uint8Array` costs the same at 16 B and at 16 MiB on every native path.
- **Strings have a cost profile of their own.** ASCII ingress runs at roughly memory speed, but mixed UTF-8 is no faster than counting bytes in JS, and in Node and Deno never beat it.
- **Returning structured data is where native paths lose.** Building rows as JS objects through Node-API is 30–60× slower than building them in JS in Node and Deno. Packed records decoded in JS are 3–5× faster than that, but still slower than plain JS at every size.
- **V8 results can depend on JIT history.** Some pure-TS loops differ by up to about 10× between a fresh process and a shared one, which is why official runs report both.
- **Ahead-of-time compiled TypeScript has a different profile.** Under scriptc:
  - an FFI call costs about 1.8 ns;
  - string ingress is a size-independent borrow;
  - fresh and shared processes agree;
  - the compiled TS loops are slower than the JIT runtimes' steady state, so native code wins from smaller sizes.

  See [scriptc](#scriptc).

## Setup

Measured on 2026-09-28:

- **Machine:** i7-12700H (hybrid: CPUs 0–11 are P-cores with SMT pairs; 4–7 boost to 4.7 GHz, the other P-cores to 4.6 GHz; CPUs 12–19 are E-cores at 3.5 GHz).
- **Settings:** `powersave` governor with intel_pstate EPP `performance`, turbo on.
- **Software:** Node 24.21.0, Bun 1.4.2, Deno 2.9.7, scriptc 0.1.7.
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
