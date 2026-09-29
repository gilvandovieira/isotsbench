// make setup / make teardown against a fake sysfs tree: the real one needs root.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { apply, pendingChanges, restore } from "../scripts/system-setup.ts";

const ORIGINAL: Record<string, string> = {
  "devices/system/cpu/intel_pstate/no_turbo": "0",
  "firmware/acpi/platform_profile": "balanced",
  "firmware/acpi/platform_profile_choices": "quiet balanced performance",
  "devices/system/cpu/cpufreq/policy0/scaling_governor": "powersave",
  "devices/system/cpu/cpufreq/policy0/energy_performance_preference": "performance",
  "devices/system/cpu/cpufreq/policy1/scaling_governor": "powersave",
  "devices/system/cpu/cpufreq/policy1/energy_performance_preference": "balance_power",
};

function fakeSysfs(): string {
  const root = mkdtempSync(join(os.tmpdir(), "isotsbench-sysfs-"));
  for (const [path, value] of Object.entries(ORIGINAL)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value + "\n");
  }
  return root;
}

const read = (root: string, path: string) => readFileSync(join(root, path), "utf8").trim();

/** Mimics intel_pstate: the performance governor forces EPP, and leaving it resets EPP to a default. */
function kernelWriter(written: string[]) {
  return (path: string, value: string) => {
    written.push(path);
    writeFileSync(path, value + "\n");
    if (path.endsWith("scaling_governor")) {
      const epp = join(dirname(path), "energy_performance_preference");
      writeFileSync(epp, (value === "performance" ? "performance" : "balance_performance") + "\n");
    }
  };
}

test("setup applies the official settings and teardown restores every original value", () => {
  const root = fakeSysfs();
  const state = join(root, "state.json");
  try {
    const written: string[] = [];
    apply(root, state, kernelWriter(written));
    assert.equal(read(root, "devices/system/cpu/intel_pstate/no_turbo"), "1");
    assert.equal(read(root, "firmware/acpi/platform_profile"), "performance");
    for (const p of ["policy0", "policy1"]) {
      assert.equal(read(root, `devices/system/cpu/cpufreq/${p}/scaling_governor`), "performance");
      assert.equal(read(root, `devices/system/cpu/cpufreq/${p}/energy_performance_preference`), "performance");
    }
    // EPP was forced by the governor change, so it was never written directly.
    assert.ok(!written.some((p) => p.endsWith("energy_performance_preference")));
    assert.deepEqual(pendingChanges(root), []);
    assert.throws(() => apply(root, state, kernelWriter([])), /already set up/);

    // Leaving the performance governor resets EPP; restore must still bring back each saved value.
    restore(state, kernelWriter([]));
    for (const [path, value] of Object.entries(ORIGINAL)) assert.equal(read(root, path), value, path);
    assert.equal(existsSync(state), false);
    assert.throws(() => restore(state, kernelWriter([])), /nothing to restore/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a write that does not take effect stops setup, and the saved state stays for teardown", () => {
  const root = fakeSysfs();
  const state = join(root, "state.json");
  try {
    assert.throws(() => apply(root, state, () => {}), /after writing/);
    assert.equal(existsSync(state), true);
    restore(state, kernelWriter([]));
    for (const [path, value] of Object.entries(ORIGINAL)) assert.equal(read(root, path), value, path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
