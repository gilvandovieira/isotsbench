// Read-only inspection of CPU topology and frequency/power settings via
// Linux sysfs. Nothing here changes system state; unsuitable settings are
// reported as warnings for the user to act on.

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const CPU_ROOT = "/sys/devices/system/cpu";

export interface CpuInfo {
  cpu: number;
  /** From the Intel hybrid PMU nodes (/sys/devices/cpu_core, cpu_atom). */
  coreType: "P-core" | "E-core" | null;
  maxFreqKHz: number | null;
  /** Relative capacity (ARM big.LITTLE, some x86 kernels). */
  capacity: number | null;
  coreId: number | null;
  packageId: number | null;
  smtSiblings: number[] | null;
  governor: string | null;
  energyPerformancePreference: string | null;
}

export interface SystemState {
  platform: string;
  /** False when the platform exposes none of this; every other field is then empty. */
  supported: boolean;
  onlineCpus: number[];
  cpus: CpuInfo[];
  /** CPUs grouped by core type, max frequency and capacity. */
  cpuClasses: { key: string; cpus: string }[];
  /** More than one CPU class; null when nothing identifies a class. */
  heterogeneous: boolean | null;
  scalingDriver: string | null;
  intelPstate: { status: string | null; noTurbo: string | null } | null;
  cpufreqBoost: string | null;
  smtActive: string | null;
  platformProfile: string | null;
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

function readInt(path: string): number | null {
  const v = read(path);
  return v === null ? null : Number(v);
}

/** Parses kernel CPU lists such as "0-3,8,10-11". */
export function parseCpuList(list: string): number[] {
  const cpus: number[] = [];
  for (const part of list.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`invalid CPU list "${list}"`);
    const [lo, hi] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (hi < lo) throw new Error(`invalid CPU range "${part}"`);
    for (let c = lo; c <= hi; c++) cpus.push(c);
  }
  return [...new Set(cpus)].sort((a, b) => a - b);
}

export function formatCpuList(cpus: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < cpus.length; i++) {
    let j = i;
    while (j + 1 < cpus.length && cpus[j + 1] === cpus[j] + 1) j++;
    parts.push(j > i ? `${cpus[i]}-${cpus[j]}` : `${cpus[i]}`);
    i = j;
  }
  return parts.join(",");
}

function classKey(c: CpuInfo): string | null {
  const parts = [
    c.coreType,
    c.maxFreqKHz === null ? null : `${c.maxFreqKHz / 1000} MHz`,
    c.capacity === null ? null : `capacity ${c.capacity}`,
  ].filter((p) => p !== null);
  return parts.length ? parts.join(", ") : null;
}

export function probeSystem(): SystemState {
  const empty: SystemState = {
    platform: process.platform,
    supported: false,
    onlineCpus: [],
    cpus: [],
    cpuClasses: [],
    heterogeneous: null,
    scalingDriver: null,
    intelPstate: null,
    cpufreqBoost: null,
    smtActive: null,
    platformProfile: null,
  };
  const online = process.platform === "linux" ? read(`${CPU_ROOT}/online`) : null;
  if (online === null) return empty;

  const pCores = read("/sys/devices/cpu_core/cpus");
  const eCores = read("/sys/devices/cpu_atom/cpus");
  const pSet = new Set(pCores ? parseCpuList(pCores) : []);
  const eSet = new Set(eCores ? parseCpuList(eCores) : []);

  const onlineCpus = parseCpuList(online);
  const cpus = onlineCpus.map((cpu): CpuInfo => {
    const dir = `${CPU_ROOT}/cpu${cpu}`;
    const siblings = read(`${dir}/topology/thread_siblings_list`);
    return {
      cpu,
      coreType: pSet.has(cpu) ? "P-core" : eSet.has(cpu) ? "E-core" : null,
      maxFreqKHz: readInt(`${dir}/cpufreq/cpuinfo_max_freq`),
      capacity: readInt(`${dir}/cpu_capacity`),
      coreId: readInt(`${dir}/topology/core_id`),
      packageId: readInt(`${dir}/topology/physical_package_id`),
      smtSiblings: siblings === null ? null : parseCpuList(siblings),
      governor: read(`${dir}/cpufreq/scaling_governor`),
      energyPerformancePreference: read(`${dir}/cpufreq/energy_performance_preference`),
    };
  });

  const classes = new Map<string, number[]>();
  for (const c of cpus) {
    const key = classKey(c);
    if (key !== null) classes.set(key, [...(classes.get(key) ?? []), c.cpu]);
  }
  const noTurbo = read(`${CPU_ROOT}/intel_pstate/no_turbo`);
  const pstateStatus = read(`${CPU_ROOT}/intel_pstate/status`);

  return {
    platform: process.platform,
    supported: true,
    onlineCpus,
    cpus,
    cpuClasses: [...classes].map(([key, list]) => ({ key, cpus: formatCpuList(list) })),
    heterogeneous: classes.size ? classes.size > 1 : null,
    scalingDriver: read(`${CPU_ROOT}/cpu${onlineCpus[0]}/cpufreq/scaling_driver`),
    intelPstate: pstateStatus === null && noTurbo === null ? null : { status: pstateStatus, noTurbo },
    cpufreqBoost: read(`${CPU_ROOT}/cpufreq/boost`),
    smtActive: read(`${CPU_ROOT}/smt/active`),
    platformProfile: read("/sys/firmware/acpi/platform_profile"),
  };
}

/** Groups CPUs by a per-CPU value, e.g. "powersave on 0-11". */
function describeBy(cpus: CpuInfo[], value: (c: CpuInfo) => string | null): string {
  const groups = new Map<string, number[]>();
  for (const c of cpus) {
    const v = value(c) ?? "unknown";
    groups.set(v, [...(groups.get(v) ?? []), c.cpu]);
  }
  return [...groups].map(([v, list]) => `${v} on ${formatCpuList(list)}`).join("; ");
}

/**
 * Lists the conditions that make a run unsuitable as an official result.
 * `pinned` is the CPU set the benchmark processes are restricted to.
 */
export function assessConditions(state: SystemState, pinned: number[] | null): string[] {
  if (!state.supported) {
    return [`CPU topology, frequency settings and affinity cannot be inspected on ${state.platform}; conditions are unverified`];
  }
  const warnings: string[] = [];
  const relevant = pinned ? state.cpus.filter((c) => pinned.includes(c.cpu)) : state.cpus;
  const classesOf = (cpus: CpuInfo[]) => new Set(cpus.map(classKey));

  if (!pinned) {
    warnings.push(
      state.heterogeneous
        ? `not pinned (--cpus): the scheduler may move benchmark threads across different CPU classes (${
          state.cpuClasses.map((c) => `${c.cpus}: ${c.key}`).join(" | ")
        })`
        : "not pinned (--cpus): the scheduler may migrate benchmark threads between CPUs",
    );
  } else if (classesOf(relevant).size > 1) {
    warnings.push(`pinned CPUs span different CPU classes: ${describeBy(relevant, classKey)}`);
  }

  if (pinned) {
    const pairs = relevant
      .filter((c) => c.smtSiblings?.some((s) => s !== c.cpu && pinned.includes(s) && s > c.cpu))
      .map((c) => formatCpuList(c.smtSiblings!));
    if (pairs.length) {
      warnings.push(`pinned CPUs include SMT siblings (${pairs.join(" ")}): threads of one run can share a physical core`);
    }
  }

  if (relevant.some((c) => c.governor !== null && c.governor !== "performance")) {
    warnings.push(`scaling governor is not "performance": ${describeBy(relevant, (c) => c.governor)}`);
  }
  if (relevant.some((c) => c.energyPerformancePreference !== null && c.energyPerformancePreference !== "performance")) {
    warnings.push(`energy_performance_preference is not "performance": ${
      describeBy(relevant, (c) => c.energyPerformancePreference)
    }`);
  }
  if (state.intelPstate?.noTurbo === "0" || state.cpufreqBoost === "1") {
    warnings.push("turbo/boost is enabled: clock speed depends on thermal and power headroom");
  }
  if (state.platformProfile !== null && state.platformProfile !== "performance") {
    warnings.push(`platform power profile is "${state.platformProfile}"`);
  }
  return warnings;
}
