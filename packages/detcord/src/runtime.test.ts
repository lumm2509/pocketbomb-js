import { afterEach, assert, beforeEach, describe, test, vi } from "vitest";
import { detcordScript, installDetcord } from "./index";

const ORIGIN = "https://dashboard.example.com";

/** A fake embedded window with a recording parent. */
function fakeWindow(href = "https://app.example.com/app?a=1") {
  const parentMessages: Array<{ message: any; origin: string }> = [];
  const parent = {
    postMessage: (message: any, origin: string) => parentMessages.push({ message, origin }),
  };

  const handlers: Record<string, Array<Function>> = {};
  const location = {
    href,
    origin: new URL(href).origin,
    assign: vi.fn(),
  };

  const win: any = {
    parent,
    location,
    Date,
    Request,
    history: {
      state: null,
      pushState(_s: any, _t: string, url: string) {
        location.href = new URL(url, location.href).href;
      },
      replaceState(_s: any, _t: string, url: string) {
        location.href = new URL(url, location.href).href;
      },
    },
    addEventListener(type: string, fn: Function) {
      (handlers[type] = handlers[type] || []).push(fn);
    },
    fetch: vi.fn(async (req: Request) => new Response("ok", { status: 200, headers: req.headers })),
  };

  const dispatch = (data: any, origin = ORIGIN, source: any = parent) => {
    for (const fn of handlers.message || []) {
      fn({ data, origin, source });
    }
  };

  const init = (payload: any = {}) =>
    dispatch({
      source: "detcord",
      type: "init",
      payload: { handle: "h", extension: "home", ...payload },
    });

  return { win, parent, parentMessages, dispatch, init, location };
}

function respondTokens(fake: ReturnType<typeof fakeWindow>, token: string, expiresIn = 60) {
  const last = fake.parentMessages.filter((m) => m.message.type === "idToken").at(-1);
  fake.dispatch({
    source: "detcord",
    type: "response",
    id: last!.message.id,
    result: { token, expiresIn },
  });
}

async function nextMicrotask() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("installDetcord()", function () {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "Date", "setTimeout", "clearTimeout"],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the script form is self-contained", function () {
    assert.include(detcordScript, "detcord");
    assert.notInclude(detcordScript, "</script");
    const fake = fakeWindow();
    new Function("window", detcordScript)(fake.win);
    assert.isTrue(fake.win.detcord.embedded);
  });

  test("not embedded: no handshake, no token and no fetch patch", async function () {
    const fake = fakeWindow();
    fake.win.parent = fake.win;
    const nativeFetch = fake.win.fetch;

    const detcord = installDetcord(fake.win);

    assert.isFalse(detcord.embedded);
    assert.equal(fake.win.fetch, nativeFetch);
    assert.lengthOf(fake.parentMessages, 0);
    await detcord.idToken().then(
      () => assert.fail("expected a rejection"),
      (err) => assert.include(err.message, "isn't embedded"),
    );
  });

  test("the id_token is stripped from the url and not reported", function () {
    const fake = fakeWindow("https://app.example.com/app?id_token=SECRET&issuer=x&a=1");
    installDetcord(fake.win);
    assert.notInclude(fake.location.href, "id_token");

    fake.init();
    const reported = fake.parentMessages.find((m) => m.message.type === "navigation.changed");
    assert.equal(reported?.message.payload.path, "/app?a=1");
    assert.equal(reported?.origin, ORIGIN);
  });

  test("handshake: only hello goes to '*' and then the exact parent origin", async function () {
    const fake = fakeWindow();
    const detcord = installDetcord(fake.win);

    assert.deepEqual(fake.parentMessages[0], {
      message: { source: "detcord", type: "hello" },
      origin: "*",
    });

    // before the handshake nothing else is sent
    detcord.toast.show("early");
    assert.lengthOf(fake.parentMessages, 1);

    fake.init({ record: { collection: "posts", id: "r1" } });
    await detcord.ready;
    assert.deepEqual(detcord.record, { collection: "posts", id: "r1" });

    fake.parentMessages.length = 0;
    detcord.toast.show("hi");
    detcord.titleBar.set("T");
    detcord.resize(100);
    detcord.modal.open({ id: "m", title: "x" });
    detcord.modal.close();
    assert.deepEqual(
      fake.parentMessages.map((m) => [m.message.type, m.origin]),
      ["toast.show", "titleBar.set", "resize", "modal.open", "modal.close"].map((t) => [t, ORIGIN]),
    );

    // stops repeating
    fake.parentMessages.length = 0;
    vi.advanceTimersByTime(2000);
    assert.lengthOf(fake.parentMessages, 0);
  });

  test("forged messages are ignored (other origin, other source, before the handshake)", async function () {
    const fake = fakeWindow();
    const detcord = installDetcord(fake.win);

    // not the parent window
    fake.dispatch(
      { source: "detcord", type: "init", payload: { record: { collection: "x", id: "evil" } } },
      ORIGIN,
      {},
    );
    assert.isNull(detcord.record);

    fake.init();

    const promise = detcord.idToken();
    await nextMicrotask();

    const id = fake.parentMessages.filter((m) => m.message.type === "idToken").at(-1)!.message.id;

    // another origin
    fake.dispatch(
      { source: "detcord", type: "response", id, result: { token: "forged", expiresIn: 60 } },
      "https://evil.example.com",
    );
    // another source
    fake.dispatch(
      { source: "detcord", type: "response", id, result: { token: "forged", expiresIn: 60 } },
      ORIGIN,
      {},
    );
    // a navigation from another origin
    fake.dispatch(
      { source: "detcord", type: "navigation.navigate", payload: { path: "/evil" } },
      "https://evil.example.com",
    );
    assert.equal(fake.location.assign.mock.calls.length, 0);

    respondTokens(fake, "valid");
    assert.equal(await promise, "valid");
  });

  test("idToken(): cached and renewed before it expires (injected clock)", async function () {
    const fake = fakeWindow();
    const detcord = installDetcord(fake.win);
    fake.init();

    const first = detcord.idToken();
    await nextMicrotask();
    respondTokens(fake, "t1");
    assert.equal(await first, "t1");

    // the same token inside of its lifetime (reusable until it expires), concurrent requests share one
    vi.advanceTimersByTime(30000);
    assert.equal(await detcord.idToken(), "t1");
    assert.lengthOf(
      fake.parentMessages.filter((m) => m.message.type === "idToken"),
      1,
    );

    vi.advanceTimersByTime(31000);
    const second = detcord.idToken();
    const concurrent = detcord.idToken();
    await nextMicrotask();
    assert.lengthOf(
      fake.parentMessages.filter((m) => m.message.type === "idToken"),
      2,
    );
    respondTokens(fake, "t2");
    assert.equal(await second, "t2");
    assert.equal(await concurrent, "t2");
  });

  test("idToken(): the host errors reject", async function () {
    const fake = fakeWindow();
    const detcord = installDetcord(fake.win);
    fake.init();

    const promise = detcord.idToken();
    await nextMicrotask();
    const id = fake.parentMessages.filter((m) => m.message.type === "idToken").at(-1)!.message.id;
    fake.dispatch({ source: "detcord", type: "response", id, error: "nope" });

    await promise.then(
      () => assert.fail("expected a rejection"),
      (err) => assert.equal(err.message, "nope"),
    );
  });

  test("fetch: bearer only on the same origin requests, retry on x-detcord-reauthorize", async function () {
    const fake = fakeWindow();
    const native = fake.win.fetch;
    const detcord = installDetcord(fake.win);
    fake.init();

    // a pre-filled token
    const pre = detcord.idToken();
    await nextMicrotask();
    respondTokens(fake, "t1");
    await pre;

    await fake.win.fetch("https://other.example.com/x");
    assert.equal(String(native.mock.calls[0][0]), "https://other.example.com/x");
    assert.isUndefined(native.mock.calls[0][1]);

    await fake.win.fetch("/data");
    assert.equal(native.mock.calls[1][0].headers.get("authorization"), "Bearer t1");

    await fake.win.fetch("/explicit", { headers: { authorization: "Bearer mine" } });
    assert.equal(native.mock.calls[2][0].headers.get("authorization"), "Bearer mine");

    native.mockImplementationOnce(
      async () => new Response("", { status: 401, headers: { "x-detcord-reauthorize": "1" } }),
    );
    const retried = fake.win.fetch("/retry", { method: "POST", body: "payload" });
    for (let i = 0; i < 10; i++) {
      await nextMicrotask();
    }
    respondTokens(fake, "t2");
    const response = await retried;
    assert.equal(response.status, 200);
    const lastRequest = native.mock.calls.at(-1)[0];
    assert.equal(lastRequest.headers.get("authorization"), "Bearer t2");
    assert.equal(await lastRequest.text(), "payload");
  });

  test("fetch: one retry only, then the host is told that the session has ended; other 401s aren't retried", async function () {
    const fake = fakeWindow();
    const native = fake.win.fetch;
    const detcord = installDetcord(fake.win);
    fake.init();

    const pre = detcord.idToken();
    await nextMicrotask();
    respondTokens(fake, "t1");
    await pre;

    // a plain 401 isn't retried
    native.mockImplementationOnce(async () => new Response("", { status: 401 }));
    assert.equal((await fake.win.fetch("/plain")).status, 401);
    assert.equal(native.mock.calls.length, 1);
    assert.lengthOf(
      fake.parentMessages.filter((m) => m.message.type === "session.ended"),
      0,
    );

    native.mockReset();
    native.mockImplementation(
      async () => new Response("", { status: 401, headers: { "x-detcord-reauthorize": "1" } }),
    );

    const ended = fake.win.fetch("/ended");
    for (let i = 0; i < 10; i++) {
      await nextMicrotask();
    }
    respondTokens(fake, "t2");
    const response = await ended;

    assert.equal(response.status, 401);
    assert.equal(native.mock.calls.length, 2, "exactly one retry");
    assert.lengthOf(
      fake.parentMessages.filter((m) => m.message.type === "session.ended"),
      1,
    );
  });

  test("navigation: listeners, document fallback and the hash sync", async function () {
    const fake = fakeWindow();
    const detcord = installDetcord(fake.win);
    fake.init();
    fake.parentMessages.length = 0;

    detcord.navigation.navigate("/doc");
    assert.equal(fake.location.assign.mock.calls[0][0], "/doc");

    const seen: Array<string> = [];
    const remove = detcord.navigation.onChange((p) => seen.push(p));
    detcord.navigation.navigate("/spa");
    fake.dispatch({
      source: "detcord",
      type: "navigation.navigate",
      payload: { path: "/from-host" },
    });
    assert.deepEqual(seen, ["/spa", "/from-host"]);
    remove();

    // the router history changes are reported (without the hidden params)
    fake.win.history.pushState(null, "", "/next?id_token=x&b=2");
    const last = fake.parentMessages.at(-1)!;
    assert.equal(last.message.type, "navigation.changed");
    assert.equal(last.message.payload.path, "/next?b=2");
  });
});
