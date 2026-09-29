# Benchmarks

What isotsbench measures: the suites, operations, sizes, payloads and paths, how cases are named, and how to read the numbers. How the measurements are taken is in [methodology.md](methodology.md); how data crosses each boundary is in [marshalling.md](marshalling.md).

## Suites, operations and paths

All current suites are microbenchmarks. They isolate the boundary, so they avoid databases, filesystem and network access, sleeps and external dependencies. Every native operation has an equivalent TypeScript implementation where that is meaningful. Results report both absolute latency and cost relative to the runtime's own TypeScript baseline.

Operations are grouped into **suites**. A suite can be run on its own, including in official runs, with `--suite` or `make … SUITE=…`. Selecting a suite changes which cases run, not how they are measured.

| Suite | Operation | Data | Sizes |
| --- | --- | --- | --- |
| `boundary` | `noop()` | none | n/a |
| | `add_i32(a, b)` | two i32 in, i32 out | n/a |
| | `sum_i32(data)` | `Int32Array` in | 1, 10, 100, 1k, 10k, 100k, 1M elements |
| `payload` | `string_len(value)` | string in; variants `ascii`, `utf8` | 16 B, 64 B, 1 KiB, 64 KiB, 1 MiB, 16 MiB of UTF-8 |
| | `bytes_len(data)` | `Uint8Array` in | same byte sizes |
| | `checksum_bytes(data)` | `Uint8Array` in | same byte sizes |
| `return` | `return_f64()` | `f64` out | n/a |
| | `return_string(bytes)` | string out; variants `ascii`, `utf8` | 16 B, 64 B, 1 KiB, 64 KiB of UTF-8 |
| | `return_bytes(bytes)` | new `Uint8Array` out | 16 B … 16 MiB, as above |
| | `return_rows(count)` | array of `{ id, score, active, name }` out | 1, 10, 100, 1k, 10k rows |

The **boundary** operations isolate the call itself:

- `noop` is the minimum cost of a round trip, TS → native → TS, with no work and no data. It is the lower bound for each binding.
- `add_i32` adds scalar argument and return conversion.
- `sum_i32` does work proportional to its input, so its sizes show where native execution starts to pay for the boundary (the **break-even** point).

The **payload** operations measure ingress: getting data from JS into native code. Every result is a number.

- `string_len` returns the UTF-8 byte length of a JS string.
- `bytes_len` returns a buffer's length, without reading its bytes.
- `checksum_bytes` returns the 32-bit FNV-1a hash of the bytes. FNV-1a is a serial pass over every byte, which the compiler cannot vectorise.

The **return** operations measure egress: getting native-produced data into JS. Each call returns a new result, as a real API would. [Return path](marshalling.md#return-path-native--js) describes the strategies.

Every operation runs through each path its runtime supports:

| Path (`impl`) | Node.js | Bun | Deno | scriptc | `binding` recorded |
| --- | --- | --- | --- | --- | --- |
| `ts`: TypeScript (JIT-compiled; ahead-of-time compiled under scriptc) | yes | yes | yes | yes | `none` |
| `napi`: Node-API → Rust | yes | yes | yes | no | `node-api` |
| `ffi`: FFI → C ABI → Rust | no | yes | yes | partial | `bun:ffi` / `Deno.dlopen` / `scriptc-ffi` |

- Node.js has no stable FFI, so it has no `ffi` path.
- scriptc has no JavaScript engine, so it has no Node-API path.
- scriptc's FFI covers only part of the matrix; see [scriptc](scriptc.md).

All calls are synchronous. There are no WASM, browser, async or SQLite paths yet.

Case ids are `op/path[/variant][/size]`, for example:

- `sum_i32/ffi/1000`
- `string_len/napi/utf8/65536`
- `return_rows/napi.objects/100`

The path is the `impl` (`ts`, `napi` or `ffi`), extended by a strategy name in two situations:

- one binding measures several representations (`napi.objects`, `napi.packed`, `ffi.packed`);
- a runtime's semantics differ from the other runtimes' path of the same name (`ffi.borrowed`, scriptc's string ingress).

Each result also records:

- `suite`
- `binding`: the mechanism that crossed into native code
- `size`: elements for `sum_i32`, rows for `return_rows`, payload bytes otherwise
- `variant`: `ascii` or `utf8` for string operations, null otherwise
- `payload`: `{ kind, bytes }`, or `{ kind: "rows", count }` for rows. `kind` is one of `int32array`, `uint8array`, `string-ascii`, `string-utf8` or `rows`. Null for scalar cases.
- `strategy`: `objects` or `packed` for rows, `borrowed` for scriptc's string ingress, null otherwise
- `ownership`: who allocates, fills, copies or borrows the data, for return cases and for scriptc's FFI cases (see [marshalling.md](marshalling.md) and [scriptc.md](scriptc.md)). Null otherwise.

Result files written by older versions lack the fields that did not exist yet; `scripts/compare.ts` still reads them:

- before v0.3.0: no `binding` (their paths were `ts` and `napi`);
- before v0.4.0: no `variant`, `payload`, `suite`, `strategy` or `ownership`. Tools derive `suite` from `op`.

## Payloads

`bench/common/payloads.ts` defines every size and generates the payloads deterministically, so they are byte-identical in every runtime (including scriptc). Each payload is generated once per process and shared by every case that uses it (read-only). Sizes are exact.

| Kind | Content | Size |
| --- | --- | --- |
| `string-ascii` | printable ASCII (0x20–0x7e); one byte per UTF-16 code unit | UTF-8 bytes |
| `string-utf8` | code points of 1, 2, 3 or 4 UTF-8 bytes, uniformly mixed: ASCII, Latin-1 Supplement, CJK, emoji (surrogate pairs in UTF-16) | UTF-8 bytes |
| `uint8array` | pseudo-random bytes | `byteLength` |

Strings are built by joining chunks with `Array.prototype.join`, so they are flat. No case pays for flattening a rope (V8 cons string). The correctness check confirms that each string's `TextEncoder` length equals its nominal size.

## Reading the results

- Under the JIT runtimes, `noop/ts` and `add_i32/ts` get inlined and reduce to an empty loop (about one cycle per iteration). The `napi/ts` ratio for these rows therefore compares the boundary against almost nothing. The meaningful number is the absolute native ns/op, which is the boundary cost.
- `sum_i32` compares realistic implementations, not just the boundary. The Rust loop is auto-vectorised and the JS loop is not. Both use wrapping i32 addition.
- **Break-even** is the smallest measured size from which native is faster than TS at that size *and every larger measured size*. The sizes are decades (payload sizes step by up to 64×), so the true crossover lies somewhere between the reported size and the one below it. The summary prints a break-even table for every sized operation. `never` means native never became and stayed faster within the measured sizes.
- **Data rate** is payload bytes ÷ median time per call, shown for every case whose operation reads its payload. `bytes_len` never reads its bytes, and its time does not depend on the size. It measures only the hand-over, so its data rate is shown as `-`.
- **`bytes_len`** has a trivial TS baseline (`data.byteLength`, inlined to almost nothing). Like `noop`, the meaningful number is the absolute native cost of handing over a buffer, and whether it stays constant across sizes.
- **`string_len`** compares string ingress on the native paths with a JS-side byte count (see [How data crosses each boundary](marshalling.md#how-data-crosses-each-boundary)). The `ascii` and `utf8` variants are reported separately, because engines store and convert one-byte and two-byte strings differently.
