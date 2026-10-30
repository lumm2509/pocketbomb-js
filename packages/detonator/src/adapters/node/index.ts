// pocketbomb-detonator/adapters/node
//
// Node.js http adapter: converts the IncomingMessage to a Fetch Request and writes a Fetch Response
// (the detonator server toolkit works with the Fetch API on every runtime).
import type http from "node:http";
import { Readable } from "node:stream";

/**
 * Converts a Node.js request to a Fetch API `Request` (the body is streamed).
 */
export function toRequest(req: http.IncomingMessage, origin?: string): Request {
  const base = origin || "http://" + (req.headers.host || "localhost");
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  return new Request(new URL(req.url || "/", base), {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // @ts-expect-error (Node.js streaming request bodies)
    duplex: hasBody ? "half" : undefined,
  });
}

/**
 * Writes a Fetch API `Response` to a Node.js response (the Set-Cookie headers are kept separate).
 */
export async function sendResponse(res: http.ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | Array<string>> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) {
    headers["set-cookie"] = cookies;
  }

  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    res.write(chunk);
  }
  res.end();
}

/**
 * Returns a Node.js request listener of a Fetch API handler (errors -> 500).
 */
export function createRequestListener(
  handler: (request: Request, req: http.IncomingMessage) => Response | Promise<Response>,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    Promise.resolve()
      .then(() => handler(toRequest(req), req))
      .then((response) => sendResponse(res, response))
      .catch((err) => {
        console.error(err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
        }
        res.end("Internal Server Error");
      });
  };
}
