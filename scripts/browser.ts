// Browsers for bench/browser/: discovery, launch, and the local server the
// page talks to. Shared by scripts/bench-browser.ts and tests/browser.test.ts.
//
// The server serves bench/ and build/ from the repository root and nothing
// else. TypeScript files are served as JavaScript after type stripping with
// Node's built-in `stripTypeScriptTypes` (strip mode: types are replaced by
// whitespace, nothing is transformed or bundled). Every response carries
// COOP/COEP headers, so the page is cross-origin isolated: that is what gives
// performance.now its finest resolution (see docs/browser.md).

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import { extname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVED = ["bench", "build"];

export type BrowserName = "chromium" | "firefox";
export const BROWSER_NAMES: readonly BrowserName[] = ["chromium", "firefox"];

export const RESPONSE_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cache-control": "no-store",
} as const;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

/** Executable names tried on PATH when no `<NAME>_PATH` environment variable is set. */
const CANDIDATES: Record<BrowserName, string[]> = {
  chromium: ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "chrome"],
  firefox: ["firefox"],
};

const ENGINES: Record<BrowserName, string> = { chromium: "V8", firefox: "SpiderMonkey" };

/**
 * Preferences written into every fresh Firefox profile: no first-run or
 * default-browser UI, and no start-up network, telemetry or update work
 * competing with the page. No JavaScript engine setting is changed.
 */
export const FIREFOX_PREFS: Record<string, boolean | string> = {
  "browser.shell.checkDefaultBrowser": false,
  "browser.aboutwelcome.enabled": false,
  "browser.startup.homepage_override.mstone": "ignore",
  "datareporting.policy.dataSubmissionEnabled": false,
  "toolkit.telemetry.reportingpolicy.firstRun": false,
  "app.update.auto": false,
  "extensions.update.enabled": false,
  "browser.safebrowsing.malware.enabled": false,
  "browser.safebrowsing.phishing.enabled": false,
  "network.captive-portal-service.enabled": false,
  "network.connectivity-service.enabled": false,
};

export interface Browser {
  name: BrowserName;
  engine: string;
  path: string;
  /** `<path> --version`. */
  version: string;
}

/** `CHROMIUM_PATH` / `FIREFOX_PATH`, else the first candidate on PATH; null when none runs. */
export function findBrowser(name: BrowserName): Browser | null {
  const configured = process.env[`${name.toUpperCase()}_PATH`];
  for (const path of configured ? [configured] : CANDIDATES[name]) {
    const result = spawnSync(path, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return { name, engine: ENGINES[name], path, version: result.stdout.trim() };
  }
  return null;
}

/** The launch command for one page. Every launch gets a new, empty profile. */
export function browserCommand(browser: Browser, profile: string, url: string): string[] {
  if (browser.name === "chromium") {
    return [
      browser.path,
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      // No start-up network, component-update or sync work competing with the page.
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      // Keep timers, message dispatch and the renderer at foreground priority.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      url,
    ];
  }
  return [browser.path, "--headless", "--no-remote", "--profile", profile, url];
}

/** Launch command with placeholders, as recorded in environment.json. */
export function commandTemplate(browser: Browser): string[] {
  return browserCommand(browser, "<fresh-profile>", "<page-url>");
}

function newProfile(browser: Browser): string {
  const profile = mkdtempSync(join(os.tmpdir(), `isotsbench-${browser.name}-`));
  if (browser.name === "firefox") {
    const prefs = Object.entries(FIREFOX_PREFS).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
    writeFileSync(join(profile, "user.js"), prefs.join("\n") + "\n");
  }
  return profile;
}

// ---- Server ----------------------------------------------------------------

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface PageServer {
  origin: string;
  /** Resolves with the JSON the page posts to /api/result, or rejects with what it posts to /api/error. */
  expect(token: string): Promise<unknown>;
  /** Whether the page for `token` has loaded (it posts /api/started first). */
  started(token: string): boolean;
  cancel(token: string, error: Error): void;
  close(): Promise<void>;
}

function servePath(pathname: string): string | null {
  const path = resolve(ROOT, "." + decodeURIComponent(pathname));
  const inside = SERVED.some((dir) => path.startsWith(join(ROOT, dir) + sep));
  return inside && CONTENT_TYPES[extname(path)] && existsSync(path) ? path : null;
}

export function startServer(): Promise<PageServer> {
  const pending = new Map<string, Pending>();
  const loaded = new Set<string>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/started") {
      loaded.add(url.searchParams.get("token") ?? "");
      res.writeHead(204, RESPONSE_HEADERS).end();
      return;
    }
    if (req.method === "POST" && (url.pathname === "/api/result" || url.pathname === "/api/error")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(204, RESPONSE_HEADERS).end();
        const waiter = pending.get(url.searchParams.get("token") ?? "");
        if (!waiter) return;
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        pending.delete(url.searchParams.get("token")!);
        if (url.pathname === "/api/result") waiter.resolve(body);
        else waiter.reject(new Error(`page error: ${body.message}`));
      });
      return;
    }
    const path = req.method === "GET" ? servePath(url.pathname) : null;
    if (!path) {
      res.writeHead(404, RESPONSE_HEADERS).end();
      return;
    }
    const ext = extname(path);
    const body = ext === ".ts" ? stripTypeScriptTypes(readFileSync(path, "utf8"), { mode: "strip" }) : readFileSync(path);
    res.writeHead(200, { ...RESPONSE_HEADERS, "content-type": CONTENT_TYPES[ext] }).end(body);
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("server has no TCP address");
      resolveServer({
        origin: `http://127.0.0.1:${address.port}`,
        expect: (token) => new Promise((resolve, reject) => pending.set(token, { resolve, reject })),
        started: (token) => loaded.has(token),
        cancel(token, error) {
          pending.get(token)?.reject(error);
          pending.delete(token);
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// ---- Launch ----------------------------------------------------------------

/** Browsers still running, by process group, with their profiles. */
const active = new Map<number, string>();

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

// Browsers run detached in their own process group, so they would outlive an
// interrupted orchestrator. On any exit, kill them and remove their profiles.
process.on("exit", () => {
  for (const [pgid, profile] of active) {
    killGroup(pgid);
    rmSync(profile, { recursive: true, force: true });
  }
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => process.exit(128 + os.constants.signals[signal]));
}

export interface PageRun {
  /** What the page posted. */
  data: unknown;
  /** The exact command, with the real profile and URL. */
  command: string[];
  pid: number;
  /** Cpus_allowed_list of every process in the browser's process group, when pinned (Linux). */
  affinity: string[] | null;
  /** Browser launches needed; more than 1 when a browser never loaded the page and was restarted. */
  launchAttempts: number;
}

/** A browser that has not loaded the page by then is considered stuck at start-up. */
const START_TIMEOUT_MS = 30_000;
const MAX_LAUNCH_ATTEMPTS = 3;

class NeverLoaded extends Error {}

/** Cpus_allowed_list of every live process whose process group is `pgid`. */
function groupAffinity(pgid: number): string[] {
  const lists: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // Field 5 (pgrp) follows the parenthesised command name, which may contain spaces.
      if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) !== pgid) continue;
      const allowed = readFileSync(`/proc/${entry}/status`, "utf8").match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1];
      if (allowed) lists.push(allowed);
    } catch {
      // The process exited between listing and reading.
    }
  }
  return lists;
}

/**
 * Opens `query` on bench/browser/index.html in a fresh browser with a fresh
 * profile, waits for the page to post its result, then kills the whole
 * browser process group and removes the profile.
 *
 * A browser that never loads the page within START_TIMEOUT_MS is killed and
 * a new one is launched, up to MAX_LAUNCH_ATTEMPTS times. Nothing was
 * measured by then; the attempts are recorded.
 */
export async function runPage(
  browser: Browser,
  server: PageServer,
  query: URLSearchParams,
  options: { timeoutMs: number; pinPrefix?: string[] },
): Promise<PageRun> {
  for (let attempt = 1;; attempt++) {
    try {
      return { ...await launchPage(browser, server, query, options), launchAttempts: attempt };
    } catch (error) {
      if (!(error instanceof NeverLoaded) || attempt === MAX_LAUNCH_ATTEMPTS) throw error;
      console.error(`${browser.name} did not load the page within ${START_TIMEOUT_MS / 1000} s; relaunching (${error.message})`);
    }
  }
}

async function launchPage(
  browser: Browser,
  server: PageServer,
  query: URLSearchParams,
  options: { timeoutMs: number; pinPrefix?: string[] },
): Promise<Omit<PageRun, "launchAttempts">> {
  const token = randomUUID();
  const params = new URLSearchParams(query);
  params.set("token", token);
  const url = `${server.origin}/bench/browser/index.html?${params}`;
  const profile = newProfile(browser);
  const command = [...(options.pinPrefix ?? []), ...browserCommand(browser, profile, url)];
  const result = server.expect(token);
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  active.set(child.pid!, profile);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
  const tail = () => (stderr.trim() ? `\nbrowser stderr (tail):\n${stderr.trim()}` : "");
  const exited = new Promise<void>((done) => child.on("exit", () => done()));
  child.on("exit", (code) => server.cancel(token, new Error(`${browser.name} exited (${code}) before the page finished${tail()}`)));
  const startTimer = setTimeout(() => {
    if (!server.started(token)) server.cancel(token, new NeverLoaded(`no page load after ${START_TIMEOUT_MS / 1000} s${tail()}`));
  }, START_TIMEOUT_MS);
  const timer = setTimeout(
    () => server.cancel(token, new Error(`${browser.name}: no result within ${options.timeoutMs / 1000} s${tail()}`)),
    options.timeoutMs,
  );
  try {
    const data = await result;
    const affinity = options.pinPrefix?.length && process.platform === "linux" ? groupAffinity(child.pid!) : null;
    return { data, command, pid: child.pid!, affinity };
  } finally {
    clearTimeout(startTimer);
    clearTimeout(timer);
    killGroup(child.pid!);
    await exited;
    rmSync(profile, { recursive: true, force: true });
    active.delete(child.pid!);
  }
}

/**
 * The JavaScript engine's own version where the browser exposes it: V8's via
 * the DevTools `/json/version` endpoint of a separate, short launch (never a
 * benchmark launch). SpiderMonkey has no separate version: it ships with, and
 * is numbered as, Firefox.
 */
export async function engineVersion(browser: Browser): Promise<{ version: string | null; source: string }> {
  if (browser.name === "firefox") return { version: browser.version.match(/[\d.]+$/)?.[0] ?? null, source: "firefox --version" };
  const profile = newProfile(browser);
  const child = spawn(browser.path, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], {
    detached: true,
    stdio: "ignore",
  });
  active.set(child.pid!, profile);
  const exited = new Promise<void>((done) => child.on("exit", () => done()));
  try {
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((done) => setTimeout(done, 100));
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    return { version: info["V8-Version"] ?? null, source: "DevTools /json/version of a separate launch" };
  } catch {
    return { version: null, source: "not available" };
  } finally {
    killGroup(child.pid!);
    await exited;
    rmSync(profile, { recursive: true, force: true });
    active.delete(child.pid!);
  }
}
