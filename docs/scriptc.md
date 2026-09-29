# scriptc

[scriptc](https://scriptc.dev) 0.1.7 compiles TypeScript ahead of time into a native executable with no JavaScript engine in it. Native code is called through a link-time C ABI manifest (`--ffi`).

**Build.** `scripts/build.ts` (and `make build` or `scripts/bench.ts`, when scriptc is on `PATH`) does the following:

1. Builds `native/scriptc` into a static archive. The archive compiles the **same source file** as `native/ffi` (`#[path]` include), so the shared C ABI functions are identical. It does not link the `native/ffi` crate: adding a crate type there changes the bytes of the `.so` that Bun and Deno load, and that `.so` stays byte-for-byte unchanged.
2. Runs `scriptc build bench/scriptc/run.ts --ffi native/scriptc/ffi.json -o build/isotsbench-scriptc` with scriptc's defaults (LLVM backend, `-O2`).

`environment.json → native.scriptc` records the compiler version, this exact command, and the SHA-256 of the executable, the archive and the manifest.

**Standalone executable.** `build/isotsbench-scriptc`:

- depends only on libc, libm and libgcc_s (`ldd`);
- ran the full FFI matrix inside a `bwrap` sandbox with no `/usr/bin` and no home directory, so no Node.js, Bun or Deno existed there (`execvp /usr/bin/node: No such file or directory`).

**Paths.** `ts` is the compiled TypeScript baseline, running the same TS reference implementations and payloads as every other runtime. The FFI paths record `binding: "scriptc-ffi"` and an `ownership` value.

| Case | `ts` | FFI path | FFI semantics |
| --- | --- | --- | --- |
| `noop`, `add_i32`, `return_f64` | yes | `ffi` | scalar call to the shared C symbol |
| `sum_i32` | yes | `ffi` | `borrowed-byte-alias`: the `bytes` class accepts only `Uint8Array`, so each case creates once (outside timing) a `Buffer` over the same memory as the `Int32Array` (`Buffer.from(data.buffer, …)`, no copy). A `size_t` adapter passes it to the shared `sum_i32`. |
| `string_len` | yes | **`ffi.borrowed`** | `borrowed-utf8-string`: see below |
| `bytes_len`, `checksum_bytes` | yes | `ffi` | `borrowed`: pointer and length of the `Uint8Array`, no copy |
| `return_bytes`, `return_rows` | yes | none | FFI cannot return data (see below) |
| `return_string` | none | none | no TS path exists anywhere; FFI cannot return data |

**Differences from the other runtimes, and how they are handled:**

- **Strings are UTF-8 inside scriptc.** Its FFI hands native code the string's own bytes, borrowed for the call, with no transcoding and no copy. `string_len` through scriptc's FFI measured the same time from 16 B to 16 MiB (about 4.4 ns). Node-API and Bun/Deno FFI transcode and copy on every call. The operation still means "get this string's UTF-8 bytes to native code", but the cost profile is fundamentally different. So it is measured as its own path, **`string_len/ffi.borrowed/…`**, not as `ffi`. The TS baseline reads the same UTF-8 storage through `charCodeAt`.
- **Lone surrogates cannot exist in scriptc strings.** They become U+FFFD when the string is created (`"a\ud800b".charCodeAt(1)` is 65533). Every runtime encodes a lone surrogate as U+FFFD anyway, so `string_len` results are identical. It is still a language-level difference.
- **Span lengths are `size_t`.** scriptc passes `string` and `bytes` parameters as `(const uint8_t *, size_t)`, while the shared ABI takes `uint32_t` lengths (the Bun/Deno fast-path decision). Four thin adapters in `native/scriptc` convert the length and call the shared functions; a length above `uint32_t` aborts.
- **No return path beyond scalars.** scriptc 0.1.7 FFI returns only scalars, and its spans are read-only, so native code can neither return a buffer nor fill one the caller owns. scriptc's online guide describes a writable `mutable-bytes` class (format 6), but no released version supports it: 0.1.7 is the latest and accepts formats 1–5. `return_string`, `return_bytes` and `return_rows` therefore have no scriptc FFI path, and nothing emulates them.
- **Clock.** scriptc has no `process.hrtime`, so its harness uses `performance.now()` (steps of about 40 ns measured here) and records `timer: "performance.now"`. Calibration, warmup, samples and statistics are the same code (`bench/common/harness.ts`, with the clock injected). With batches of about 20 ms, the clock's resolution adds less than 0.001% to a sample.
- **CPU affinity** is read from `/proc/self/status`, and the allowed-CPU count is derived from that list (scriptc has no `os.availableParallelism`). Pin verification works as for the other runtimes.
- **Correctness** runs after measurement through the same shared checks (`bench/common/checks.ts`) with scriptc's FFI adapters. A void native `noop` has no JS value to compare with `undefined`, so for scriptc that check only confirms the call. A deliberately broken adapter (`string_len` off by one) failed the process with exit 1.

**Shared code changed for scriptc, without changing what is measured elsewhere.** scriptc 0.1.7 cannot compile some constructs: default imports, `Uint16Array`, `String.fromCodePoint`/`apply`, `Math.max`, `Map` values of `Uint8Array`, tuple indexing with a variable, and `unknown`. So:

- The string payload generator was rewritten. It is proven to produce byte-identical payloads in Node.js, Bun and Deno: same SHA-256 for every size and variant.
- The `Case` type moved to `case.ts`.
- The harness takes an injected clock; the `hrtime` clock is the original code, moved to `clock-hrtime.ts`.
- The correctness checks moved to a typed, shared `checks.ts`.
- `suites.ts` got explicit types, and the table formatter no longer uses `Math.max`.

The Node-API addon and the `.so` keep their SHA-256.
