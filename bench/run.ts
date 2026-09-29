// Runs the benchmark cases in the current runtime (Node.js, Bun or Deno).
//
//   node bench/run.ts [--warmup 5] [--samples 30] [--sample-ms 20] [--filter sum_i32 | --case sum_i32/ts/10] [--out file.json]
//   node bench/run.ts --list [--filter sum_i32] [--suite boundary,payload,return] [--process-group default|wasm-no-inline]
//   node --no-turbo-inline-js-wasm-calls bench/run.ts --process-group wasm-no-inline ...
//   bun  bench/run.ts ...
//   deno run --allow-read --allow-write --allow-ffi bench/run.ts ...

import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import process from "node:process";
import { parseArgs } from "node:util";
import { buildCaseIds, buildCases, checkEquivalence } from "./common/cases.ts";
import { parseSuites, suiteOf } from "./common/suites.ts";
import {
  parseProcessGroup,
  type ProcessGroup,
  processGroupOf,
  WASM_NO_INLINE_FLAG,
} from "./common/process-groups.ts";
import { hrtimeClock } from "./common/clock-hrtime.ts";
import { measure, type Options } from "./common/harness.ts";
import { printResults } from "./common/report.ts";

const RESULT_SCHEMA_VERSION = 2;

function runtimeName(): "node" | "bun" | "deno" {
  // Bun and Deno also expose process.versions.node, so check them first.
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.Bun) return "bun";
  if (g.Deno) return "deno";
  return "node";
}

/**
 * CPUs this process may run on, as the kernel reports it. Linux only, and
 * not under Deno, which refuses /proc reads without --allow-all; widening
 * Deno's permissions for bookkeeping would change how it is launched.
 */
function cpuAffinity(runtime: string): string | null {
  if (process.platform !== "linux" || runtime === "deno") return null;
  return readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] ?? null;
}

/**
 * Confirms this process can run `group`. Returns whether the group's V8 flag
 * was verified (true), not needed (true for default) or not observable (null).
 */
function checkProcessGroup(runtime: string, group: ProcessGroup): boolean | null {
  if (group === "default") return true;
  if (runtime === "bun") throw new Error("process group wasm-no-inline needs V8 (Node.js or Deno)");
  // Node.js exposes its flags; Deno takes them through --v8-flags, which
  // process.execArgv does not show. The orchestrator records the command.
  if (runtime === "deno") return null;
  if (!process.execArgv.includes(WASM_NO_INLINE_FLAG)) {
    throw new Error(`process group wasm-no-inline requires node ${WASM_NO_INLINE_FLAG}`);
  }
  return true;
}

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got "${value}"`);
  return n;
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      warmup: { type: "string", default: "5" },
      samples: { type: "string", default: "30" },
      "sample-ms": { type: "string", default: "20" },
      filter: { type: "string" },
      suite: { type: "string" },
      case: { type: "string" },
      "process-group": { type: "string", default: "default" },
      list: { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  if (values.filter && values.case) throw new Error("use either --filter or --case, not both");
  const suites = values.suite ? parseSuites(values.suite) : null;
  // A process runs the cases of one process group only (see process-groups.ts).
  const group = parseProcessGroup(values["process-group"]);
  const selectIgnoringGroup = (id: string) =>
    (!suites || suites.includes(suiteOf(id.split("/")[0]))) &&
    (values.case ? id === values.case : !values.filter || id.includes(values.filter));
  const select = (id: string) => processGroupOf(id) === group && selectIgnoringGroup(id);

  if (values.list) {
    // Listing constructs no cases, so it allocates no benchmark data. It
    // prints every process group's cases (the orchestrator groups them).
    const ids = buildCaseIds().filter(selectIgnoringGroup);
    console.log(ids.join("\n"));
    return;
  }

  const options: Options = {
    warmup: positiveInt("warmup", values.warmup),
    samples: positiveInt("samples", values.samples),
    sampleMs: positiveInt("sample-ms", values["sample-ms"]),
  };
  const runtime = runtimeName();
  const v8FlagsVerified = checkProcessGroup(runtime, group);

  const cases = buildCases(select);
  if (cases.length === 0) throw new Error(`no case matches ${values.case ?? values.filter ?? values.suite}`);

  console.error(
    `${runtime}: ${cases.length} cases, warmup ${options.warmup}, samples ${options.samples}, ~${options.sampleMs} ms/sample`,
  );
  const startedAt = new Date().toISOString();
  const results = cases.map((c, i) => {
    console.error(`  [${i + 1}/${cases.length}] ${c.id}`);
    return measure(c, options, hrtimeClock);
  });
  const finishedAt = new Date().toISOString();

  // Verify every operation of the suites this process measured.
  checkEquivalence([...new Set(cases.map((c) => suiteOf(c.op)))]);

  printResults(results);

  if (values.out) {
    const output = {
      schema: RESULT_SCHEMA_VERSION,
      runtime,
      versions: process.versions,
      platform: process.platform,
      arch: process.arch,
      process: {
        pid: process.pid,
        affinity: cpuAffinity(runtime),
        // Respects the affinity mask in all three runtimes.
        allowedCpuCount: os.availableParallelism(),
        execArgv: process.execArgv,
        processGroup: group,
        v8Flags: group === "wasm-no-inline" ? [WASM_NO_INLINE_FLAG] : [],
        // null: the flag cannot be observed from inside this runtime (Deno).
        v8FlagsVerified,
      },
      timer: hrtimeClock.name,
      options,
      equivalence: "checked after measurement, for the suites of the measured cases",
      startedAt,
      finishedAt,
      // In execution order.
      results,
    };
    writeFileSync(values.out, JSON.stringify(output, null, 2) + "\n");
    console.error(`wrote ${values.out}`);
  }
}

main();
