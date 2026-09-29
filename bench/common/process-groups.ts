// Process groups: cases that must run in a process started with different
// engine flags. A process runs cases of exactly one group, in either
// isolation mode, so no flag ever changes what another case measures.
//
// - default: the runtime as shipped.
// - wasm-no-inline: V8 (Node.js, Deno) with JS→WASM call inlining disabled
//   (`--no-turbo-inline-js-wasm-calls`). A diagnostic that makes the WASM
//   call itself observable; see docs/wasm.md.

export type ProcessGroup = "default" | "wasm-no-inline";

export const PROCESS_GROUPS: readonly ProcessGroup[] = ["default", "wasm-no-inline"];

/** The V8 flag a group needs. Node.js takes it as-is; Deno through `--v8-flags=`. */
export const WASM_NO_INLINE_FLAG = "--no-turbo-inline-js-wasm-calls";

/** The group a case id belongs to, from its path segment. */
export function processGroupOf(id: string): ProcessGroup {
  return id.split("/")[1] === "wasm.no-inline" ? "wasm-no-inline" : "default";
}

export function parseProcessGroup(value: string): ProcessGroup {
  if (!(PROCESS_GROUPS as readonly string[]).includes(value)) {
    throw new Error(`unknown process group "${value}" (expected ${PROCESS_GROUPS.join(", ")})`);
  }
  return value as ProcessGroup;
}
