// Loads a WASM build in a browser page or Worker: fetch, then the standard
// asynchronous WebAssembly.instantiate. The ABI is shared with the server
// runtimes (../common/wasm-abi.ts).

import { bindWasm, WASM_URLS, type WasmBinding, type WasmVariant } from "../common/wasm-abi.ts";

/** What the page records about one artifact: whether it loaded, and exactly which bytes. */
export interface WasmArtifactStatus {
  variant: WasmVariant;
  url: string;
  sizeBytes: number | null;
  sha256: string | null;
  /** Why the variant is unavailable (missing artifact, or rejected by the engine); null when loaded. */
  error: string | null;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A missing or rejected artifact makes the variant unavailable, as in the server runtimes. */
export async function loadWasm(variant: WasmVariant): Promise<{ binding: WasmBinding | null; status: WasmArtifactStatus }> {
  const url = WASM_URLS[variant];
  const status: WasmArtifactStatus = { variant, url: url.pathname, sizeBytes: null, sha256: null, error: null };
  const response = await fetch(url);
  if (!response.ok) {
    status.error = `HTTP ${response.status}`;
    return { binding: null, status };
  }
  const bytes = await response.arrayBuffer();
  status.sizeBytes = bytes.byteLength;
  status.sha256 = await sha256(bytes);
  try {
    const { instance } = await WebAssembly.instantiate(bytes);
    return { binding: bindWasm(instance.exports, variant), status };
  } catch (error) {
    status.error = String(error);
    return { binding: null, status };
  }
}
