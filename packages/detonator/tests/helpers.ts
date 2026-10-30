import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { FuseOptions } from "@pocketbomb/fuse/node";

/**
 * The fuse options of the monorepo ($POCKETBOMB_BIN, $POCKETBOMB_SRC or ../pocketbase next to it).
 */
export function fuseOptions(extra: FuseOptions = {}): FuseOptions {
  if (process.env.POCKETBOMB_BIN || process.env.POCKETBOMB_SRC) {
    return extra;
  }
  return { ...extra, src: path.resolve(__dirname, "../../../../pocketbase") };
}

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * A local HTTP receiver (application backend mock) recording the requests.
 */
export class Receiver {
  server: http.Server;
  url = "";
  requests: Array<ReceivedRequest> = [];
  handler: (req: ReceivedRequest) => Promise<{ status: number; body?: string }> = async () => ({
    status: 200,
    body: "ok",
  });
  private waiters: Array<{
    match: (r: ReceivedRequest) => boolean;
    resolve: Function;
  }> = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Array<Buffer> = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const received: ReceivedRequest = {
          method: req.method || "",
          path: req.url || "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        this.requests.push(received);

        let result: { status: number; body?: string } = {
          status: 500,
          body: "handler error",
        };
        try {
          result = await this.handler(received);
        } catch (err: any) {
          result = { status: 500, body: String(err?.message || err) };
        }

        res.writeHead(result.status);
        res.end(result.body || "");

        for (const w of this.waiters.slice()) {
          if (w.match(received)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.resolve(received);
          }
        }
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = "http://127.0.0.1:" + (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server.close(resolve));
  }

  /**
   * Resolves with the first (already received or future) request matching `match`.
   */
  waitFor(match: (r: ReceivedRequest) => boolean, timeout = 15000): Promise<ReceivedRequest> {
    const existing = this.requests.find(match);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("receiver wait timeout")), timeout);
      this.waiters.push({
        match,
        resolve: (r: ReceivedRequest) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
    });
  }
}
