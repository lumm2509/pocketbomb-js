import http from "node:http";
import type net from "node:net";
import { afterEach, assert, describe, test } from "vitest";
import { createRequestListener, sendResponse, toRequest } from "./index";

let server: http.Server | null = null;

afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(null)));
  server = null;
});

async function listen(listener: http.RequestListener): Promise<string> {
  server = http.createServer(listener);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return "http://127.0.0.1:" + (server!.address() as net.AddressInfo).port;
}

describe("node adapter", function () {
  test("createRequestListener(): Request (method, url, headers, streamed body) -> Response (status, headers, cookies, body)", async function () {
    const url = await listen(
      createRequestListener(async (request) => {
        const headers = new Headers({ "x-method": request.method, "x-url": request.url });
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "b=2; Path=/");
        return new Response(
          JSON.stringify({ body: await request.text(), header: request.headers.get("x-test") }),
          { status: 201, headers },
        );
      }),
    );

    const res = await fetch(url + "/install?x=1", {
      method: "POST",
      headers: { "x-test": "t" },
      body: "jwt.body",
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("x-method"), "POST");
    assert.equal(res.headers.get("x-url"), url + "/install?x=1");
    assert.deepEqual(res.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
    assert.deepEqual(await res.json(), { body: "jwt.body", header: "t" });

    const get = await fetch(url + "/");
    assert.equal(get.status, 201);
    assert.deepEqual(await get.json(), { body: "", header: null });
  });

  test("handler errors -> 500; null body responses", async function () {
    const url = await listen(
      createRequestListener((request) => {
        if (request.url.endsWith("/boom")) throw new Error("boom");
        return new Response(null, { status: 204 });
      }),
    );

    const original = console.error;
    console.error = () => {};
    try {
      const res = await fetch(url + "/boom");
      assert.equal(res.status, 500);
      assert.equal(await res.text(), "Internal Server Error");
    } finally {
      console.error = original;
    }

    assert.equal((await fetch(url + "/ok")).status, 204);
  });

  test("toRequest() with an explicit origin and sendResponse()", async function () {
    const url = await listen((req, res) => {
      const request = toRequest(req, "https://app.example.com");
      void sendResponse(res, new Response(request.url, { status: 200 }));
    });
    assert.equal(await (await fetch(url + "/a?b=1")).text(), "https://app.example.com/a?b=1");
  });
});
