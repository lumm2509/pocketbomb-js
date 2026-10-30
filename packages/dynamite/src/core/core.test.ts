import { CookieAuthStore } from "@pocketbomb/primer";
import { assert, describe, test, vi } from "vitest";
import { dummyJWT } from "../test-utils";
import { DEFAULT_BUYER_IP_HEADERS, getBuyerIp } from "./buyer-ip";
import { Cache, MemoryCache, sha256Hex, withCache } from "./cache";
import { createRequestContext } from "./request-context";

function req(headers: { [key: string]: string } = {}, url = "http://app.local/x"): Request {
  return new Request(url, { headers });
}

describe("getBuyerIp()", function () {
  test("default headers in order", function () {
    assert.deepEqual(
      [...DEFAULT_BUYER_IP_HEADERS],
      ["cf-connecting-ip", "true-client-ip", "fly-client-ip", "x-real-ip", "x-forwarded-for"],
    );
    assert.equal(getBuyerIp(req()), "");
    assert.equal(getBuyerIp(req({ "x-forwarded-for": "1.1.1.1, 10.0.0.1" })), "1.1.1.1");
    assert.equal(
      getBuyerIp(req({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "1.1.1.1" })),
      "2.2.2.2",
    );
    assert.equal(
      getBuyerIp(req({ "cf-connecting-ip": "3.3.3.3", "x-real-ip": "2.2.2.2" })),
      "3.3.3.3",
    );
    assert.equal(getBuyerIp(req({ "x-forwarded-for": " , " })), "");
  });

  test("configured header only", function () {
    const request = req({ "cf-connecting-ip": "3.3.3.3", "x-client-ip": "4.4.4.4" });
    assert.equal(getBuyerIp(request, { buyerIpHeader: "x-client-ip" }), "4.4.4.4");
    assert.equal(getBuyerIp(req({ "cf-connecting-ip": "3.3.3.3" }), { buyerIpHeader: "x-a" }), "");
  });
});

describe("cache", function () {
  test("Cache presets", function () {
    assert.deepEqual(Cache.none(), { mode: "no-store" });
    assert.deepEqual(Cache.short(), { mode: "public", maxAge: 1, staleWhileRevalidate: 9 });
    assert.deepEqual(Cache.long(), { mode: "public", maxAge: 3600, staleWhileRevalidate: 82800 });
    assert.deepEqual(Cache.custom({ maxAge: 5 }), {
      mode: "public",
      maxAge: 5,
      staleWhileRevalidate: 0,
    });
  });

  test("MemoryCache get/set/delete, expiry and LRU eviction", function () {
    const cache = new MemoryCache(2);
    const future = Date.now() + 60000;

    cache.set("a", { value: 1, freshUntil: future, staleUntil: future });
    cache.set("b", { value: 2, freshUntil: future, staleUntil: future });
    assert.equal(cache.get("a")?.value, 1); // "a" becomes the most recently used
    cache.set("c", { value: 3, freshUntil: future, staleUntil: future });

    assert.equal(cache.size, 2);
    assert.isUndefined(cache.get("b"), "the least recently used entry is evicted");
    assert.equal(cache.get("c")?.value, 3);

    cache.delete("c");
    assert.isUndefined(cache.get("c"));

    cache.set("old", { value: 0, freshUntil: Date.now() - 2, staleUntil: Date.now() - 1 });
    assert.isUndefined(cache.get("old"));
    assert.equal(cache.size, 1);
  });

  test("withCache() without a store or with no-store calls fn every time", async function () {
    const fn = vi.fn(async () => "v");
    assert.equal(await withCache({ key: "k", strategy: Cache.long() }, fn), "v");
    assert.equal(
      await withCache({ key: "k", cache: new MemoryCache(), strategy: Cache.none() }, fn),
      "v",
    );
    assert.equal(await withCache({ key: "k", cache: new MemoryCache() }, fn), "v");
    assert.equal(fn.mock.calls.length, 3);
  });

  test("withCache() fresh hit, stale-while-revalidate and miss", async function () {
    vi.useFakeTimers();
    try {
      const cache = new MemoryCache();
      let n = 0;
      const fn = async () => ++n;
      const background: Array<Promise<unknown>> = [];
      const opts = {
        cache,
        key: "k",
        strategy: Cache.custom({ maxAge: 10, staleWhileRevalidate: 10 }),
        waitUntil: (p: Promise<unknown>) => background.push(p),
      };

      assert.equal(await withCache(opts, fn), 1, "miss -> loaded");
      assert.equal(await withCache(opts, fn), 1, "fresh hit");

      vi.advanceTimersByTime(15000);
      let release: () => void = () => {};
      const slow = async () => {
        await new Promise<void>((r) => (release = r));
        return ++n;
      };
      assert.equal(await withCache(opts, slow), 1, "stale entry served");
      assert.equal(await withCache(opts, slow), 1, "still stale while revalidating");
      assert.lengthOf(background, 1, "a single revalidation");
      release();
      await Promise.all(background);
      assert.equal(await withCache(opts, fn), 2, "revalidated entry");

      vi.advanceTimersByTime(25000);
      assert.equal(await withCache(opts, fn), 3, "expired -> loaded again");
    } finally {
      vi.useRealTimers();
    }
  });

  test("withCache() keeps the stale entry when the revalidation fails and honors shouldCache", async function () {
    vi.useFakeTimers();
    try {
      const cache = new MemoryCache();
      const background: Array<Promise<unknown>> = [];
      const opts = {
        cache,
        key: "k",
        strategy: Cache.custom({ maxAge: 1, staleWhileRevalidate: 60 }),
        waitUntil: (p: Promise<unknown>) => background.push(p),
      };
      await withCache(opts, async () => "first");

      vi.advanceTimersByTime(2000);
      const failing = vi.fn(async () => {
        throw new Error("down");
      });
      assert.equal(await withCache(opts, failing), "first");
      await Promise.all(background);
      assert.equal(failing.mock.calls.length, 1);
      assert.equal(cache.get("k")?.value, "first");

      const skip = { ...opts, key: "skip", shouldCache: (v: string) => v !== "bad" };
      assert.equal(await withCache(skip, async () => "bad"), "bad");
      assert.isUndefined(cache.get("skip"));
    } finally {
      vi.useRealTimers();
    }
  });

  test("sha256Hex()", async function () {
    assert.equal(
      await sha256Hex("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("createRequestContext()", function () {
  test("derives the buyer IP and loads the cookie session", function () {
    const token = dummyJWT({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const cookie = "pb_auth=" + encodeURIComponent(JSON.stringify({ token, record: { id: "u1" } }));

    const controller = new AbortController();
    const request = new Request("http://app.local/", {
      headers: { cookie, "x-forwarded-for": "9.9.9.9" },
      signal: controller.signal,
    });
    const cache = new MemoryCache();
    const waitUntil = () => {};

    const ctx = createRequestContext({ request, cache, waitUntil });

    assert.equal(ctx.buyerIp, "9.9.9.9");
    assert.instanceOf(ctx.session, CookieAuthStore);
    assert.equal(ctx.session.token, token);
    assert.equal(ctx.session.record?.id, "u1");
    assert.equal(ctx.cache, cache);
    assert.equal(ctx.waitUntil, waitUntil);
    assert.equal(ctx.signal, request.signal);

    // explicit buyer IP and header
    assert.equal(createRequestContext({ request, buyerIp: "1.2.3.4" }).buyerIp, "1.2.3.4");
    assert.equal(createRequestContext({ request, buyerIpHeader: "x-none" }).buyerIp, "");
  });

  test("applyResponseHeaders() commits the session cookies and marks the response private", function () {
    const ctx = createRequestContext({ request: req(), session: { key: "shop_session" } });

    const untouched = new Headers();
    ctx.applyResponseHeaders(untouched);
    assert.isNull(untouched.get("set-cookie"));
    assert.isNull(untouched.get("cache-control"));

    ctx.session.save(dummyJWT({ exp: Math.floor(Date.now() / 1000) + 60 }), null);
    const changed = new Headers();
    ctx.applyResponseHeaders(changed);
    assert.include(changed.get("set-cookie") || "", "shop_session=");
    assert.include(changed.get("set-cookie") || "", "HttpOnly");
    assert.include(changed.get("set-cookie") || "", "SameSite=Lax");
    assert.equal(changed.get("cache-control"), "private, no-store, max-age=0, must-revalidate");

    // committed only once
    const again = new Headers();
    ctx.applyResponseHeaders(again);
    assert.isNull(again.get("set-cookie"));

    const personalized = createRequestContext({ request: req() });
    personalized.markPersonalized();
    const headers = new Headers();
    personalized.applyResponseHeaders(headers);
    assert.equal(headers.get("cache-control"), "private, no-store, max-age=0, must-revalidate");
  });
});
