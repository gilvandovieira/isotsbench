// Serves the built site (build/site/, see `make site`) the way GitHub Pages
// does for this repository: under the /isotsbench/ base path.
//
//   node scripts/serve-site.ts [dir] [--port 8000]

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import process from "node:process";

/** The project-site path GitHub Pages serves this repository under. */
export const BASE = "/isotsbench/";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

export interface SiteServer {
  url: string;
  close(): Promise<void>;
}

export function serveSite(dir: string, port = 0): Promise<SiteServer> {
  const root = normalize(dir);
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    if (!path.startsWith(BASE)) {
      response.writeHead(404).end();
      return;
    }
    let file = normalize(join(root, path.slice(BASE.length)));
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(404).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}${BASE}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf("--port");
  const port = portIndex === -1 ? 8000 : Number(args[portIndex + 1]);
  const dir = args.find((a, i) => !a.startsWith("--") && (portIndex === -1 || i !== portIndex + 1)) ?? "build/site";
  if (!existsSync(join(dir, "index.html"))) {
    console.error(`${dir}/index.html not found; run make site first`);
    process.exit(1);
  }
  const { url } = await serveSite(dir, port);
  console.error(`serving ${dir} at ${url}`);
}
