// Entry point compiled by scriptc into a standalone executable
// (build/isotsbench-scriptc): no Node.js, Bun or Deno at run time.
// Same options and the same JSON output as bench/run.ts.
//
//   scriptc build bench/scriptc/run.ts --ffi native/scriptc/ffi.json -o build/isotsbench-scriptc
//   build/isotsbench-scriptc [--warmup 5] [--samples 30] [--sample-ms 20] [--filter X | --case ID] [--suite S] [--out file.json]
//   build/isotsbench-scriptc --list

import { readFileSync, writeFileSync } from "node:fs";
import type { Case } from "../common/case.ts";
import { type CaseResult, measure, type Options } from "../common/harness.ts";
import { printResults } from "../common/report.ts";
import { parseSuites, type Suite, suiteOf } from "../common/suites.ts";
import { buildCaseIds, buildCases, checkEquivalence } from "./cases.ts";
import { performanceClock } from "./clock.ts";

const RESULT_SCHEMA_VERSION = 2;

/** CPUs this process may run on, as the kernel reports it (Linux only). */
function cpuAffinity(): string | null {
  if (process.platform !== "linux") return null;
  const match = readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.+)$/m);
  return match ? match[1]! : null;
}

/**
 * Number of CPUs in a kernel CPU list such as "0-3,8". scriptc has no
 * os.availableParallelism, which the other runtimes use for this count.
 */
function cpuCount(list: string): number {
  let count = 0;
  for (const part of list.split(",")) {
    const bounds = part.split("-");
    const lo = Number(bounds[0]!);
    const hi = bounds.length > 1 ? Number(bounds[1]!) : lo;
    count += hi - lo + 1;
  }
  return count;
}

const VALUE_OPTIONS = ["warmup", "samples", "sample-ms", "filter", "suite", "case", "out"];

/**
 * `--name value` options and the `--list` flag, as bench/run.ts accepts
 * them. A small explicit parser: scriptc types util.parseArgs results too
 * loosely to read them statically.
 */
function parseCliArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--list") {
      args.set("list", "");
      continue;
    }
    const name = arg.startsWith("--") ? arg.slice(2) : "";
    if (!VALUE_OPTIONS.includes(name)) throw new Error(`unknown option "${arg}"`);
    if (i + 1 >= argv.length) throw new Error(`option "${arg}" needs a value`);
    args.set(name, argv[i + 1]!);
    i++;
  }
  return args;
}

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got "${value}"`);
  return n;
}

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const filter = args.get("filter") ?? "";
  const caseId = args.get("case") ?? "";
  const suiteList = args.get("suite") ?? "";
  const out = args.get("out") ?? "";
  if (filter && caseId) throw new Error("use either --filter or --case, not both");
  const suites: Suite[] | null = suiteList ? parseSuites(suiteList) : null;
  const select = (id: string): boolean =>
    (suites === null || suites.includes(suiteOf(id.split("/")[0]!))) &&
    (caseId ? id === caseId : !filter || id.includes(filter));

  if (args.has("list")) {
    // Listing constructs no cases, so it allocates no benchmark data.
    console.log(buildCaseIds().filter(select).join("\n"));
    return;
  }

  const options: Options = {
    warmup: positiveInt("warmup", args.get("warmup") ?? "5"),
    samples: positiveInt("samples", args.get("samples") ?? "30"),
    sampleMs: positiveInt("sample-ms", args.get("sample-ms") ?? "20"),
  };

  const cases: Case[] = buildCases(select);
  if (cases.length === 0) throw new Error(`no case matches ${caseId || filter || suiteList}`);

  console.error(
    `scriptc: ${cases.length} cases, warmup ${options.warmup}, samples ${options.samples}, ~${options.sampleMs} ms/sample`,
  );
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    console.error(`  [${i + 1}/${cases.length}] ${c.id}`);
    results.push(measure(c, options, performanceClock));
  }
  const finishedAt = new Date().toISOString();

  // Verify every operation of the suites this process measured.
  const measured: Suite[] = [];
  for (const c of cases) {
    const suite = suiteOf(c.op);
    if (!measured.includes(suite)) measured.push(suite);
  }
  checkEquivalence(measured);

  printResults(results);

  if (out) {
    const affinity = cpuAffinity();
    const output = {
      schema: RESULT_SCHEMA_VERSION,
      runtime: "scriptc",
      // The scriptc compiler version is recorded by the orchestrator at build time.
      versions: {},
      platform: process.platform,
      arch: process.arch,
      process: {
        pid: process.pid,
        affinity,
        allowedCpuCount: affinity === null ? null : cpuCount(affinity),
        execArgv: [],
      },
      timer: performanceClock.name,
      options,
      equivalence: "checked after measurement, for the suites of the measured cases",
      startedAt,
      finishedAt,
      // In execution order.
      results,
    };
    writeFileSync(out, JSON.stringify(output, null, 2) + "\n");
    console.error(`wrote ${out}`);
  }
}

main();
