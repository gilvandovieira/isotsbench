# Methodology

This describes what the harness does today. The README describes where the project is heading.

## Scope

Operations are grouped into **suites**. A suite can be run on its own, including in official runs, with `--suite` or `make … SUITE=…`. Selecting a suite changes which cases run, not how they are measured.

| Suite | Operation | Data | Sizes |
| --- | --- | --- | --- |
| `boundary` (M1) | `noop()` | none | n/a |
| | `add_i32(a, b)` | two i32 in, i32 out | n/a |
| | `sum_i32(data)` | `Int32Array` in | 1, 10, 100, 1k, 10k, 100k, 1M elements |
| `payload` (M3) | `string_len(value)` | string in; variants `ascii`, `utf8` | 16 B, 64 B, 1 KiB, 64 KiB, 1 MiB, 16 MiB of UTF-8 |
| | `bytes_len(data)` | `Uint8Array` in | same byte sizes |
| | `checksum_bytes(data)` | `Uint8Array` in | same byte sizes |
| `return` (M3.5) | `return_f64()` | `f64` out | n/a |
| | `return_string(bytes)` | string out; variants `ascii`, `utf8` | 16 B, 64 B, 1 KiB, 64 KiB of UTF-8 |
| | `return_bytes(bytes)` | new `Uint8Array` out | 16 B … 16 MiB, as above |
| | `return_rows(count)` | array of `{ id, score, active, name }` out | 1, 10, 100, 1k, 10k rows |

The **payload** operations measure ingress: getting data from JS into native code. Every result is a number.

- `string_len` returns the UTF-8 byte length of a JS string.
- `bytes_len` returns a buffer's length, without reading its bytes.
- `checksum_bytes` returns the 32-bit FNV-1a hash of the bytes. FNV-1a is a serial pass over every byte, which the compiler cannot vectorise.

The **return** operations measure egress: getting native-produced data into JS. Each call returns a new result, as a real API would. [Return path](#return-path-native--js) describes the strategies.

Every operation runs through each path its runtime supports:

| Path (`impl`) | Node.js | Bun | Deno | `binding` recorded |
| --- | --- | --- | --- | --- |
| `ts`: pure TypeScript | yes | yes | yes | `none` |
| `napi`: Node-API → Rust | yes | yes | yes | `node-api` |
| `ffi`: runtime FFI → C ABI → Rust | no | yes | yes | `bun:ffi` / `Deno.dlopen` |

Node.js has no stable FFI, so it has no `ffi` path.

All calls are synchronous. There are no WASM, browser, scriptc, async or SQLite paths yet.

Case ids are `op/path[/variant][/size]`, for example:

- `sum_i32/ffi/1000`
- `string_len/napi/utf8/65536`
- `return_rows/napi.objects/100`

The path is the `impl` (`ts`, `napi` or `ffi`), extended by a strategy name when one binding measures several representations (`napi.objects`, `napi.packed`, `ffi.packed`).

Each result also records:

- `suite`
- `binding`: the mechanism that crossed into native code
- `size`: elements for `sum_i32`, rows for `return_rows`, payload bytes otherwise
- `variant`: `ascii` or `utf8` for string operations, null otherwise
- `payload`: `{ kind, bytes }`, or `{ kind: "rows", count }` for rows. `kind` is one of `int32array`, `uint8array`, `string-ascii`, `string-utf8` or `rows`. Null for scalar cases.
- `strategy`: `objects` or `packed` for rows, null otherwise
- `ownership`: for return cases, who allocates the result, who fills it, and what is copied (see below). Null for ingress cases.

Fields that didn't exist when older results were recorded are simply absent:

- Results from before FFI have no `binding`; their paths were `ts` and `napi`.
- Results from before M3 have no `variant` or `payload`.
- Results from before M3.5 have no `suite`, `strategy` or `ownership`. Tools derive `suite` from `op`.

## Payloads

`bench/common/payloads.ts` generates the payloads deterministically, so they are byte-identical in every runtime. Each payload is generated once per process and shared by every case that uses it (read-only). Sizes are exact.

| Kind | Content | Size |
| --- | --- | --- |
| `string-ascii` | printable ASCII (0x20–0x7e); one byte per UTF-16 code unit | UTF-8 bytes |
| `string-utf8` | code points of 1, 2, 3 or 4 UTF-8 bytes, uniformly mixed: ASCII, Latin-1 Supplement, CJK, emoji (surrogate pairs in UTF-16) | UTF-8 bytes |
| `uint8array` | pseudo-random bytes | `byteLength` |

Strings are built with `Array.prototype.join`, so they are flat. No case pays for flattening a rope (V8 cons string). The correctness check confirms that each string's `TextEncoder` length equals its nominal size.

## How data crosses each boundary

What each path does with the payload on every call:

| Operation | `ts` | `napi` (Node, Bun, Deno) | `ffi` (Bun, Deno) |
| --- | --- | --- | --- |
| `sum_i32`, `bytes_len`, `checksum_bytes` | reads the typed array in JS | **borrows** the backing store (`napi_get_typedarray_info`); no copy | **borrows**: the runtime passes a pointer to the view (`ptr` / `buffer`) plus the length as `uint32_t`; no copy |
| `string_len` | scans UTF-16 code units in JS and counts UTF-8 bytes; **no copy, no allocation** | **converts and copies**: `napi_get_value_string_utf8` is called once for the length and once to transcode the string into UTF-8 in the addon's reused buffer. The addon allocates nothing per call; the buffer only grows. | **converts and copies in JS**: `TextEncoder.encodeInto` transcodes into a reused `Uint8Array`, then pointer and byte length are **borrowed** by the call. Per the spec, `encodeInto` returns a new `{ read, written }` object each call. |

How much of this is established:

- **Borrowing.** `bytes_len` should take the same time at 16 B and at 16 MiB on the `napi` and `ffi` paths in all three runtimes. A copy would scale with size. See [Evidence](#evidence).
- **String conversion.**
  - Node-API: established by construction. `napi_get_value_string_utf8` writes into caller memory.
  - FFI: established by construction. `encodeInto` writes into the caller's buffer.
  - Not established: whether an engine allocates internally during either conversion, or elides the `encodeInto` result object.
- **Encoding.** Identical everywhere: WHATWG UTF-8, with every lone surrogate becoming U+FFFD (3 bytes). This was checked with empty, ASCII, Latin-1, BMP, astral, lone and trailing surrogates, sliced, concatenated and NUL-containing strings. Node-API in Node, Bun and Deno and `TextEncoder` returned identical byte lengths.

So all native `string_len` paths produce the same UTF-8 bytes in memory the native side can read. They differ only in *where* the transcoding copy happens:

- `napi`: inside the engine during the call
- `ffi`: in JS just before the call, because a C function cannot receive a JS string

The name `string_len` therefore means the same thing on every path: "get this string's UTF-8 bytes to native code". The `ts` baseline computes the same answer without materialising the bytes. The native/TS ratio shows what string ingress costs compared with doing the work in JS.

## Return path (native → JS)

The Rust core only *produces* data (`return_f64`, `fill_ascii`, `fill_utf8`, `fill_bytes`, `row`, `fill_rows_packed`), and always into memory its caller provides. Each binding decides who owns the result. The rule for every path: **nothing returned to JS ever points at native memory.** A returned string or buffer therefore can never outlive native memory. There are no external buffers, finalizers or borrowed native pointers.

Each case records its `ownership` strategy:

| Operation | Path | `ownership` | What happens on each call |
| --- | --- | --- | --- |
| `return_f64` | all | `value` | A double is returned. Whether the engine boxes it (a V8 heap number) is engine-dependent and not established. |
| `return_string` | `napi` | `native-buffer+engine-copy` | Rust fills a reused native buffer. `napi_create_string_utf8` decodes it and copies it into a **new JS string** before the call returns. No native allocation per call. |
| | `ffi` | `js-buffer+TextDecoder` | Rust fills a reused JS `Uint8Array` through a borrowed pointer. `TextDecoder.decode` copies it into a **new JS string**. |
| `return_bytes` | `ts` | `js-alloc+js-fill` | `new Uint8Array(n)`, filled in a JS loop. |
| | `napi` | `js-alloc+native-fill` | `napi_create_arraybuffer` allocates a **new JS-owned buffer**. Rust fills it in place (no intermediate copy), and a `Uint8Array` view is created over it. |
| | `ffi` | `js-alloc+native-fill` | `new Uint8Array(n)` in JS. Rust fills it in place through a borrowed pointer. |
| `return_rows` | `ts` | `js-objects` | JS builds `{ id, score, active, name }` objects. |
| | `napi.objects` | `native-objects` | Rust builds the same objects through Node-API. Each row takes one object, four properties and one string, plus the array. |
| | `napi.packed`, `ffi.packed` | `js-alloc+native-fill+js-decode` | JS-owned buffer as for `return_bytes`, with 32-byte packed records. Rust fills it, and JS decodes it into the same objects (`DataView`, plus `TextDecoder` for names). |

**Two strategies had to be split, not made equivalent.**

1. **Rows.** A C function cannot create JS objects, so FFI can only return packed bytes that JS decodes. Node-API can do either. The two representations therefore have distinct names:
   - `napi.objects`
   - `napi.packed`, which has the same semantics as `ffi.packed` and is directly comparable with it

   All row paths produce identical objects, with the same property order and values; the correctness check verifies this field by field.
2. **Strings.** They have equivalent semantics on every path: a new, JS-owned string with identical content, and no native memory escapes. But where the decoding copy happens differs: inside the engine for Node-API, in `TextDecoder` for FFI. The `ownership` field names the two strategies, and the difference is part of what is measured.

**Allocation that each binding requires is included, not hidden.**

- FFI `return_bytes` and `ffi.packed` allocate the JS buffer inside the timed loop, just as Node-API allocates inside `napi_create_arraybuffer`.
- The reused intermediate buffers for strings exist on both string paths.
- Per-call garbage (strings, buffers, objects) is left to the engine's GC, which runs whenever it runs during the samples.

**`return_string` has no `ts` baseline.** JS has no way to produce these exact strings that doesn't depend on engine string representations, such as `repeat` ropes or sliced strings. A baseline would measure those shortcuts, not string creation. The string paths are compared with each other.

**Not measured, but reported:** handing native-owned memory to JS without a copy. The options are:

- Node-API's `napi_create_external_arraybuffer`, with a finalizer
- `bun:ffi` `toArrayBuffer`, with a deallocator
- Deno's `UnsafePointerView.getArrayBuffer`, which has no finalizer, so the memory's lifetime cannot be tied to the JS object

These paths have different lifetime guarantees, and the cost moves into GC finalisation, outside the timed loop. They would need their own strategy names and methodology.

## Native libraries

Both libraries call the same `native/rust-core`, which knows nothing about bindings. Neither contains benchmark logic.

### Node-API: `native/napi`

A single `cdylib` written against the raw Node-API C ABI. It does not use napi-rs, so the numbers reflect Node-API itself and not the overhead of a binding framework.

Every runtime loads the **same `build/isotsbench_napi.node` file** the same way: `createRequire(import.meta.url)(path)`. Deno runs with `--allow-read --allow-write --allow-ffi`.

`sum_i32` borrows the `Int32Array` backing store via `napi_get_typedarray_info`. It does not copy.

### C ABI: `native/ffi`

A `cdylib` exporting plain C functions:

```c
void     isotsbench_noop(void);
int32_t  isotsbench_add_i32(int32_t a, int32_t b);
int32_t  isotsbench_sum_i32(const int32_t *data, uint32_t len);
uint32_t isotsbench_string_len(const uint8_t *utf8, uint32_t len);
uint32_t isotsbench_bytes_len(const uint8_t *data, uint32_t len);
uint32_t isotsbench_checksum_bytes(const uint8_t *data, uint32_t len);

double   isotsbench_return_f64(void);
uint32_t isotsbench_fill_string_ascii(uint8_t *out, uint32_t len);
uint32_t isotsbench_fill_string_utf8(uint8_t *out, uint32_t len);
uint32_t isotsbench_fill_bytes(uint8_t *out, uint32_t len);
uint32_t isotsbench_fill_rows_packed(uint8_t *out, uint32_t len);   /* len multiple of 32; returns rows */
```

The `fill_*` functions write exactly `len` bytes into memory the caller owns and return what they produced (bytes or rows). They cannot write past a JS buffer, because `len` is its length.

Bun loads it with `bun:ffi` `dlopen`, and Deno with `Deno.dlopen`, both with stable APIs and no extra flags. Deno uses the `--allow-ffi` flag it already had. `bench/common/ffi.ts` declares the same signatures for both:

| C parameter | Bun type | Deno type |
| --- | --- | --- |
| `int32_t` | `i32` | `i32` |
| `const int32_t *` | `ptr` | `buffer` |
| `uint32_t` | `u32` | `u32` |
| return `int32_t` / `void` | `i32` / `void` | `i32` / `void` |

**How `sum_i32` differs from Node-API.** A C function cannot inspect a JavaScript typed array. So the FFI case calls `sum_i32(data, data.length)`:

- Both runtimes pass a pointer to the view's own start, `byteOffset` included, without copying. The offset-view equivalence check confirms this.
- The length crosses the boundary as a second argument.

The algorithm, data layout and wrapping semantics are identical to the other paths. The extra argument is the inherent cost of the C calling convention, not a different benchmark. For an empty array a runtime may pass a null pointer; the C ABI accepts null only when the length is 0.

**Why the length is `uint32_t`, not `size_t`.** With a 64-bit `size_t` length, no single call form is fast in both runtimes. Measured per call on the 1-element sum, pinned to CPUs 8,10, using a throwaway library with both signatures:

| Length argument | Deno | Bun |
| --- | --- | --- |
| `usize`, JS number | 80.4 ns (slow conversion path) | 4.9 ns |
| `usize`, `BigInt(length)` per call | 12.3 ns | 13.6 ns (BigInt allocation) |
| `u32`, JS number | 12.4 ns | 4.5 ns |

With `size_t`, whichever JS type the length is passed as would cost one runtime 8–70 ns per call. At small sizes, that is more than the work being measured. `uint32_t` takes the same JS call code, a plain number, and stays on the fast path in both runtimes. The cost is a limit of 2^32 − 1 elements per call. A caller must not pass more, because the runtime would truncate the length. The benchmark's largest array has 10^6 elements.

The first FFI run used `size_t`, and Deno's `sum_i32/ffi/1` measured 73 ns against 2.5 ns for `noop/ffi`. That gap is what exposed the conversion cost.

## Shared TypeScript

`bench/` is plain TypeScript run directly by each runtime (Node.js 24+ with built-in type stripping, Bun, Deno). It uses only erasable syntax and `node:` built-ins. Nothing is transpiled or bundled.

## Measurement inside one process

For each case, in `bench/common/harness.ts`:

1. **Calibrate.** Double the batch size until one batch takes at least `--sample-ms` (default 20 ms), then scale the batch to that target. The resulting `iterations` is fixed for the case and recorded.
2. **Warmup.** Run `--warmup` batches (default 5). Their timings are saved as `warmup_ns` and left out of the statistics.
3. **Sample.** Run `--samples` batches (default 30). Each one is timed as a whole with `process.hrtime.bigint()`, which has ns resolution in all three runtimes.

ns/op = batch ns / iterations. The reported statistics (median, mean, sample stddev, min, max) are computed over the per-sample ns/op values. ops/s = 1e9 / median ns/op. p95/p99 are not reported: with 30 batched samples they would not be meaningful.

- **Correctness is checked after measurement.** Once timing is done, `checkEquivalence()` checks that every native path the runtime has (Node-API, plus FFI in Bun and Deno) returns exactly what the TypeScript reference returns. A process checks every operation of the suites it measured, and only those:

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

A process that measured payload cases generates and scans the 16 MiB payloads, which takes about 0.7–1 s; other processes skip that. All of this runs after timing and is not measured. (Before M3.5, every process checked every operation.)

A mismatch fails the process, and the orchestrator records the unit as failed and discards its results, so a failed check means results are never accepted. This was tested by deliberately breaking the C ABI's `sum_i32` by one: every Bun and Deno FFI unit failed and the run exited 1. The check runs *after* timing on purpose. Calling the functions first with overflowing and edge-case inputs would shape the JIT's type feedback for the code about to be measured.
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
- **Break-even** is the smallest measured size from which native is faster than TS at that size *and every larger measured size*. The sizes are decades (payload sizes step by up to 64×), so the true crossover lies somewhere between the reported size and the one below it. The summary prints a break-even table for every sized operation. `never` means native never became and stayed faster within the measured sizes.
- **Data rate** is payload bytes ÷ median time per call, shown for every case whose operation reads its payload. `bytes_len` never reads its bytes, and its time does not depend on the size. It measures only the hand-over, so its data rate is shown as `-`.
- **`bytes_len`** has a trivial TS baseline (`data.byteLength`, inlined to almost nothing). Like `noop`, the meaningful number is the absolute native cost of handing over a buffer, and whether it stays constant across sizes.
- **`string_len`** compares string ingress on the native paths with a JS-side byte count (see [How data crosses each boundary](#how-data-crosses-each-boundary)). The `ascii` and `utf8` variants are reported separately, because engines store and convert one-byte and two-byte strings differently.

## Output

`results/raw/<run-id>/` (git-ignored; commit a run on purpose when you publish it):

- `environment.json`
  - hardware and OS, plus `system` (above) and load averages
  - runtime, rustc and cargo versions, `RUSTFLAGS`, git commit and dirty flag
  - `methodology`: profile, isolation (`case`, `runtime` or `both`), runs, order, seed, CPUs and the exact `taskset` command and version, the runtime command lines, filter, canonical case list, `casesByRuntime` (Node.js lists no `ffi` cases), and when equivalence is checked
  - `options`: warmup, samples, sample-ms
  - `conditions`: warnings and `officialCriteriaMet`
  - `failedUnits`
  - `native`: path and SHA-256 of the Node-API addon and the C ABI library that were measured
- `<runtime>.json` (schema 2)
  - `process.versions` as the runtime reports it, the timer and options
  - one entry per case per run: `impl`, `binding`, `size`, `variant`, `payload`, `run`, `isolation`, `sequence`, `process` (pid, affinity, allowed CPU count, execArgv, start/end time), `iterations`, raw `warmup_ns` and `samples_ns`, derived `ns_per_op` statistics and `ops_per_s`

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

Results are therefore only comparable when the harness options are identical.

**FFI paths.** One official-profile run was made with the `uint32_t` ABI: CPUs 8,10, 3 runs, both modes, 225 processes, no failed units, and `powersave` and turbo still on, so it is not an official result. Median ns/op, fresh process per case:

| Case | Bun napi | Bun ffi | Deno napi | Deno ffi |
| --- | --- | --- | --- | --- |
| `noop` | 37.3 | 1.12 | 7.45 | 2.58 |
| `add_i32` | 44.7 | 1.12 | 30.8 | 2.37 |
| `sum_i32/1` | 67.5 | 2.64 | 41.3 | 10.1 |
| `sum_i32/1000000` | 60,430 | 60,070 | 61,850 | 60,340 |

- At 10^6 elements every native path converges on about 60 µs. At that size the boundary cost no longer matters.
- The FFI paths agreed between the two isolation modes, except Deno `noop/ffi` (2.58 vs 2.36 ns, flagged as divergent). `scripts/compare.ts` lists warmup, samples and sample-ms among the settings that differ between directories.

**Payload operations (M3).** One official-profile run: `results/raw/2026-09-28T22-25-19-935Z`.

- CPUs 8,10, 3 runs, both modes
- 801 processes, no failed units, about 32 minutes
- `powersave` and turbo still on, so it is not an official result

All values are medians of 3 fresh-process runs.

*Buffers are borrowed.* `bytes_len` time, 16 B → 16 MiB:

| Path | 16 B | 16 MiB | Max/min across all six sizes |
| --- | --- | --- | --- |
| Node napi | 25.4 ns | 25.8 ns | 1.03 |
| Bun napi | 60.1 ns | 56.9 ns | 1.06 |
| Bun ffi | 1.7 ns | 1.9 ns | 1.19 |
| Deno napi | 31.0 ns | 30.4 ns | 1.04 |
| Deno ffi | 8.9 ns | 8.8 ns | 1.05 |

Copying 16 MiB would take around a millisecond, so none of the five native paths copies the buffer.

*String ingress.* At 16 MiB:

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

*`checksum_bytes`.* Every native path reaches about 57 µs at 64 KiB and about 15 ms at 16 MiB, the same Rust loop in all runtimes. For JS at 16 MiB, 15–18 ms is close to native.

**V8 JIT history reaches the TS payload loops too.** The divergence table flagged 27 cases, including:

- Node `string_len/ts/ascii` at 1 MiB and above (shared 0.58× fresh)
- Node and Deno `checksum_bytes/ts` at 1 MiB (fresh runs ranged 1.11–2.82 ms in Node)
- the known `sum_i32/ts` rows

**Stability.** 142 of 528 mode/case results exceeded 5% run-to-run spread, far more than in shorter runs. Over 32 minutes on a laptop with `powersave` and turbo, thermal and frequency drift is the likely cause. That is not established.

**Return path (M3.5).** One official-profile run of the return suite only (`make bench-official CPUS=8,10 SUITE=return`): `results/raw/2026-09-28T23-13-03-574Z`.

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

## Known limitations

- **V8 JIT-history sensitivity is reported, not resolved.** For V8 (Node, Deno), `sum_i32/ts` at 10k elements and above differs by up to about 10× between a fresh process per case and a shared process. In a fresh process it also depends on how long the process runs (see [Evidence](#evidence)). JSC (Bun) doesn't show the large-array effect, but a few small Bun cases differ by 11–25% between modes. Official runs publish both modes and flag the divergence. The harness deliberately doesn't work around it with V8-specific flags or changes to the benchmark code, so V8-vs-JSC ratios for these rows must be read per mode.
- **Whether engines allocate internally** while transcoding a string (in either direction) or boxing a returned double is not established.
- **Strings have two shapes in each direction.**
  - Ingress: Node-API transcodes inside the call; FFI transcodes in JS (`encodeInto`) before it.
  - Return: Node-API decodes inside the engine; FFI decodes in JS (`TextDecoder`).

  The data and ownership are identical; the difference is inherent to a C ABI and is recorded in `ownership`.
- **Rows are not one operation across bindings.** A C ABI cannot create JS objects, so the row strategies are named and measured separately (`napi.objects` vs `napi.packed`/`ffi.packed`). Only the packed strategies are comparable between Node-API and FFI.
- **Zero-copy return of native-owned memory is not measured.** External array buffers and deallocator-backed views have binding-specific lifetime rules, and Deno has no finalizer for them (see [Return path](#return-path-native--js)).
- **GC cost of returned data is included only as it happens.** Garbage from returned strings, buffers and objects is collected whenever the engine decides. Large results can move GC work into or out of individual samples, which shows up as run-to-run spread.
- **Official runs are long.** An official run of every suite is about 1,100 processes. Use `--suite` to run and publish suites separately; case methodology doesn't change.
- **Settings are recorded, not enforced.** The harness warns about the governor, turbo and platform profile but never changes them. Only the user can put a machine into official conditions.
- **Pinning includes helper threads.** `taskset` restricts the whole process, so JIT and GC threads compete for the same CPU set. Pinning only the main thread would require code inside each runtime, which the runtimes don't offer in a comparable way.
- **Deno's affinity is checked by count only**, because of its permission model (see above).
- **A fixed warmup count doesn't guarantee a steady state.** Run-to-run comparison detects a failure to reach steady state; it doesn't prevent one.
- **No statistical test yet.** The 5% threshold is a heuristic. There are no confidence intervals or tests of whether one run differs from another.
- **Platforms.** Only Linux x86_64 has been verified. `native/napi/build.rs` includes the usual macOS `dynamic_lookup` link flags, but they are untested. The FFI library name follows platform conventions (`.dylib` on macOS, `.dll` on Windows), but only `.so` has been tested. Windows would need linking against `node.lib` and is unsupported. Topology, condition checks and pinning are Linux-only.
- There are no normalised JSON/CSV datasets, charts, or regression checks yet.
