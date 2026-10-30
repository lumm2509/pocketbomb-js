// The application Node.js server (React Router SSR).
//
//   NODE_ENV=production node --env-file-if-exists=.env server.ts   # serves build/
//   node server.ts                                                  # dev (Vite middleware; `detonator dev`)
//
// Env: PORT (3000), HOST (localhost), APP_URL, POCKETBOMB_APP_HANDLE, DETONATOR_DB and the custom
// app credentials (POCKETBOMB_URL, POCKETBOMB_CLIENT_ID, POCKETBOMB_CLIENT_SECRET, ...)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequestListener } from "@pocketbomb/detonator/adapters/node";
import { createRequestHandler, type ServerBuild } from "react-router";
import { ReauthorizeHeader } from "@pocketbomb/detonator/server";
import { addDocumentResponseHeaders, handleEmbeddedRequest } from "./app/detonator.server.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === "production";
const port = parseInt(process.env.PORT || "3000", 10);
const host = process.env.HOST || "localhost";

type Next = (err?: unknown) => void;
type Middleware = (req: http.IncomingMessage, res: http.ServerResponse, next: Next) => void;

let getBuild: () => Promise<ServerBuild>;
let middleware: Middleware;

if (production) {
  const build = (await import(path.join(root, "build/server/index.js"))) as unknown as ServerBuild;
  getBuild = async () => build;

  const clientDir = path.join(root, "build/client");
  const types: Record<string, string> = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".ico": "image/x-icon",
  };
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
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  };
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: "custom" });
  getBuild = () =>
    vite.ssrLoadModule("virtual:react-router/server-build") as unknown as Promise<ServerBuild>;
  middleware = vite.middlewares as unknown as Middleware;
}

const listener = createRequestListener(async (request) => {
  // the launches (cross-site form POSTs authenticated by the signed single use launch token) and
  // the requests without a session token (session token bounce), before the router
  const early = await handleEmbeddedRequest(request);
  if (early) {
    return early;
  }

  const response = await createRequestHandler(
    await getBuild(),
    production ? "production" : "development",
  )(request);

  // the framework keeps the status of the Response thrown by the online admin client
  // (an ended session), not its headers: detcord needs the header to ask for a new token
  if (response.status === 401) {
    response.headers.set(ReauthorizeHeader, "1");
  }

  if (response.headers.get("content-type")?.includes("text/html")) {
    await addDocumentResponseHeaders(request, response.headers);
  }

  return response;
});

const server = http.createServer((req, res) => {
  middleware(req, res, (err) => {
    if (err) {
      res.writeHead(500).end(String(err));
      return;
    }
    listener(req, res);
  });
});

server.listen(port, host, () => {
  console.log(`App running on http://${host}:${port}`);
});
