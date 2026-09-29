# Marshalling and ownership

How data crosses each boundary, in both directions, on the Node-API and Bun/Deno FFI paths: what is copied, borrowed, converted or allocated, who owns results, and the native libraries behind them. scriptc's FFI is described in [scriptc.md](scriptc.md); the separate WASM linear-memory transfer is described in [wasm.md](wasm.md).

## How data crosses each boundary

What each path does with the payload on every call:

| Operation | `ts` | `napi` (Node, Bun, Deno) | `ffi` (Bun, Deno) |
| --- | --- | --- | --- |
| `sum_i32`, `bytes_len`, `checksum_bytes` | reads the typed array in JS | **borrows** the backing store (`napi_get_typedarray_info`); no copy | **borrows**: the runtime passes a pointer to the view (`ptr` / `buffer`) plus the length as `uint32_t`; no copy |
| `string_len` | scans UTF-16 code units in JS and counts UTF-8 bytes; **no copy, no allocation** | **converts and copies**: `napi_get_value_string_utf8` is called once for the length and once to transcode the string into UTF-8 in the addon's reused buffer. The addon allocates nothing per call; the buffer only grows. | **converts and copies in JS**: `TextEncoder.encodeInto` transcodes into a reused `Uint8Array`, then pointer and byte length are **borrowed** by the call. Per the spec, `encodeInto` returns a new `{ read, written }` object each call. |

How much of this is established:

- **Borrowing.** Established by measurement. `bytes_len` takes the same time at 16 B and at 16 MiB on all five `napi` and `ffi` paths (max/min 1.03–1.19 across the six sizes), where a copy would scale with size. See [findings](findings.md#buffers-are-borrowed).
- **String conversion.**
  - Node-API: established by construction. `napi_get_value_string_utf8` writes into caller memory.
  - FFI: established by construction. `encodeInto` writes into the caller's buffer.
  - Not established: whether an engine allocates internally during either conversion, or elides the `encodeInto` result object.
- **Encoding.** Identical everywhere: WHATWG UTF-8, with every lone surrogate becoming U+FFFD (3 bytes). This was checked with empty, ASCII, Latin-1, BMP, astral, lone and trailing surrogates, sliced, concatenated and NUL-containing strings. Node-API in Node, Bun and Deno and `TextEncoder` returned identical byte lengths.

So all native `string_len` paths produce the same UTF-8 bytes in memory the native side can read. They differ only in *where* the transcoding copy happens:

- `napi`: inside the engine during the call
- `ffi`: in JS just before the call, because a C function cannot receive a JS string

The name `string_len` therefore means the same thing on every path: "get this string's UTF-8 bytes to native code". The `ts` baseline computes the same answer without materialising the bytes. The native/TS ratio shows what string ingress costs compared with doing the work in JS.

WASM currently has no payload path. For `sum_i32/wasm.copy`, `Int32Array.set` copies the JS input into WASM linear memory on every timed call. Node-API and FFI instead borrow the JS backing store. `sum_i32/wasm.resident` measures the same sum on input already in linear memory, so the transfer can be separated from execution; see [wasm.md](wasm.md).

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

| C type | Bun type | Deno type |
| --- | --- | --- |
| `int32_t` parameter | `i32` | `i32` |
| `uint32_t` parameter (lengths) | `u32` | `u32` |
| `const int32_t *`, `const uint8_t *`, `uint8_t *` parameter | `ptr` (a typed array) | `buffer` (a typed array) |
| return `int32_t` / `uint32_t` / `double` / `void` | `i32` / `u32` / `f64` / `void` | `i32` / `u32` / `f64` / `void` |

scriptc links the same functions from a static archive. It passes span lengths as `size_t`, which thin adapters convert (see [scriptc.md](scriptc.md)).

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

In a full run with a `size_t` length passed as a number, Deno's `sum_i32/ffi/1` measured 73 ns, against 2.5 ns for `noop/ffi`. That gap was the conversion cost.
