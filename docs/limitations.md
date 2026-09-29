# Limitations

Known caveats of the current implementation. Planned work (datasets, charts, CI, WASM, browsers, async, a realistic workload) is in [roadmap.md](roadmap.md).

## Measurement

- **V8 JIT-history sensitivity is reported, not resolved.** For V8 (Node, Deno), `sum_i32/ts` at 10k elements and above differs by up to about 10× between a fresh process per case and a shared process. In a fresh process it also depends on how long the process runs (see [findings](findings.md#jit-history-fresh-versus-shared-processes)). JSC (Bun) doesn't show the large-array effect, but a few small Bun cases differ by 11–25% between modes. Official runs publish both modes and flag the divergence. The harness deliberately doesn't work around it with V8-specific flags or changes to the benchmark code, so V8-vs-JSC ratios for these rows must be read per mode.
- **A fixed warmup count doesn't guarantee a steady state.** Run-to-run comparison detects a failure to reach steady state; it doesn't prevent one.
- **No statistical test yet.** The 5% threshold is a heuristic. There are no confidence intervals or tests of whether one run differs from another.
- **GC cost of returned data is included only as it happens.** Garbage from returned strings, buffers and objects is collected whenever the engine decides. Large results can move GC work into or out of individual samples, which shows up as run-to-run spread.
- **Settings are recorded, not enforced.** The harness warns about the governor, turbo and platform profile but never changes them. Only the user can put a machine into official conditions.
- **Pinning includes helper threads.** `taskset` restricts the whole process, so JIT and GC threads compete for the same CPU set. Pinning only the main thread would require code inside each runtime, which the runtimes don't offer in a comparable way.
- **Deno's affinity is checked by count only**, because of its permission model (see [methodology.md](methodology.md#cpu-pinning-linux)).
- **Official runs are long.** An official run of every suite and all four runtimes is about 1,500 processes (3 runs × 494 fresh-process cases plus 4 shared processes). Use `--suite` and `--runtimes` to run and publish parts separately; case methodology doesn't change.

## Semantics that differ between bindings

- **Whether engines allocate internally** while transcoding a string (in either direction) or boxing a returned double is not established.
- **Strings have two shapes in each direction.**
  - Ingress: Node-API transcodes inside the call; FFI transcodes in JS (`encodeInto`) before it.
  - Return: Node-API decodes inside the engine; FFI decodes in JS (`TextDecoder`).

  The data and ownership are identical; the difference is inherent to a C ABI and is recorded in `ownership`.
- **Rows are not one operation across bindings.** A C ABI cannot create JS objects, so the row strategies are named and measured separately (`napi.objects` vs `napi.packed`/`ffi.packed`). Only the packed strategies are comparable between Node-API and FFI.
- **Zero-copy return of native-owned memory is not measured.** External array buffers and deallocator-backed views have binding-specific lifetime rules, and Deno has no finalizer for them (see [Return path](marshalling.md#return-path-native--js)).

## scriptc

- **scriptc covers part of the matrix** (see [scriptc](scriptc.md)):
  - It has no Node-API path.
  - It has no FFI return path for strings, buffers or rows (scriptc 0.1.7 FFI returns only scalars and has no writable spans).
  - Its FFI string ingress is a borrow of its own UTF-8 storage, measured as `ffi.borrowed`, and is not comparable with the other runtimes' `ffi` path.
  - It times with `performance.now()`, not `process.hrtime.bigint()`.
  - Only scriptc 0.1.7 on Linux x86_64 has been verified.

## Platforms

- **Platforms.** Only Linux x86_64 has been verified. `native/napi/build.rs` includes the usual macOS `dynamic_lookup` link flags, but they are untested. The FFI library name follows platform conventions (`.dylib` on macOS, `.dll` on Windows), but only `.so` has been tested. Windows would need linking against `node.lib` and is unsupported. Topology, condition checks and pinning are Linux-only.
