// The dedicated Worker behind the `worker.*` paths (see worker-cases.ts for
// the main-thread side and docs/browser.md for the semantics).
//
// Start-up: load the default WASM build, then post a control port and the
// artifact status. Control messages (setup, outside timing) use that port;
// benchmark requests and replies use only the Worker's own postMessage.
// Setting up a case installs that case's own `onmessage` handler, so each
// handler sees one message shape, as each benchmark loop owns one call site.
//
// Every request is answered with exactly one reply. The Worker never times
// anything: the main thread times whole batches of round trips.

import { makeI32Data } from "../common/payloads.ts";
import * as ts from "../common/ts-impl.ts";
import { loadWasm } from "./wasm.ts";

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const { binding: wasm, status } = await loadWasm("default");

const tsNoop = ts.noop;
const tsAdd = ts.add_i32;
const tsSum = ts.sum_i32;
const wasmNoop = wasm?.noop;
const wasmAdd = wasm?.add_i32;
const wasmSum = wasm?.sum_i32;

/** Case ids are `op/worker.<impl>[.<strategy>][/size]`; see worker-cases.ts. */
function handlerFor(id: string): (event: MessageEvent) => void {
  const [op, path, sizeText] = id.split("/");
  const [, impl, strategy] = path.split(".");
  if (impl === "wasm" && !wasm) throw new Error(`${id}: the WASM build is unavailable in this Worker`);
  if (op === "noop") return impl === "ts" ? () => scope.postMessage(tsNoop()) : () => scope.postMessage(wasmNoop!());
  if (op === "add_i32") {
    return impl === "ts"
      ? (event) => scope.postMessage(tsAdd(event.data[0], event.data[1]))
      : (event) => scope.postMessage(wasmAdd!(event.data[0], event.data[1]));
  }
  if (op !== "sum_i32") throw new Error(`${id}: unknown operation`);
  const size = Number(sizeText);

  if (impl === "ts") {
    if (strategy === "resident") {
      const data = makeI32Data(size);
      return () => scope.postMessage(tsSum(data));
    }
    // The received array is this Worker's own: a structured clone, a copy
    // transferred to it, or (transfer) the caller's buffer, which goes back.
    if (strategy === "transfer") {
      return (event) => {
        const data: Int32Array<ArrayBuffer> = event.data;
        scope.postMessage({ sum: tsSum(data), data }, [data.buffer]);
      };
    }
    return (event) => scope.postMessage(tsSum(event.data));
  }

  // WASM: linear memory is reserved here, outside timing, and cannot receive
  // a transferred buffer, so received input is copied into it on every
  // request (as `wasm.copy` does on the main thread). No allocation happens
  // while a case runs, so the view stays valid.
  const pointer = wasm!.alloc_i32(size);
  const target = new Int32Array(wasm!.memory.buffer, pointer, size);
  if (strategy === "resident") {
    target.set(makeI32Data(size));
    return () => scope.postMessage(wasmSum!(pointer, size));
  }
  if (strategy === "transfer") {
    return (event) => {
      const data: Int32Array<ArrayBuffer> = event.data;
      target.set(data);
      scope.postMessage({ sum: wasmSum!(pointer, data.length), data }, [data.buffer]);
    };
  }
  return (event) => {
    const data: Int32Array<ArrayBuffer> = event.data;
    target.set(data);
    scope.postMessage(wasmSum!(pointer, data.length));
  };
}

const control = new MessageChannel();
control.port1.onmessage = (event) => {
  const id: string = event.data.setup;
  try {
    scope.onmessage = handlerFor(id);
    control.port1.postMessage({ ready: id });
  } catch (error) {
    control.port1.postMessage({ error: String(error) });
  }
};
scope.postMessage({ control: control.port2, wasm: status }, [control.port2]);
