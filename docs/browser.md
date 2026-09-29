# Browsers and Workers

The boundary suite in real browsers, in two separate groups:

- **Main thread:** the TypeScript baseline and the WebAssembly paths of Node.js, Bun and Deno, with the same case ids, loops, data and WASM artifacts.
- **Worker:** the same operations sent from the main thread to a dedicated Worker and back. These paths isolate what Worker communication adds, and how each way of moving an `Int32Array` (structured clone, explicit copy, `Transferable` transfer) costs.

Verified browsers: Chromium (V8) and Firefox (SpiderMonkey), both headless. WebKit is not covered (see [Not covered](#not-covered)). Measured results are in [findings.md](findings.md#browsers-and-workers).

## Running

```bash
make bench-browser-quick                # smoke run: one page per browser and thread, short batches
make bench-browser                      # fresh browser per case, 1 run
make bench-browser-official CPUS=2,8,10 # pinned, fresh and shared pages, shuffled, 3 runs
make compare RUNS="results/raw/<a> results/raw/<b>"
```

`scripts/bench-browser.ts` takes the same schedule options as `scripts/bench.ts` (`--isolation`, `--runs`, `--order`, `--seed`, `--cpus`, `--official`, `--warmup`, `--samples`, `--sample-ms`, `--filter`), plus:

- `--browsers chromium,firefox`: browsers to run. A missing browser is skipped. `CHROMIUM_PATH` and `FIREFOX_PATH` select a binary; otherwise the usual names are looked up on `PATH` (`chromium`, `google-chrome`, …, `firefox`).
- `--threads main,worker`: which group to run.
- `--timeout-s N`: per-page limit (default 900 s). A page that hangs fails its unit.

The WASM target is required (`rustup target add wasm32-unknown-unknown`): without the artifacts there is nothing to compare. Node.js 24.2+ runs the orchestrator and the local server. No npm package, browser driver or bundler is used.

`make test` runs `tests/browser.test.ts` in every browser it finds and skips the others.

## How a page runs

For every scheduled unit, the orchestrator:

1. starts the browser headless, with a **new, empty profile**, on `http://127.0.0.1:<port>/bench/browser/index.html?<query>`;
2. waits for the page to post its result (or an error) to the local server;
3. kills the browser's whole process group and deletes the profile.

Before loading any module, the page tells the server that it has loaded. A browser that has not loaded the page within 30 s is killed and a fresh one is launched, up to 3 attempts. Nothing has been measured at that point. Each result records `process.launchAttempts`. This guards against a rare Chromium start-up stall, described in [limitations.md](limitations.md#browsers-and-workers). A page that loaded but then hangs is not relaunched: it fails its unit after `--timeout-s`. Every failure message includes the tail of the browser's stderr.

If the orchestrator itself is interrupted (SIGINT, SIGTERM, SIGHUP), it kills every browser it started and removes their profiles before exiting.

The page (`bench/browser/page.ts`) has no UI. It measures the selected cases, runs the correctness checks for the thread it measured, and posts raw samples and metadata as JSON.

The local server (`scripts/browser.ts`) serves `bench/` and `build/` and nothing else, on `127.0.0.1` only. It sends TypeScript as JavaScript after **type stripping** with Node's built-in `stripTypeScriptTypes` (strip mode). That only erases types: the code the browser runs is the repository's TypeScript with the types blanked out, unbundled and untransformed. Shared modules (`bench/common/harness.ts`, `ts-impl.ts`, `payloads.ts`, `checks.ts`, `wasm-abi.ts`) are imported by the browser exactly as the server runtimes import them.

Every response carries `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, so the page is **cross-origin isolated**. That is what gives `performance.now` its finest resolution (see [Timing](#timing)). SharedArrayBuffer becomes available too, but no path uses it.

Launch commands, as recorded in `environment.json → browsers.<name>.command`:

| Browser | Command |
| --- | --- |
| Chromium | `<chrome> --headless=new --user-data-dir=<fresh> --no-first-run --no-default-browser-check --disable-extensions --disable-background-networking --disable-component-update --disable-sync --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows <url>` |
| Firefox | `firefox --headless --no-remote --profile <fresh> <url>`, with a `user.js` (`browsers.firefox.prefs`) |

The settings keep start-up work away from the pinned CPUs and the page at full priority:

- **Chromium:** `--disable-background-networking`, `--disable-component-update` and `--disable-sync` stop start-up network, update and sync work. The three `--disable-background…` flags keep timers, message dispatch and the renderer at foreground priority.
- **Firefox:** the prefs turn off first-run pages, default-browser checks, telemetry upload, application and extension updates, Safe Browsing list updates and connectivity probes.

No JavaScript engine setting (`--js-flags`, `javascript.options.*`) is changed.

## Main-thread paths

| Case | What each timed call does |
| --- | --- |
| `noop/ts`, `add_i32/ts`, `sum_i32/ts/<n>` | the TypeScript reference |
| `noop/wasm.inlineable`, `add_i32/wasm.inlineable` | a direct WASM call, as the engine runs it by default |
| `sum_i32/wasm.copy/<n>` | copies the `Int32Array` into linear memory, then calls the Rust sum |
| `sum_i32/wasm.resident/<n>` | calls the Rust sum on input copied into linear memory once, outside timing |
| `sum_i32/wasm.simd128.copy/<n>`, `…resident/<n>` | the same, with the `simd128` build |

These are the server runtimes' cases ([wasm.md](wasm.md)), with the same `strategy`, `ownership` and `binding` fields. `bench/browser/main-cases.ts` holds copies of the loops in `bench/common/cases.ts`, which cannot be imported in a browser because it loads Node-API and FFI at start-up. `tests/browser.test.ts` checks that the main-thread case list is exactly the server list without the Node-API, FFI and `no-inline` paths, in the same canonical order.

Differences from the server runtimes:

- **No Node-API or FFI.** Browsers have neither.
- **No `wasm.no-inline`.** It needs an engine flag (see [Not covered](#not-covered)).
- **Loading.** The module is fetched and compiled with the asynchronous `WebAssembly.instantiate`, the standard browser path; the server runtimes compile synchronously from disk. Both happen before timing. The page hashes the bytes it fetched (SHA-256), and the orchestrator refuses to run if they differ from the artifacts it built and recorded.
- **"Inlineable" is each engine's default.** V8 inlines small JS→WASM calls. Whether SpiderMonkey does is not established; the path measures what each browser does without flags.

## Worker paths

A Worker path is a **messaging boundary**, not a WebAssembly boundary. `worker.wasm.*` crosses both: a message into the Worker, then a WASM call inside it. The paths are named and paired so that the two are never reported as one unexplained number.

```text
main thread                               dedicated Worker (module)
  post request ──────── postMessage ───────▶ onmessage
                                              TypeScript or WASM operation
  onmessage ◀────────── postMessage ──────── post reply
  post next request …
```

**One timed operation is one complete round trip.** The next request is posted from the handler of the previous reply, so a batch measures sequential request-reply latency, never pipelined throughput. The main thread times whole batches; the Worker never times anything.

| Case | Request carries | The Worker | Reply | `strategy` / `ownership` |
| --- | --- | --- | --- | --- |
| `noop/worker.ts`, `noop/worker.wasm` | `undefined` | calls `noop` | its result (`undefined`) | `clone` / `structured-clone` |
| `add_i32/worker.ts`, `add_i32/worker.wasm` | `[acc, i]`, structured-cloned | calls `add_i32` | the i32 result | `clone` / `structured-clone` |
| `sum_i32/worker.ts.clone/<n>` | the `Int32Array`; postMessage's serializer copies its buffer | sums the copy | the sum | `clone` / `structured-clone` |
| `sum_i32/worker.ts.copy/<n>` | `data.slice()`, then that copy is transferred | sums the copy | the sum | `copy` / `js-copy+transfer` |
| `sum_i32/worker.ts.transfer/<n>` | the caller's own buffer, transferred (zero-copy) | sums it, transfers it back | `{ sum, data }` | `transfer` / `transfer+transfer-back` |
| `sum_i32/worker.ts.resident/<n>` | `undefined`; the input already lives in the Worker | sums its own array | the sum | `resident` / `worker-resident` |
| `sum_i32/worker.wasm.clone/<n>` | as `worker.ts.clone` | copies it into linear memory, WASM sum | the sum | `clone` / `structured-clone+wasm-memory-copy` |
| `sum_i32/worker.wasm.copy/<n>` | as `worker.ts.copy` | same | the sum | `copy` / `js-copy+transfer+wasm-memory-copy` |
| `sum_i32/worker.wasm.transfer/<n>` | as `worker.ts.transfer` | same, transfers the buffer back | `{ sum, data }` | `transfer` / `transfer+wasm-memory-copy+transfer-back` |
| `sum_i32/worker.wasm.resident/<n>` | `undefined`; input copied into linear memory at setup | WASM sum | the sum | `resident` / `wasm-memory-resident` |

`impl` is the code that does the work inside the Worker (`ts` or `wasm`), and `binding` is what that code crosses (`none` or `WebAssembly`), as on the main thread. The messaging is described by `strategy`, `ownership`, and the result file's `worker` configuration. Worker paths use the default (non-SIMD) WASM build.

### The three ways of moving a buffer

- **Structured clone (`clone`).** The caller posts its array. The serializer copies the bytes; the caller keeps its array and the Worker gets an independent one. For a view, the whole underlying buffer is cloned. The benchmark arrays own exactly their buffer, so no extra bytes cross.
- **Explicit copy (`copy`).** The caller makes the copy itself (`slice`, visible application code) and transfers it. The caller keeps its array. The data is the same as with `clone`; what differs is who copies and how.
- **Ownership transfer (`transfer`).** The caller's `ArrayBuffer` moves to the Worker without copying and is **detached** on the caller's side: its length becomes 0 until the Worker transfers it back with the reply. A caller that wants its data back must wait for it, so the round trip includes both transfers. Transferring a view moves its whole buffer.

**WASM in a Worker still copies.** Linear memory cannot adopt a transferred `ArrayBuffer`, and a `WebAssembly.Memory` buffer cannot be transferred. So every `worker.wasm.*` path except `resident` copies the received array into linear memory, exactly as `wasm.copy` does on the main thread. The WASM input region is reserved once per case at setup, outside timing.

### Reading the Worker numbers

The orchestrator prints a **decomposition** per browser and size. It uses differences of medians from the Worker results only:

| Quantity | Estimated by |
| --- | --- |
| messaging round trip, no data, no work | `noop/worker.ts` |
| work inside the Worker | `worker.<impl>.resident − noop/worker.ts` |
| moving the input, per strategy | `worker.<impl>.<strategy> − worker.<impl>.resident` |

For `wasm`, "moving the input" also includes the copy into linear memory. The main-thread `wasm.copy − wasm.resident` estimates that part.

Differences of independent medians are approximate. At small sizes they are smaller than the run-to-run noise of a ~10 µs round trip and can come out negative. Compare Worker compute with main-thread compute with care: a handler in the Worker calls the operation once per message, while a main-thread loop calls it many times in one function, and JITs treat the two differently.

### Worker configuration

Recorded in every Worker result file (`worker`) and in `environment.json → methodology.worker`:

| Setting | Value |
| --- | --- |
| type | module Worker (`new Worker(url, { type: "module" })`), `bench/browser/worker.ts` |
| instances | one dedicated Worker per page, created before any case and shared by that page's Worker cases |
| messaging | `Worker.postMessage` / `DedicatedWorkerGlobalScope.postMessage`, one reply per request, sequential |
| control | a `MessageChannel` created by the Worker, used only to set up cases, outside timing |
| handlers | setting up a case installs that case's own `onmessage` handler, so each handler sees one message shape |
| WASM | default build, fetched and instantiated inside the Worker; its hash is checked like the page's |
| shared memory | none (no `SharedArrayBuffer`, no `Atomics`) |

## Timing

Pages time batches with `performance.now()` on the main thread. For Worker cases, `bench/browser/measure-async.ts` repeats the harness protocol (calibrate, warmup, samples, the same statistics) for batches that complete asynchronously. `harness.ts` itself stays synchronous because scriptc compiles it. A Worker batch is timed from posting the first request to the resolution of the batch after the last reply; that resolution adds one microtask to a batch of about 20 ms.

Browsers coarsen `performance.now()`. Each page measures the step it actually observes and records it (`timer.minNs`, `timer.medianNs`). On the reference machine, cross-origin isolated pages observed:

- 5 µs steps in Chromium 153;
- 20 µs steps in Firefox 156.

Against a 20 ms batch, that is at most 0.1%. The orchestrator warns when a page is not cross-origin isolated, or when the step exceeds 0.1% of a batch (for example with `--sample-ms` below 20 in Firefox).

## Isolation, order and pinning

The schedule is the server one ([methodology.md](methodology.md#process-isolation-and-order)), per browser and thread instead of per runtime:

- `--isolation case`: a **fresh browser and profile per case**. No case inherits JIT, inline-cache or GC state from another case, from the other thread's cases, or from an earlier page.
- `--isolation runtime`: **one page per browser and thread**, running every selected case of that thread in canonical order. Its Worker is shared by those cases too.
- `--isolation both`, `--runs`, `--order shuffle` and `--seed` work as for the server runtimes. Results record `run`, `isolation` and `sequence`.

A page only ever measures one thread's cases, so main-thread and Worker results never come from the same page.

**Pinning.** `--cpus` starts the browser under `taskset -c LIST`. The mask covers the whole browser: its main process, renderers, GPU and network processes, JIT and GC threads, and the Worker's thread. Before killing a pinned browser, the orchestrator reads the affinity of every live process in the browser's process group, and aborts if any differs from the requested set. A browser runs many processes, so give it at least three CPUs of one class: one for the page's main thread, one for the Worker, and one for everything else.

## Correctness

After measurement, each page checks the thread it measured:

- **Main thread:** the server runtimes' boundary check (`checkBoundary` in `bench/common/checks.ts`), for both WASM builds, with the same copy into linear memory as the `copy` paths.
- **Worker:** the same inputs (noop, i32 overflow, every `sum_i32` size plus 0, an offset view) go through every Worker path. They use the same messages as the benchmark batches, and each reply is compared with the TypeScript reference. The check also verifies the ownership each strategy claims:
  - a transferred buffer is detached on the caller's side while the Worker owns it, and comes back with the same length, offset and contents;
  - a cloned or copied array never leaves the caller;
  - a copied array's copy is the one that is detached.

  Resident cases are checked at every size.

A mismatch posts an error, which fails the unit; failed units are recorded in `environment.json → failedUnits`, and their results are discarded.

`?mode=check` runs every case's batch against the TypeScript case of the same operation and size, then both threads' checks, without timing. `tests/browser.test.ts` uses it in each browser. It was checked by making the Worker's TypeScript sum wrong by one at 1,000 elements: the test failed with `sum_i32/worker.ts.clone/1000 batch of 3: got 1925618007, expected 1925618004`.

## Recorded metadata

`results/raw/<run-id>/environment.json` has `kind: "browser"`, and adds to the server fields:

- `browsers.<name>`:
  - `path` and `version` (`--version` of the binary)
  - `engine`: name and version. V8's version comes from the DevTools `/json/version` endpoint of a separate, short launch, never a benchmark launch. SpiderMonkey is versioned with Firefox.
  - the launch `command`, and the Firefox `prefs`
  - `page`: what the page itself reported:
    - `userAgent`, and User-Agent Client Hints (`architecture`, `platform`, `fullVersionList`, …; Chromium only)
    - `hardwareConcurrency`, `crossOriginIsolated` and the observed timer steps
    - for each WASM artifact the page fetched: its size, SHA-256, or why it did not load
  - `workerWasm`: the same for the artifact the Worker fetched
- `server`: Node.js version, response headers, and how TypeScript is served
- `wasm`: the build commands, `RUSTFLAGS` and artifact hashes, as for the server runtimes, plus `targetFeatures` per build, read from each module's `target_features` custom section
- `methodology`: `threads`, `worker` (configuration above), the timing method, `isolationMeaning`, and `casesByRuntime` keyed `<browser>.<thread>`

Hardware, OS, CPU topology, power settings, load averages, git commit and condition warnings are recorded as for server runs.

Results go to `<browser>.main.json` and `<browser>.worker.json`. They have the same result schema as the server runtimes' files, plus the browser, the thread, the observed timer, `crossOriginIsolated` and the Worker configuration. Each result's `process` records the browser's pid, command (with the per-unit token removed), the affinity of every process in its group when pinned, and start and end times. `environment.json → runtimes` has one entry per file (`chromium.main`, `chromium.worker`, …), so `scripts/compare.ts` reads browser runs like server runs.

Browser runs live in their own run directories, and server runs are unchanged by them.

## Not covered

These were split or deferred rather than forced into equivalence:

- **`wasm.no-inline`.** Disabling JS→WASM inlining needs engine flags: `--js-flags=--no-turbo-inline-js-wasm-calls` in Chromium, and no known equivalent in Firefox. The page cannot see whether a flag took effect, and the path would describe a browser nobody runs. Deferred.
- **WebKit / Safari.** No headless WebKit launcher is set up; WebKitGTK's MiniBrowser has no headless mode.
- **Payload and return suites.** Deferred for the same reasons as in [wasm.md](wasm.md#not-covered), and a Worker adds a second transfer to name in each direction.
- **`SharedArrayBuffer` and `Atomics`.** The obvious zero-copy alternative to messaging. Pages are cross-origin isolated, so it is possible, but it is a different synchronisation model and a separate set of paths.
- **Pipelined or batched messaging.** Only sequential round-trip latency is measured, not how many messages per second a Worker can absorb with several in flight.
- **Start-up.** Browser launch, page load, Worker start and WASM compilation are outside timing.
