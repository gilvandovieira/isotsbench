// Worker paths, main-thread side: main → postMessage → dedicated Worker →
// TypeScript or WASM → postMessage → main. One timed operation is one round
// trip: the next request is posted from the handler of the previous reply,
// so the batch measures sequential request-reply latency, never pipelined
// throughput.
//
// A Worker round trip is a messaging boundary, not a WebAssembly boundary:
// the `worker.wasm.*` paths cross both, and are paired with `worker.ts.*`
// and with the resident paths so that each cost can be isolated:
//
// - `clone`: postMessage structured-clones the Int32Array; the serializer
//   copies its buffer. The caller keeps its array.
// - `copy`: the caller copies the array (`slice`) and transfers the copy.
//   The caller keeps its array; the copy is visible application code.
// - `transfer`: the caller's buffer is transferred (zero-copy); the caller
//   cannot use it until the Worker transfers it back with the reply.
// - `resident`: the input already lives in the Worker (a JS array, or WASM
//   linear memory); requests carry no data. Messaging plus compute only.
//
// Scalar operations post `undefined` (noop) or a two-element array (add_i32),
// which is structured-cloned. See docs/browser.md.

import type { Case } from "../common/case.ts";
import { ADD_I32_CHECK_PAIRS, expectNumber, expectTrue, fail, sumI32CheckInputs } from "../common/checks.ts";
import { makeI32Data, SUM_I32_SIZES } from "../common/payloads.ts";
import * as ts from "../common/ts-impl.ts";
import type { WasmArtifactStatus } from "./wasm.ts";

/** A case whose batch completes asynchronously (Worker round trips). */
export interface AsyncCase extends Omit<Case, "run"> {
  run(iterations: number): Promise<number>;
}

export type WorkerImpl = "ts" | "wasm";
export type WorkerStrategy = "clone" | "copy" | "transfer" | "resident";

const IMPLS: readonly WorkerImpl[] = ["ts", "wasm"];
const STRATEGIES: readonly WorkerStrategy[] = ["clone", "copy", "transfer", "resident"];

/** What each case records as `ownership`: who copies or moves the input, and where. */
const OWNERSHIP: Record<WorkerImpl, Record<WorkerStrategy, string>> = {
  ts: {
    clone: "structured-clone",
    copy: "js-copy+transfer",
    transfer: "transfer+transfer-back",
    resident: "worker-resident",
  },
  wasm: {
    clone: "structured-clone+wasm-memory-copy",
    copy: "js-copy+transfer+wasm-memory-copy",
    transfer: "transfer+wasm-memory-copy+transfer-back",
    resident: "wasm-memory-resident",
  },
};

/** How the Worker is created and driven; recorded with every Worker result. */
export const WORKER_CONFIG = {
  type: "module",
  script: "bench/browser/worker.ts",
  instances: "one dedicated Worker per page, created before any case and shared by that page's Worker cases",
  messaging: "Worker.postMessage / DedicatedWorkerGlobalScope.postMessage, one reply per request, sequential",
  control: "a MessageChannel created by the Worker, used only to set up cases outside timing",
  wasm: "default build, fetched and instantiated inside the Worker",
  sharedMemory: "none (no SharedArrayBuffer or Atomics)",
} as const;

export interface BenchWorker {
  worker: Worker;
  control: MessagePort;
  wasm: WasmArtifactStatus;
}

/** Starts the Worker and waits until it has loaded WASM and handed over its control port. */
export function startWorker(onError: (message: string) => void): Promise<BenchWorker> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "isotsbench" });
  worker.onerror = (event) => onError(`Worker error: ${event.message}`);
  worker.onmessageerror = () => onError("Worker reply could not be deserialized");
  return new Promise((resolve) => {
    worker.onmessage = (event) => resolve({ worker, control: event.data.control, wasm: event.data.wasm });
  });
}

/** Installs the case's handler in the Worker (outside timing). */
function setup(w: BenchWorker, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    w.control.onmessage = (event) => {
      if (event.data.ready === id) resolve();
      else reject(new Error(`Worker setup of ${id} failed: ${event.data.error}`));
    };
    w.control.postMessage({ setup: id });
  });
}

// ---- Batches: one closure per batch, one message shape per case ----------

function noopBatch(worker: Worker, iterations: number): Promise<number> {
  return new Promise((resolve) => {
    let left = iterations;
    worker.onmessage = () => {
      if (--left > 0) worker.postMessage(undefined);
      else resolve(iterations);
    };
    worker.postMessage(undefined);
  });
}

// acc = add_i32(acc, i) for i = 0 … iterations − 1, as the synchronous loop.
function addBatch(worker: Worker, iterations: number): Promise<number> {
  return new Promise((resolve) => {
    let i = 0;
    worker.onmessage = (event) => {
      const acc: number = event.data;
      if (++i < iterations) worker.postMessage([acc, i]);
      else resolve(acc);
    };
    worker.postMessage([0, 0]);
  });
}

function sumCloneBatch(worker: Worker, iterations: number, data: Int32Array<ArrayBuffer>): Promise<number> {
  return new Promise((resolve) => {
    let left = iterations;
    let acc = 0;
    worker.onmessage = (event) => {
      acc = (acc + event.data) | 0;
      if (--left > 0) worker.postMessage(data);
      else resolve(acc);
    };
    worker.postMessage(data);
  });
}

function sumCopyBatch(worker: Worker, iterations: number, data: Int32Array<ArrayBuffer>): Promise<number> {
  return new Promise((resolve) => {
    let left = iterations;
    let acc = 0;
    worker.onmessage = (event) => {
      acc = (acc + event.data) | 0;
      if (--left > 0) {
        const copy = data.slice();
        worker.postMessage(copy, [copy.buffer]);
      } else resolve(acc);
    };
    const copy = data.slice();
    worker.postMessage(copy, [copy.buffer]);
  });
}

/** The input moves to the Worker and back; `holder.data` is the caller's array between round trips. */
function sumTransferBatch(worker: Worker, iterations: number, holder: { data: Int32Array<ArrayBuffer> }): Promise<number> {
  return new Promise((resolve) => {
    let left = iterations;
    let acc = 0;
    worker.onmessage = (event) => {
      holder.data = event.data.data;
      acc = (acc + event.data.sum) | 0;
      if (--left > 0) worker.postMessage(holder.data, [holder.data.buffer]);
      else resolve(acc);
    };
    worker.postMessage(holder.data, [holder.data.buffer]);
  });
}

function sumResidentBatch(worker: Worker, iterations: number): Promise<number> {
  return new Promise((resolve) => {
    let left = iterations;
    let acc = 0;
    worker.onmessage = (event) => {
      acc = (acc + event.data) | 0;
      if (--left > 0) worker.postMessage(undefined);
      else resolve(acc);
    };
    worker.postMessage(undefined);
  });
}

// ---- Cases ----------------------------------------------------------------

const workerBinding = (impl: WorkerImpl) => (impl === "wasm" ? "WebAssembly" : "none");

function scalarCase(w: BenchWorker, op: "noop" | "add_i32", impl: WorkerImpl): AsyncCase {
  return {
    id: `${op}/worker.${impl}`,
    op,
    impl,
    binding: workerBinding(impl),
    size: null,
    strategy: "clone",
    ownership: "structured-clone",
    run: op === "noop"
      ? (iterations) => noopBatch(w.worker, iterations)
      : (iterations) => addBatch(w.worker, iterations),
  };
}

function sumCase(w: BenchWorker, impl: WorkerImpl, strategy: WorkerStrategy, size: number): AsyncCase {
  // Resident input is created inside the Worker at setup; the others here.
  const data = strategy === "resident" ? new Int32Array(0) : makeI32Data(size);
  const holder = { data };
  const runs: Record<WorkerStrategy, (iterations: number) => Promise<number>> = {
    clone: (iterations) => sumCloneBatch(w.worker, iterations, data),
    copy: (iterations) => sumCopyBatch(w.worker, iterations, data),
    transfer: (iterations) => sumTransferBatch(w.worker, iterations, holder),
    resident: (iterations) => sumResidentBatch(w.worker, iterations),
  };
  return {
    id: `sum_i32/worker.${impl}.${strategy}/${size}`,
    op: "sum_i32",
    impl,
    binding: workerBinding(impl),
    size,
    payload: { kind: "int32array", bytes: size * 4 },
    strategy,
    ownership: OWNERSHIP[impl][strategy],
    run: runs[strategy],
  };
}

/** Every Worker case id, in canonical order: operation, size, then impl and strategy. */
export function workerCaseIds(wasmAvailable: boolean): string[] {
  const impls = IMPLS.filter((impl) => impl === "ts" || wasmAvailable);
  return [
    ...impls.map((impl) => `noop/worker.${impl}`),
    ...impls.map((impl) => `add_i32/worker.${impl}`),
    ...SUM_I32_SIZES.flatMap((size) =>
      impls.flatMap((impl) => STRATEGIES.map((strategy) => `sum_i32/worker.${impl}.${strategy}/${size}`))
    ),
  ];
}

/**
 * Builds the selected Worker cases in canonical order. Each case's `prepare`
 * installs its handler in the Worker; the caller runs it before measuring.
 */
export function buildWorkerCases(w: BenchWorker, ids: string[]): (AsyncCase & { prepare(): Promise<void> })[] {
  return ids.map((id) => {
    const [op, path, size] = id.split("/");
    const [, impl, strategy] = path.split(".") as [string, WorkerImpl, WorkerStrategy | undefined];
    const c = op === "sum_i32" ? sumCase(w, impl, strategy!, Number(size)) : scalarCase(w, op as "noop" | "add_i32", impl);
    if (c.id !== id) throw new Error(`unknown Worker case ${id}`);
    return { ...c, prepare: () => setup(w, id) };
  });
}

// ---- Correctness, after measurement ----------------------------------------

/** One request-reply through the Worker's current handler. */
function roundTrip(worker: Worker, message: unknown, transfer: Transferable[] = []): Promise<unknown> {
  return new Promise((resolve) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.postMessage(message, transfer);
  });
}

/**
 * Sends the shared boundary check inputs (checks.ts) through every Worker
 * path, with the same messages as the benchmark batches, and compares each
 * reply with the TypeScript reference. Also checks the ownership each
 * strategy claims: a transferred buffer is detached from the caller until it
 * comes back unchanged; a cloned or copied one never leaves the caller.
 */
export async function checkWorkerEquivalence(w: BenchWorker, wasmAvailable: boolean): Promise<void> {
  const largest = SUM_I32_SIZES[SUM_I32_SIZES.length - 1];
  for (const impl of IMPLS.filter((impl) => impl === "ts" || wasmAvailable)) {
    const name = `worker.${impl}`;
    await setup(w, `noop/${name}`);
    expectTrue(`${name} noop returns undefined`, (await roundTrip(w.worker, undefined)) === undefined);

    await setup(w, `add_i32/${name}`);
    for (let i = 0; i < ADD_I32_CHECK_PAIRS.length; i += 2) {
      const a = ADD_I32_CHECK_PAIRS[i];
      const b = ADD_I32_CHECK_PAIRS[i + 1];
      expectNumber(`${name} add_i32(${a}, ${b})`, (await roundTrip(w.worker, [a, b])) as number, ts.add_i32(a, b));
    }

    // Handlers size their WASM input region at setup; the largest covers every input.
    for (const strategy of ["clone", "copy", "transfer"] as const) {
      await setup(w, `sum_i32/${name}.${strategy}/${largest}`);
      for (const input of sumI32CheckInputs()) {
        const label = `${name}.${strategy} sum_i32 ${input.label}`;
        const data = input.data;
        const expected = ts.sum_i32(data);
        const length = data.length;
        let reply: unknown;
        if (strategy === "clone") {
          const pending = roundTrip(w.worker, data);
          expectNumber(`${label}: caller keeps its array`, data.length, length);
          reply = await pending;
        } else if (strategy === "copy") {
          const copy = data.slice();
          const pending = roundTrip(w.worker, copy, [copy.buffer]);
          expectTrue(`${label}: the copy was transferred`, copy.buffer.byteLength === 0);
          expectNumber(`${label}: caller keeps its array`, data.length, length);
          reply = await pending;
        } else {
          const original = data.slice();
          const offset = data.byteOffset;
          const pending = roundTrip(w.worker, data, [data.buffer]);
          expectTrue(`${label}: the caller's buffer is detached while the Worker owns it`, data.buffer.byteLength === 0);
          const back = (await pending) as { sum: number; data: Int32Array };
          expectTrue(`${label}: the view comes back`, back.data instanceof Int32Array);
          expectNumber(`${label}: returned length`, back.data.length, length);
          expectNumber(`${label}: returned offset`, back.data.byteOffset, offset);
          for (let i = 0; i < length; i++) {
            if (back.data[i] !== original[i]) fail(`${label}: returned element ${i}`, `${back.data[i]}`, `${original[i]}`);
          }
          reply = back.sum;
        }
        expectNumber(label, reply as number, expected);
      }
    }

    for (const size of [0, ...SUM_I32_SIZES]) {
      await setup(w, `sum_i32/${name}.resident/${size}`);
      expectNumber(`${name}.resident sum_i32 size ${size}`, (await roundTrip(w.worker, undefined)) as number, ts.sum_i32(makeI32Data(size)));
    }
  }
}
