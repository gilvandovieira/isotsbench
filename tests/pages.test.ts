// The built site (build/site/, `make site`) as GitHub Pages will serve it:
// self-contained, relative to the /isotsbench/ base path, with no core content
// from the network, and with every link into the repository resolving.
// The browser check needs Chromium; it is skipped without one, except in CI.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findBrowser } from "../scripts/browser.ts";
import { serveSite } from "../scripts/serve-site.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE = join(ROOT, "build", "site");
if (!existsSync(join(SITE, "index.html"))) throw new Error("build/site/index.html not found: run make site first");

const read = (path: string) => readFileSync(join(SITE, path), "utf8");
const html = read("index.html");
const scripts = ["app.js", "charts.js"].map(read).join("\n");
const css = read("styles.css");
const catalogs = readdirSync(join(SITE, "i18n")).map((f) => read(join("i18n", f)));

test("the build is self-contained: the data are real files, identical to results/normalized", () => {
  for (const name of ["results.json", "results.csv", "metadata.json"]) {
    const path = join(SITE, "data", name);
    assert.ok(!lstatSync(path).isSymbolicLink(), `${name} is a symlink`);
    assert.ok(readFileSync(path).equals(readFileSync(join(ROOT, "results", "normalized", name))), name);
  }
  assert.ok(!existsSync(join(SITE, "README.md")));
});

test("every reference is relative, so it works under the Pages base path, and resolves inside the build", () => {
  const references = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((ref) => !/^(https:\/\/|#|data:)/.test(ref));
  // What app.js and charts.js fetch at run time.
  assert.match(scripts, /fetch\(`i18n\/\$\{lang\}\.json`\)/);
  assert.match(scripts, /fetch\("data\/results\.json"\)/);
  references.push("i18n/en.json", "i18n/pt-BR.json", "data/results.json");
  for (const ref of references) {
    assert.doesNotMatch(ref, /^\//, `${ref} is root-relative and would miss the /isotsbench/ base path`);
    const path = ref.split(/[?#]/)[0];
    assert.ok(existsSync(join(SITE, path === "./" ? "index.html" : path)), `${ref} is missing from the build`);
  }
});

test("no core content needs the network: scripts, styles, text and data are all local", () => {
  for (const [, tag] of html.matchAll(/(<(?:script|link|img)\b[^>]*>)/g)) {
    assert.doesNotMatch(tag, /(src|href)="https?:/, tag);
  }
  assert.doesNotMatch(scripts, /fetch\(\s*["'`]https?:|import\s[^;]*from\s+["']https?:/);
  assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/);
});

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
function anchors(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
      m[1].trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-")
    ),
  );
}

const git = (...args: string[]) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });

test("links into the repository resolve: docs and anchors on main, raw evidence at its pinned commit", () => {
  const links = new Set(
    [html, ...catalogs].flatMap((text) =>
      [...text.matchAll(/https:\/\/github\.com\/gilvandovieira\/isotsbench[^\s"')\]]*/g)].map((m) => m[0])
    ),
  );
  assert.ok(links.size > 5);
  for (const link of links) {
    const match = link.match(
      /^https:\/\/github\.com\/gilvandovieira\/isotsbench(?:\/(blob|tree)\/([^/]+)\/([^#]+))?(?:#(.+))?$/,
    );
    assert.ok(match, `unexpected link ${link}`);
    const [, kind, rev, path, anchor] = match;
    if (!kind) continue; // the repository itself (#readme is GitHub's README anchor)
    let content: string | null = null;
    if (rev === "main") {
      // In the working tree and not ignored, so it is on main once committed.
      assert.ok(existsSync(join(ROOT, path)), `${link}: ${path} does not exist`);
      assert.notEqual(git("check-ignore", "-q", path).status, 0, `${link}: ${path} is git-ignored`);
      if (kind === "blob") content = readFileSync(join(ROOT, path), "utf8");
    } else {
      const type = git("cat-file", "-t", `${rev}:${path}`);
      assert.equal(type.status, 0, `${link}: ${path} is not in commit ${rev}`);
      assert.equal(type.stdout.trim(), kind === "tree" ? "tree" : "blob", link);
      if (kind === "blob") content = git("show", `${rev}:${path}`).stdout;
    }
    if (anchor && path.endsWith(".md")) assert.ok(anchors(content!).has(anchor), `${link}: no heading #${anchor}`);
  }
});

// ---- Browser -----------------------------------------------------------------

const chromium = findBrowser("chromium");

/** A minimal Chrome DevTools Protocol client over the browser's WebSocket. */
async function devtools(browserPath: string) {
  const profile = mkdtempSync(join(os.tmpdir(), "isotsbench-site-"));
  const args = [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--disable-background-networking",
    "--disable-component-update",
  ];
  // GitHub's Ubuntu runners restrict the user namespaces Chromium's sandbox needs. The page is local.
  if (process.env.CI) args.push("--no-sandbox");
  // Its own process group: google-chrome is a wrapper script, and killing it alone leaves the browser running.
  const child = spawn(browserPath, [...args, "about:blank"], { stdio: ["ignore", "ignore", "inherit"], detached: true });
  const kill = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(profile, { recursive: true, force: true });
  };
  try {
    return await connect(profile, kill);
  } catch (error) {
    kill();
    throw error;
  }
}

async function connect(profile: string, kill: () => void) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    const file = join(profile, "DevToolsActivePort");
    if (existsSync(file)) port = Number(readFileSync(file, "utf8").split("\n")[0]);
    else await sleep(100);
  }
  assert.ok(port, "Chromium did not start");
  let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
  for (let i = 0; i < 50 && !targets.some((t) => t.type === "page"); i++) {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    if (!targets.some((t) => t.type === "page")) await sleep(100);
  }
  const page = targets.find((t) => t.type === "page");
  assert.ok(page, "Chromium opened no page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DevTools connection timed out")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    socket.addEventListener("error", () => reject(new Error("DevTools connection failed")));
  });
  let id = 0;
  const pending = new Map<number, (message: Json) => void>();
  const requests: string[] = [];
  const problems: string[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
    if (message.method === "Runtime.exceptionThrown") problems.push(message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      problems.push(message.params.args.map((a: Json) => a.value ?? a.description).join(" "));
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const send = (method: string, params = {}) =>
    new Promise<Json>((resolve) => {
      pending.set(++id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression: string) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.result.value;
  const until = async (expression: string, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    const seen = await evaluate(`JSON.stringify({
      url: location.href,
      lang: document.documentElement.lang,
      ready: document.documentElement.classList.contains("ready"),
      charts: document.querySelectorAll(".viz-plot svg").length,
      errors: [...document.querySelectorAll(".viz-error, .load-error")].map((e) => e.textContent),
    })`);
    assert.fail(
      `timed out waiting for ${what}: page ${seen}; console ${JSON.stringify(problems)}; requests ${
        JSON.stringify(requests)
      }`,
    );
  };
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.enable");
  return {
    send,
    evaluate,
    until,
    requests,
    problems,
    close() {
      socket.close();
      kill();
    },
  };
}

// deno-lint-ignore no-explicit-any
type Json = any;

test(
  "in Chromium under /isotsbench/: English first, Portuguese on request and remembered, charts from the dataset, nothing fetched from elsewhere",
  { skip: !chromium && !process.env.CI ? "Chromium not found (set CHROMIUM_PATH)" : false, timeout: 90_000 },
  async () => {
    assert.ok(chromium, "Chromium is required in CI");
    const server = await serveSite(SITE);
    const page = await devtools(chromium.path).catch(async (error) => {
      await server.close();
      throw error;
    });
    const en = JSON.parse(read("i18n/en.json"));
    const pt = JSON.parse(read("i18n/pt-BR.json"));
    const state = async () =>
      JSON.parse(
        await page.evaluate(`JSON.stringify({
          lang: document.documentElement.lang,
          h1: document.querySelector("h1").textContent,
          charts: document.querySelectorAll(".viz-plot svg").length,
          errors: document.querySelectorAll(".viz-error, .load-error").length,
          unresolved: /⟦|\\{\\w+\\}/.test(document.body.innerText),
        })`),
      );
    try {
      await page.send("Page.navigate", { url: server.url });
      await page.until(`document.querySelectorAll(".viz-plot svg").length === 6`, "the English charts");
      assert.deepEqual(await state(), { lang: "en", h1: en.hero.title, charts: 6, errors: 0, unresolved: false });

      await page.evaluate(`document.querySelector('[data-lang="pt-BR"]').click()`);
      await page.until(
        `document.documentElement.lang === "pt-BR" && document.querySelectorAll(".viz-plot svg").length === 6`,
        "Portuguese",
      );
      assert.deepEqual(await state(), { lang: "pt-BR", h1: pt.hero.title, charts: 6, errors: 0, unresolved: false });

      await page.send("Page.reload");
      await page.until(
        `document.documentElement.lang === "pt-BR" && document.querySelectorAll(".viz-plot svg").length === 6`,
        "Portuguese after reload",
      );

      assert.ok(page.requests.includes(`${server.url}data/results.json`), "the charts did not load data/results.json");
      const outside = page.requests.filter((url) => !url.startsWith(server.url) && !/^(about|data):/.test(url));
      assert.deepEqual(outside, []);
      assert.deepEqual(page.problems, []);
    } finally {
      page.close();
      await server.close();
    }
  },
);
