// Browser entry point, driven by scripts/bench-browser.ts through the query
// string. It has no UI: it runs, then posts JSON to the local server.
//
//   ?mode=list                               case ids of both threads, and page metadata
//   ?mode=bench&thread=main|worker&case=ID   one case (fresh page per case)
//   ?mode=bench&thread=main|worker[&filter=TEXT]   every selected case, in canonical order
//   ?mode=check                              correctness of every path, no timing (tests)
//   plus &warmup=N&samples=N&sample-ms=N&token=T
//
// A page measures one thread's cases only: main-thread and Worker results
// never come from the same page.

import type { CaseResult, Options } from "../common/harness.ts";
import { measure } from "../common/harness.ts";
import { expectNumber } from "../common/checks.ts";
import { caseGroup } from "../common/format.ts";
import { performanceClock } from "../scriptc/clock.ts";
import { buildMainCases, checkMainEquivalence, wasmArtifacts } from "./main-cases.ts";
import { measureAsync } from "./measure-async.ts";
import { buildWorkerCases, checkWorkerEquivalence, startWorker, WORKER_CONFIG, workerCaseIds } from "./worker-cases.ts";

type Thread = "main" | "worker";

const params = new URL(location.href).searchParams;
const token = params.get("token") ?? "";
const wasmAvailable = wasmArtifacts[0].error === null;

function post(kind: "result" | "error", body: unknown): Promise<Response> {
  return fetch(`/api/${kind}?token=${encodeURIComponent(token)}`, { method: "POST", body: JSON.stringify(body) });
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  post("error", { message });
}

addEventListener("error", (event) => reportError((event as ErrorEvent).error ?? (event as ErrorEvent).message));
addEventListener("unhandledrejection", (event) => reportError((event as PromiseRejectionEvent).reason));

function positiveInt(name: string, fallback: number): number {
  const value = params.get(name);
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return n;
}

/** Smallest and median step of performance.now over 1,000 observed changes, in ns. */
function timerSteps(): { minNs: number; medianNs: number } {
  const steps: number[] = [];
  let last = performance.now();
  while (steps.length < 1000) {
    const now = performance.now();
    if (now !== last) {
      steps.push(now - last);
      last = now;
    }
  }
  steps.sort((a, b) => a - b);
  return { minNs: Math.round(steps[0] * 1e6), medianNs: Math.round(steps[500] * 1e6) };
}

interface UserAgentData {
  getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>;
}

/** What the page itself can report about the browser; the orchestrator adds the rest. */
async function pageInfo() {
  const uaData = (navigator as unknown as { userAgentData?: UserAgentData }).userAgentData;
  return {
    userAgent: navigator.userAgent,
    // Chromium only; other engines do not implement User-Agent Client Hints.
    userAgentData: uaData
      ? await uaData.getHighEntropyValues(["architecture", "bitness", "fullVersionList", "platform", "platformVersion"])
      : null,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: (globalThis as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated,
    timer: { name: performanceClock.name, ...timerSteps() },
    wasm: wasmArtifacts,
  };
}

function selector(): (id: string) => boolean {
  const only = params.get("case");
  const filter = params.get("filter");
  return (id) => (only ? id === only : !filter || id.includes(filter));
}

async function bench(thread: Thread): Promise<void> {
  const options: Options = {
    warmup: positiveInt("warmup", 5),
    samples: positiveInt("samples", 30),
    sampleMs: positiveInt("sample-ms", 20),
  };
  const select = selector();
  const info = await pageInfo();
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];
  let worker = null;

  if (thread === "main") {
    const cases = buildMainCases(select);
    if (!cases.length) throw new Error("no main-thread case matches the selection");
    for (const c of cases) results.push(measure(c, options, performanceClock));
    const finishedAt = new Date().toISOString();
    checkMainEquivalence();
    await post("result", { thread, info, options, worker, startedAt, finishedAt, results });
    return;
  }

  const w = await startWorker(reportError);
  worker = { ...WORKER_CONFIG, wasm: w.wasm };
  const cases = buildWorkerCases(w, workerCaseIds(wasmAvailable && w.wasm.error === null).filter(select));
  if (!cases.length) throw new Error("no Worker case matches the selection");
  for (const c of cases) {
    await c.prepare();
    results.push(await measureAsync(c, options));
  }
  const finishedAt = new Date().toISOString();
  await checkWorkerEquivalence(w, w.wasm.error === null);
  w.worker.terminate();
  await post("result", { thread, info, options, worker, startedAt, finishedAt, results });
}

/**
 * Correctness without timing: every case's batch agrees with the TypeScript
 * case of the same operation and size, then the post-measurement checks of
 * both threads run.
 */
async function check(): Promise<void> {
  const main = buildMainCases();
  const reference = new Map(main.filter((c) => c.impl === "ts").map((c) => [caseGroup(c.id), c]));
  const expected = (id: string) => {
    const [op, , size] = id.split("/");
    const ts = reference.get(size === undefined ? op : `${op}/${size}`);
    if (!ts) throw new Error(`no TypeScript case for ${id}`);
    return ts.run(3);
  };
  for (const c of main) expectNumber(`${c.id} batch of 3`, c.run(3), expected(c.id));
  checkMainEquivalence();

  const w = await startWorker(reportError);
  const workerIds = workerCaseIds(wasmAvailable && w.wasm.error === null);
  for (const c of buildWorkerCases(w, workerIds)) {
    await c.prepare();
    expectNumber(`${c.id} batch of 3`, await c.run(3), expected(c.id));
  }
  await checkWorkerEquivalence(w, w.wasm.error === null);
  w.worker.terminate();
  await post("result", { info: await pageInfo(), main: main.map((c) => c.id), worker: workerIds });
}

/** Case ids of both threads in canonical order; selects nothing, so no benchmark data is allocated. */
async function list(): Promise<void> {
  const w = await startWorker(reportError);
  w.worker.terminate();
  const main: string[] = [];
  buildMainCases((id) => {
    main.push(id);
    return false;
  });
  await post("result", {
    info: await pageInfo(),
    workerWasm: w.wasm,
    main,
    worker: workerCaseIds(wasmAvailable && w.wasm.error === null),
  });
}

try {
  const mode = params.get("mode");
  if (mode === "list") await list();
  else if (mode === "check") await check();
  else if (mode === "bench") {
    const thread = params.get("thread");
    if (thread !== "main" && thread !== "worker") throw new Error(`thread must be main or worker, got "${thread}"`);
    await bench(thread);
  } else throw new Error(`unknown mode "${mode}"`);
} catch (error) {
  reportError(error);
}
