// The storefront Node.js server: React Router SSR with the PocketBomb request context
// (buyer IP, httpOnly cookie session, cache) of every request.
//
//   NODE_ENV=production node server.ts   # serves build/ (react-router build)
//   node server.ts                         # dev: Vite in middleware mode (`dynamite dev` starts fuse)
//
// Env: PORT (3000), HOST (localhost), POCKETBOMB_URL, POCKETBOMB_PUBLIC_KEY,
//      POCKETBOMB_PRIVATE_KEY (server-only), POCKETBOMB_CLIENT_ID, TRUST_PROXY=1 (use x-forwarded-for)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { getBuyerIp } from "@pocketbomb/dynamite";
import { createRequestHandler, type ServerBuild } from "react-router";
import { createAppContext } from "./app/lib/context.server.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === "production";
const port = parseInt(process.env.PORT || "3000", 10);
const host = process.env.HOST || "localhost";

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
};

type Next = (err?: unknown) => void;
type Middleware = (req: http.IncomingMessage, res: http.ServerResponse, next: Next) => void;

let getBuild: () => Promise<ServerBuild>;
let middleware: Middleware;

if (production) {
  const build = (await import(path.join(root, "build/server/index.js"))) as unknown as ServerBuild;
  getBuild = async () => build;

  const clientDir = path.join(root, "build/client");
  middleware = (req, res, next) => {
    const pathname = decodeURIComponent(new URL(req.url || "/", "http://x").pathname);
    const file = path.join(clientDir, pathname);
    if (
      !file.startsWith(clientDir + path.sep) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile()
    ) {
      return next();
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300",
    });
    fs.createReadStream(file).pipe(res);
  };
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: "custom" });
  getBuild = () =>
    vite.ssrLoadModule("virtual:react-router/server-build") as unknown as Promise<ServerBuild>;
  middleware = vite.middlewares as unknown as Middleware;
}

const handler = (build: ServerBuild) =>
  createRequestHandler(build, production ? "production" : "development");

function toRequest(req: http.IncomingMessage): Request {
  const origin = "http://" + (req.headers.host || host + ":" + port);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL(req.url || "/", origin), {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // @ts-expect-error (Node.js streaming request bodies)
    duplex: hasBody ? "half" : undefined,
  });
}

async function sendResponse(res: http.ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | Array<string>> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;

  res.writeHead(response.status, response.statusText, headers);
  if (!response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    res.write(chunk);
  }
  res.end();
}

const server = http.createServer((req, res) => {
  middleware(req, res, async (err) => {
    if (err) {
      res.writeHead(500).end(String(err));
      return;
    }

    try {
      const request = toRequest(req);
      const buyerIp = process.env.TRUST_PROXY
        ? getBuyerIp(request, { buyerIpHeader: "x-forwarded-for" })
        : req.socket.remoteAddress || "";
      const context = createAppContext(request, buyerIp);

      const response = await handler(await getBuild())(request, context);
      // the session cookies (login state, tokens, refresh rotation) + private caching
      context.requestContext.applyResponseHeaders(response.headers);

      await sendResponse(res, response);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      res.end("Internal Server Error");
    }
  });
});

server.listen(port, host, () => {
  console.log(`Storefront running on http://${host}:${port}`);
});
