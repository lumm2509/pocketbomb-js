// Test helpers (not part of the package entries).

export interface RecordedRequest {
  url: string;
  method: string;
  headers: { [key: string]: string };
  body: any;
}

export type MockHandler = (req: RecordedRequest) => { status?: number; body?: any } | undefined;

/**
 * Returns a fetch function that records the requests and replies with the first handler result.
 */
export function mockFetch(...handlers: Array<MockHandler>) {
  const requests: Array<RecordedRequest> = [];

  const fetchFunc = async (input: RequestInfo | URL, init: any = {}): Promise<Response> => {
    const req: RecordedRequest = {
      url: String(input),
      method: init.method || "GET",
      headers: Object.assign({}, init.headers),
      body: init.body,
    };
    requests.push(req);

    for (const handler of handlers) {
      const result = handler(req);
      if (result) {
        const status = result.status || 200;
        if (status === 204) {
          return new Response(null, { status });
        }

        return new Response(JSON.stringify(result.body ?? {}), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
    }

    throw new Error("Request not mocked: " + req.method + " " + req.url);
  };

  return { fetch: fetchFunc as typeof fetch, requests };
}

export function dummyJWT(payload: { [key: string]: any } = {}): string {
  return (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    Buffer.from(JSON.stringify(payload)).toString("base64url") +
    ".sig"
  );
}

export function form(body: any): URLSearchParams {
  return new URLSearchParams(typeof body === "string" ? body : "");
}
