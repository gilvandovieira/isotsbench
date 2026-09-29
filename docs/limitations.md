# Limitations

Known caveats of the current implementation. Planned work (datasets, charts, CI, async, a realistic workload) is in [roadmap.md](roadmap.md).

## Measurement

- **V8 JIT-history sensitivity is reported, not resolved.** For V8 (Node, Deno), `sum_i32/ts` at 10k elements and above differs by up to about 10× between a fresh process per case and a shared process. In a fresh process it also depends on how long the process runs (see [findings](findings.md#jit-history-fresh-versus-shared-processes)). JSC (Bun) doesn't show the large-array effect, but a few small Bun cases differ by 11–25% between modes. Official runs publish both modes and flag the divergence. The harness deliberately doesn't work around it with V8-specific flags or changes to the benchmark code, so V8-vs-JSC ratios for these rows must be read per mode.
- **A fixed warmup count doesn't guarantee a steady state.** Run-to-run comparison detects a failure to reach steady state; it doesn't prevent one.
- **No statistical test yet.** The 5% threshold is a heuristic. There are no confidence intervals or tests of whether one run differs from another.
- **GC cost of returned data is included only as it happens.** Garbage from returned strings, buffers and objects is collected whenever the engine decides. Large results can move GC work into or out of individual samples, which shows up as run-to-run spread.
- **Settings are recorded, not enforced.** The benchmark runners warn about the governor, turbo and platform profile but never change them. `make setup` applies them on request (Linux, `sudo`), and `make teardown` restores the saved values. Conditions are checked only when a run starts, so a power daemon that changes them mid-run goes unnoticed.
- **No run has met the official criteria yet.** The pinned official-profile runs behind [findings](findings.md) used the `powersave` governor with turbo enabled. In the v0.6.0 WebAssembly run, 72 of 332 mode/case results exceeded 5% spread; in the v0.7.0 browser run, 88 of 396. Their directions are development findings; official publication still needs a prepared machine.
- **Pinning includes helper threads.** `taskset` restricts the whole process, so JIT and GC threads compete for the same CPU set. Pinning only the main thread would require code inside each runtime, which the runtimes don't offer in a comparable way.
- **Deno's affinity is checked by count only**, because of its permission model (see [methodology.md](methodology.md#cpu-pinning-linux)).
- **Official runs are long.** An official run of every suite and all four runtimes uses about 1,600 processes. Use `--suite` and `--runtimes` to run and publish parts separately; case methodology doesn't change.

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

## WebAssembly

- **WASM covers only the boundary suite** in Node.js, Bun and Deno, and only when the `wasm32-unknown-unknown` target is installed. `payload` and `return` paths remain deferred; see [wasm.md](wasm.md).
- **`wasm.inlineable` may measure no crossing at all.** V8 inlines small JS→WASM calls by default, so `noop/wasm.inlineable` can be an empty loop. `wasm.no-inline` measures the call with inlining disabled. It is a diagnostic: a real application runs with the default.
- **No `wasm.no-inline` path for Bun.** JavaScriptCore has no known equivalent switch, and whether it inlines JS→WASM calls is not established.
- **Deno's no-inline flag cannot be verified from inside the process.** It is passed as `--v8-flags`, which `process.execArgv` does not show; results record `v8FlagsVerified: null`, and the orchestrator records the command.
- **`sum_i32/wasm.copy` is not a borrowed-buffer call.** It includes a full copy into linear memory per call, while Node-API and FFI borrow the JS array. Its cost and break-even describe the end-to-end WASM path; `wasm.resident` and `simd128` separate transfer from code generation.
- **WASM input buffers are reserved outside timing**, once per case, and are never freed before the process exits. Process start, module compilation and instantiation are outside timing.

## Browsers and Workers

- **Two browsers, one platform.** Only Chromium (Chrome for Testing 153, V8) and Firefox 156 (SpiderMonkey), headless on Linux x86_64, have been verified. WebKit/Safari and mobile browsers are not covered. Whether headed browsers behave differently is not established.
- **Coarse clocks.** Browsers clamp `performance.now()`: 5 µs steps in Chromium and 20 µs in Firefox, even cross-origin isolated. At the default 20 ms batch that is at most 0.1%. Shorter `--sample-ms` values raise it, and the orchestrator warns above 0.1%.
- **A browser is many processes.** Pinning restricts the whole browser to the CPU set: its main process, renderers, GPU and network processes, and the Worker thread. Background work at browser start-up is reduced by launch flags and prefs, not excluded. In fresh-browser mode it can overlap the first batches. Warmup absorbs that only as far as it lasts.
- **Chromium occasionally stalls at start-up.** Once during development, a freshly launched, pinned Chromium created its page renderer 5 s late. After more than 30 s the page still had not run: the renderer had used no CPU and had no Worker thread. It did not recur in 140 further launches of the benchmark page with the same flags and pinning, or in 60 launches of a trivial page. The cause is not established. The orchestrator relaunches a browser that has not loaded the page within 30 s, before anything is measured, and records `launchAttempts`.
- **No `wasm.no-inline` in browsers.** It would need engine flags that the page cannot verify, and Firefox has no known equivalent. Whether SpiderMonkey inlines small JS→WASM calls is not established.
- **Worker paths measure sequential round trips only.** There are no pipelined messages, no `SharedArrayBuffer`/`Atomics` paths, and no payload or return suites. Worker WASM uses the default build only.
- **Worker round trips include thread wake-ups.** Each request wakes the Worker's thread and each reply wakes the page's, so the latency depends on the scheduler, CPU idle states and frequency governor as well as on the browser. That share is not quantified.
- **The Worker decomposition is approximate.** Round trip, compute and transfer costs are differences of independent medians. At small sizes they are within the noise of a ~10 µs round trip and can be negative.
- **Worker compute is not main-thread compute.** A Worker handler calls the operation once per message; a main-thread loop calls it many times in one function. JITs optimise the two differently, so `worker.ts.resident − noop/worker.ts` need not equal `sum_i32/ts`.
- **Main-thread loops are copies.** `bench/browser/main-cases.ts` repeats the loops of `bench/common/cases.ts`, which cannot be loaded in a browser. The tests check that the case ids and results agree, not that the loop source is identical.
- **Type stripping uses an experimental Node.js API** (`stripTypeScriptTypes`), which prints an `ExperimentalWarning`. It only erases types, and the code the browser receives keeps its line and column positions.

## Platforms

- **Platforms.** Only Linux x86_64 has been verified. `native/napi/build.rs` includes the usual macOS `dynamic_lookup` link flags, but they are untested. The FFI library name follows platform conventions (`.dylib` on macOS, `.dll` on Windows), but only `.so` has been tested. Windows would need linking against `node.lib` and is unsupported. Topology, condition checks and pinning are Linux-only.
