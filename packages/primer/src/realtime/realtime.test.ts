import { afterEach, assert, beforeEach, describe, test } from "vitest";
import { Client } from "../client";

/** A minimal EventSource double (dispatches the named events to the listeners). */
class FakeEventSource {
  static instances: Array<FakeEventSource> = [];

  url: string;
  closed = false;
  onerror: ((e: any) => void) | null = null;
  listeners = new Map<string, Set<(e: any) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (e: any) => void) {
    if (!this.listeners.has(name)) {
      this.listeners.set(name, new Set());
    }
    this.listeners.get(name)!.add(listener);
  }

  removeEventListener(name: string, listener: (e: any) => void) {
    this.listeners.get(name)?.delete(listener);
  }

  emit(name: string, data: any, lastEventId = "") {
    for (const listener of this.listeners.get(name) || []) {
      listener({ data: JSON.stringify(data), lastEventId });
    }
  }

  listenerCount(name: string): number {
    return this.listeners.get(name)?.size || 0;
  }

  close() {
    this.closed = true;
  }
}

function newClient(options: { publicKey?: string; privateKey?: string } = {}) {
  const submits: Array<{ clientId: string; subscriptions: Array<string> }> = [];
  const client = new Client("http://test.local", {
    ...options,
    fetch: async (url, init: any) => {
      if (String(url) === "http://test.local/api/realtime" && init.method === "POST") {
        submits.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }
      throw new Error("unexpected request " + url);
    },
  });
  return { client, submits };
}

/** Starts a subscription and completes the SSE handshake (PB_CONNECT). */
async function connected<T>(
  subscribe: () => Promise<T>,
): Promise<{ result: T; es: FakeEventSource }> {
  const pending = subscribe();
  // the connection is initialized in a microtask
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  es.emit("PB_CONNECT", { clientId: "c1" }, "c1");
  return { result: await pending, es };
}

describe("RealtimeService", function () {
  beforeEach(function () {
    FakeEventSource.instances = [];
    (globalThis as any).EventSource = FakeEventSource;
  });

  afterEach(function () {
    delete (globalThis as any).EventSource;
  });

  test("subscribe() connects, submits the topics and dispatches the events", async function () {
    const { client, submits } = newClient();
    const received: Array<any> = [];

    const { es } = await connected(() =>
      client.realtime.subscribe("posts/*", (data) => received.push(data)),
    );

    assert.equal(es.url, "http://test.local/api/realtime");
    assert.isTrue(client.realtime.isConnected);
    assert.equal(client.realtime.clientId, "c1");
    assert.deepEqual(submits, [{ clientId: "c1", subscriptions: ["posts/*"] }]);

    es.emit("posts/*", { action: "create", record: { id: "p1" } });
    assert.deepEqual(received, [{ action: "create", record: { id: "p1" } }]);
  });

  test("the public key is sent as pk query parameter (and never the private key)", async function () {
    const pub = newClient({ publicKey: "pb_pk_1" });
    const { es } = await connected(() => pub.client.realtime.subscribe("a", () => {}));
    assert.equal(es.url, "http://test.local/api/realtime?pk=pb_pk_1");

    const priv = newClient({ privateKey: "pb_sk_1" });
    const { es: es2 } = await connected(() => priv.client.realtime.subscribe("a", () => {}));
    assert.equal(es2.url, "http://test.local/api/realtime");
  });

  test("subscribe() serializes the topic options", async function () {
    const { client, submits } = newClient();
    await connected(() =>
      client.realtime.subscribe("posts/*", () => {}, { filter: "a=1", headers: { x: "y" } }),
    );

    const key = submits[0].subscriptions[0];
    assert.isTrue(key.startsWith("posts/*?options="));
    assert.deepEqual(JSON.parse(decodeURIComponent(key.split("options=")[1])), {
      query: { filter: "a=1" },
      headers: { x: "y" },
    });
  });

  test("unsubscribe functions, by topic, by prefix and all (the connection closes without topics)", async function () {
    const { client, submits } = newClient();
    const disconnects: Array<Array<string>> = [];
    client.realtime.onDisconnect = (active) => disconnects.push(active);

    const { result: unsubA1, es } = await connected(() => client.realtime.subscribe("a", () => {}));
    const unsubA2 = await client.realtime.subscribe("a", () => {});
    await client.realtime.subscribe("b/1", () => {});
    await client.realtime.subscribe("b/2", () => {});

    assert.equal(es.listenerCount("a"), 2);
    assert.deepEqual(submits[submits.length - 1].subscriptions, ["a", "b/1", "b/2"]);

    await unsubA1();
    assert.equal(es.listenerCount("a"), 1, "only that listener is removed");
    await unsubA2();
    assert.deepEqual(submits[submits.length - 1].subscriptions, ["b/1", "b/2"]);

    await client.realtime.unsubscribeByPrefix("b/1");
    assert.deepEqual(submits[submits.length - 1].subscriptions, ["b/2"]);

    await client.realtime.unsubscribe("b/2");
    assert.isTrue(es.closed, "no subscriptions -> disconnected");
    assert.isFalse(client.realtime.isConnected);
    assert.deepEqual(disconnects, [[]]);

    // unsubscribe all
    const { es: es2 } = await connected(() => client.realtime.subscribe("c", () => {}));
    await client.realtime.unsubscribe();
    assert.isTrue(es2.closed);
  });

  test("the record service subscriptions are scoped by the collection", async function () {
    const { client, submits } = newClient();
    const received: Array<any> = [];

    const { es } = await connected(() =>
      client.collection("posts").subscribe("*", (e) => received.push(e.action)),
    );
    await client.collection("posts").subscribe("r1", () => {});
    await client.collection("other").subscribe("*", () => {});
    assert.deepEqual(submits[submits.length - 1].subscriptions, ["posts/*", "posts/r1", "other/*"]);

    es.emit("posts/*", { action: "update", record: {} });
    assert.deepEqual(received, ["update"]);

    await client.collection("posts").unsubscribe("r1");
    assert.deepEqual(submits[submits.length - 1].subscriptions, ["posts/*", "other/*"]);

    await client.collection("posts").unsubscribe();
    assert.deepEqual(submits[submits.length - 1].subscriptions, ["other/*"]);
  });

  test("subscribe() rejects a missing topic and a failed connection", async function () {
    const { client } = newClient();
    let err: any = await client.realtime.subscribe("", () => {}).catch((e) => e);
    assert.match(err.message, /topic/);

    const pending = client.realtime.subscribe("a", () => {});
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    FakeEventSource.instances[0].onerror?.({});
    err = await pending.catch((e) => e);
    assert.equal(err.name, "ClientResponseError 0");
    assert.match(err.originalError.message, /realtime connection/);
    assert.isFalse(client.realtime.isConnected);
  });
});
