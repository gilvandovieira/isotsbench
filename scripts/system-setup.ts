// Puts a Linux machine into the official-run conditions checked by
// scripts/system.ts (assessConditions), and restores it afterwards. The
// benchmark runners never change system settings; only this script does,
// and only when asked (make setup / make teardown).
//
//   node scripts/system-setup.ts apply [--cpus LIST] [--dry-run]
//   node scripts/system-setup.ts restore [--dry-run]
//
// `apply` first saves the current value of every setting below to
// .official-setup.json, then writes, with root rights through `sudo tee`:
//   - every cpufreq policy's scaling_governor → performance
//   - energy_performance_preference → performance (where it exists)
//   - turbo off: intel_pstate/no_turbo → 1, or cpufreq/boost → 0
//   - ACPI platform_profile → performance (when offered)
// `restore` writes the saved values back, governor before EPP, and removes
// the state file. `apply` refuses to run while a state file exists, so the
// original settings can never be overwritten by already-changed ones.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assessConditions, parseCpuList, probeSystem } from "./system.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const STATE_FILE = join(ROOT, ".official-setup.json");

export interface Setting {
  path: string;
  value: string;
}

export interface SavedState {
  createdAt: string;
  /** Original values, in the order they must be written back. */
  settings: Setting[];
}

/** Writes one sysfs value; the real one goes through sudo. */
export type Writer = (path: string, value: string) => void;

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

/**
 * Every setting this script manages that exists on this machine, in write
 * order, with its current and official value. EPP comes after the
 * governors: intel_pstate forces it to `performance` when the governor
 * becomes `performance`, and may change it again when the governor goes
 * back, so it is saved and restored even when it needs no change.
 */
export function managedSettings(sysfs: string): { path: string; current: string; target: string }[] {
  const cpu = join(sysfs, "devices/system/cpu");
  const cpufreq = join(cpu, "cpufreq");
  const policies = existsSync(cpufreq) ? readdirSync(cpufreq).filter((d) => /^policy\d+$/.test(d)).sort() : [];
  const settings: { path: string; current: string; target: string }[] = [];
  const add = (path: string, target: string) => {
    const current = read(path);
    if (current !== null) settings.push({ path, current, target });
  };
  add(join(cpu, "intel_pstate/no_turbo"), "1");
  add(join(cpufreq, "boost"), "0");
  if (read(join(sysfs, "firmware/acpi/platform_profile_choices"))?.split(/\s+/).includes("performance")) {
    add(join(sysfs, "firmware/acpi/platform_profile"), "performance");
  }
  for (const p of policies) add(join(cpufreq, p, "scaling_governor"), "performance");
  for (const p of policies) add(join(cpufreq, p, "energy_performance_preference"), "performance");
  return settings;
}

/** The settings that are not yet at their official value. */
export function pendingChanges(sysfs: string): { path: string; current: string; target: string }[] {
  return managedSettings(sysfs).filter((s) => s.current !== s.target);
}

/** Saves every managed setting's value, then applies the official settings. Returns what was saved. */
export function apply(sysfs: string, stateFile: string, write: Writer): SavedState {
  if (existsSync(stateFile)) {
    throw new Error(`${stateFile} exists: the machine is already set up. Run \`make teardown\` first.`);
  }
  const settings = managedSettings(sysfs);
  // Restore order: governors go back first, so that EPP can take a non-performance value again.
  const governors = settings.filter((s) => s.path.endsWith("scaling_governor"));
  const others = settings.filter((s) => !s.path.endsWith("scaling_governor"));
  const state: SavedState = {
    createdAt: new Date().toISOString(),
    settings: [...governors, ...others].map((s) => ({ path: s.path, value: s.current })),
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  for (const s of settings) {
    // A governor change can already have set EPP.
    if (read(s.path) !== s.target) write(s.path, s.target);
    const now = read(s.path);
    if (now !== s.target) throw new Error(`${s.path} is "${now}" after writing "${s.target}"; run \`make teardown\` to restore`);
  }
  return state;
}

/** Writes the saved values back and removes the state file. */
export function restore(stateFile: string, write: Writer): SavedState {
  if (!existsSync(stateFile)) throw new Error(`${stateFile} not found: nothing to restore`);
  const state: SavedState = JSON.parse(readFileSync(stateFile, "utf8"));
  const failed: string[] = [];
  for (const s of state.settings) {
    if (read(s.path) !== s.value) write(s.path, s.value);
    if (read(s.path) !== s.value) failed.push(`${s.path}: "${read(s.path)}", saved "${s.value}"`);
  }
  if (failed.length) throw new Error(`not restored (state kept in ${stateFile}):\n  ${failed.join("\n  ")}`);
  rmSync(stateFile);
  return state;
}

function sudoWriter(path: string, value: string): void {
  const result = spawnSync("sudo", ["tee", path], { input: value + "\n", stdio: ["pipe", "ignore", "inherit"] });
  if (result.status !== 0) throw new Error(`sudo tee ${path} failed`);
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { cpus: { type: "string" }, "dry-run": { type: "boolean", default: false } },
  });
  const command = positionals[0];
  if (command !== "apply" && command !== "restore") {
    throw new Error("usage: node scripts/system-setup.ts apply [--cpus LIST] [--dry-run] | restore [--dry-run]");
  }
  if (process.platform !== "linux") throw new Error(`system settings can only be changed on Linux, not ${process.platform}`);

  if (values["dry-run"]) {
    if (command === "apply") {
      const plan = pendingChanges("/sys");
      console.log(plan.length ? "would write:" : "nothing to change");
      for (const s of plan) console.log(`  ${s.path}: ${s.current} → ${s.target}`);
    } else {
      if (!existsSync(STATE_FILE)) throw new Error(`${STATE_FILE} not found: nothing to restore`);
      const state: SavedState = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      console.log("would write back:");
      for (const s of state.settings) console.log(`  ${s.path}: ${read(s.path)} → ${s.value}`);
    }
    return;
  }

  if (command === "apply" && !existsSync(STATE_FILE) && pendingChanges("/sys").length === 0) {
    console.log("already in official conditions; nothing changed");
  } else {
    // One password prompt up front, instead of one per write.
    if (spawnSync("sudo", ["-v"], { stdio: "inherit" }).status !== 0) throw new Error("sudo failed");
    const state = command === "apply" ? apply("/sys", STATE_FILE, sudoWriter) : restore(STATE_FILE, sudoWriter);
    console.log(
      command === "apply"
        ? `official settings applied; ${state.settings.length} original value(s) saved in ${STATE_FILE}`
        : `${state.settings.length} setting(s) restored`,
    );
  }
  if (command === "apply") {
    const warnings = assessConditions(probeSystem(), values.cpus ? parseCpuList(values.cpus) : null);
    if (warnings.length) {
      console.log("remaining run-condition warnings:");
      for (const w of warnings) console.log(`  - ${w}`);
    } else console.log("no run-condition warnings");
  }
}

if (import.meta.main) main();
