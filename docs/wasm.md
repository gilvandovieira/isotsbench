# WebAssembly

Direct WebAssembly calls under Node.js, Bun and Deno. The module is a `wasm32-unknown-unknown` build of `native/wasm`, a thin ABI over the same `native/rust-core` used by Node-API and FFI. There is no `wasm-bindgen` or other framework. WASM covers the `boundary` suite. Browsers load the same artifacts on the main thread and in a Worker ([browser.md](browser.md)).

## Build

When rustc has the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`), `scripts/build.ts` builds the module twice from the same source, into separate target directories:

| Artifact | Build | Paths |
| --- | --- | --- |
| `build/isotsbench.wasm` | the target's default features, which include no SIMD | `wasm.inlineable`, `wasm.no-inline`, `wasm.copy`, `wasm.resident` |
| `build/isotsbench-simd128.wasm` | the same with `-C target-feature=+simd128` added to `RUSTFLAGS` | `wasm.simd128.copy`, `wasm.simd128.resident` |

If the target is missing, the build is skipped with a warning and stale artifacts are removed. WASM cases then do not exist, just as a missing runtime is skipped.

The runner loads each module with `WebAssembly.Module` and `WebAssembly.Instance` before timing; neither module has imports. `environment.json → wasm` records the target, `rustc -vV`, and for each variant the exact Cargo command, the effective `RUSTFLAGS`, and the artifact's path, size and SHA-256.

## Paths

| Case | Artifact | What each timed call does | `strategy` / `ownership` |
| --- | --- | --- | --- |
| `noop/wasm.inlineable`, `add_i32/wasm.inlineable` | default | a direct call, exactly as the runtime runs it by default | `inlineable` |
| `noop/wasm.no-inline`, `add_i32/wasm.no-inline` | default | the same call in a V8 process with JS→WASM inlining disabled (diagnostic; Node.js and Deno only) | `no-inline` |
| `sum_i32/wasm.copy/<n>` | default | copies the JS `Int32Array` into linear memory, then calls the Rust sum | `copy` / `js-to-wasm-memory-copy` |
| `sum_i32/wasm.resident/<n>` | default | calls the Rust sum on input copied into linear memory once, outside timing | `resident` / `wasm-memory-resident` |
| `sum_i32/wasm.simd128.copy/<n>` | simd128 | as `wasm.copy` | `copy` / `js-to-wasm-memory-copy` |
| `sum_i32/wasm.simd128.resident/<n>` | simd128 | as `wasm.resident` | `resident` / `wasm-memory-resident` |

`binding` is `WebAssembly` for the default artifact and `WebAssembly+simd128` for the other. All paths compute the same wrapping sum over the same values, and the post-measurement check verifies both builds (with the copy, on every size, an empty array and an offset view).

## The call can disappear: `inlineable` vs `no-inline`

V8 inlines JS→WASM calls by default (`--turbo-inline-js-wasm-calls`): the JS-to-WASM wrapper, and then the body of a small WASM function, are compiled into the calling JS code. For an empty `noop` nothing is left. `noop/wasm.inlineable` then measures an empty loop in Node.js and Deno, the same as `noop/ts`: **there is no boundary left to measure.** This is a finding, not an artifact to hide. For small WASM functions, the optimizer can remove the cost the benchmark set out to measure.

`wasm.inlineable` keeps the runtime's default, because that is what applications get. `wasm.no-inline` is a diagnostic that makes the call observable. It runs in its own **process group** (see [methodology.md](methodology.md#process-groups)), started with `--no-turbo-inline-js-wasm-calls`:

- **Node.js** takes the flag directly. The runner refuses to start the group unless `process.execArgv` contains it (`v8FlagsVerified: true`).
- **Deno** takes it as `--v8-flags=--no-turbo-inline-js-wasm-calls`. That flag is not visible inside the process, so the result records `v8FlagsVerified: null`, and the orchestrator records the exact command. Setting the flag from inside with `node:v8` `setFlagsFromString` works in Node.js but has no effect in Deno, so it is not used.
- **Bun** (JavaScriptCore) has no known equivalent switch, so it has no `wasm.no-inline` path. Whether JSC inlines JS→WASM calls is not established.

Only `noop` and `add_i32` have a `no-inline` variant: for `sum_i32` the call is a small part of a copy plus a scan.

## The sum: transfer versus code generation

A JS array and WASM linear memory are separate, so `wasm.copy` pays `Int32Array.set` on every call; Node-API and FFI borrow the JS array instead. The copy is not the whole story. The default `wasm32-unknown-unknown` build has no SIMD, while the native Rust build is auto-vectorised. The four sum paths separate the two effects:

- `wasm.copy − wasm.resident` ≈ the transfer (copy into linear memory)
- `wasm.resident` versus `wasm.simd128.resident` = the code generation (scalar versus SIMD)
- `wasm.simd128.resident` versus the native paths = what remains of the WASM execution itself

On the reference machine, a copy-only / sum-only / copy+sum decomposition at 10^6 elements showed that the default sum costs about as much as the copy, or more; SIMD cut the sum 2–3.7×, to near the native ~60 µs. Measured numbers are in [findings.md](findings.md#webassembly). The WASM penalty is **transfer cost plus code-generation differences**, not the linear-memory copy alone.

## Not covered

- **Payload and return suites.** Copying a buffer merely to read its length would change what `bytes_len` measures; `checksum_bytes` would include a transfer before the scan; strings would need encoding plus a copy. Return paths have the same problem in reverse. They stay deferred until their transfer semantics can be named and compared honestly ([roadmap.md](roadmap.md)).
- **Start-up.** Process start, module compilation and instantiation are outside timing.
- **Browsers and Workers.** See [browser.md](browser.md).

WASM buffers are reserved once per case while cases are built, before any timing, and live until the process exits. The typed-array view over linear memory is recreated once per batch, because an allocation can grow the memory and replace `memory.buffer`. Pointers returned by the module are read as unsigned 32-bit numbers.
