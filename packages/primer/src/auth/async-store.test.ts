import { describe, assert, expect, test } from "vitest";
import { AsyncAuthStore } from "./async-store";

describe("AsyncAuthStore", function () {
  describe("construct()", function () {
    test("load empty initial", async function () {
      let calls: any = [];

      const store = new AsyncAuthStore({
        save: async (payload) => {
          calls.push(payload);
        },
      });

      assert.equal(store.token, "");
      assert.equal(store.record, null);

      const callsPromise = new Promise((resolve, _) => {
        setTimeout(() => resolve(calls), 0);
      });
      await expect(callsPromise).resolves.toStrictEqual([]);
    });

    test("load initial from string", async function () {
      let calls: any = [];

      const store = new AsyncAuthStore({
        save: async (payload) => {
          calls.push(payload);
        },
        initial: `{"token": "test", "record": {"id": "id1"}}`,
      });

      const callsPromise = new Promise((resolve, _) => {
        setTimeout(() => resolve(calls), 0);
      });
      await expect(callsPromise).resolves.toStrictEqual([`{"token":"test","record":{"id":"id1"}}`]);

      assert.equal(store.token, "test");
      assert.deepEqual(store.record, { id: "id1" } as any);
    });

    test("load initial from Promise<string>", async function () {
      let calls: any = [];

      const store = new AsyncAuthStore({
        save: async (payload) => {
          calls.push(payload);
        },
        initial: Promise.resolve(`{"token": "test", "record": {"id": "id1"}}`),
      });

      const callsPromise = new Promise((resolve, _) => {
        setTimeout(() => resolve(calls), 0);
      });
      await expect(callsPromise).resolves.toStrictEqual([`{"token":"test","record":{"id":"id1"}}`]);

      assert.equal(store.token, "test");
      assert.deepEqual(store.record, { id: "id1" } as any);
    });

    test("load initial from Promise<object>", async function () {
      let calls: any = [];

      const store = new AsyncAuthStore({
        save: async (payload) => {
          calls.push(payload);
        },
        initial: Promise.resolve({ token: "test", record: { id: "id1" } }),
      });

      const callsPromise = new Promise((resolve, _) => {
        setTimeout(() => resolve(calls), 0);
      });
      await expect(callsPromise).resolves.toStrictEqual([`{"token":"test","record":{"id":"id1"}}`]);

      assert.equal(store.token, "test");
      assert.deepEqual(store.record, { id: "id1" } as any);
    });
  });

  describe("save()", function () {
    test("trigger saveFunc", async function () {
      let calls: any = [];

      const store = new AsyncAuthStore({
        save: async (payload) => {
          calls.push(payload);
        },
      });

      store.save("test1", { id: "id1" } as any);
      assert.equal(store.token, "test1");
      assert.deepEqual(store.record, { id: "id1" } as any);

      // update
      store.save("test2", { id: "id2" } as any);
      assert.equal(store.token, "test2");
      assert.deepEqual(store.record, { id: "id2" } as any);

      const callsPromise = new Promise((resolve, _) => {
        setTimeout(() => resolve(calls), 0);
      });
      await expect(callsPromise).resolves.toStrictEqual([
        `{"token":"test1","record":{"id":"id1"}}`,
        `{"token":"test2","record":{"id":"id2"}}`,
      ]);
    });
  });

  describe("clear()", function () {
    test("no explicit clearFunc", async function () {
      let calls: any = [];

      const store = new AsyncAuthStore({
        save: async (payload) => {
          calls.push(payload);
        },
      });

      store.save("test", { id: "id1" } as any);
      assert.equal(store.token, "test");
      assert.deepEqual(store.record, { id: "id1" } as any);

      store.clear();
      assert.equal(store.token, "");
      assert.deepEqual(store.record, null);

      const callsPromise = new Promise((resolve, _) => {
        setTimeout(() => resolve(calls), 0);
      });
      await expect(callsPromise).resolves.toStrictEqual([
        `{"token":"test","record":{"id":"id1"}}`,
        "",
      ]);
    });

    test("with explicit clearFunc", async function () {
      let saveCalls: any = [];
      let clearCalls: any = [];

      const store = new AsyncAuthStore({
        save: async (payload) => {
          saveCalls.push(payload);
        },
        clear: async () => {
          clearCalls.push("clear_test");
        },
      });

      store.save("test", { id: "id1" } as any);
      assert.equal(store.token, "test");
      assert.deepEqual(store.record, { id: "id1" } as any);

      store.clear();
      assert.equal(store.token, "");
      assert.deepEqual(store.record, null);

      const savePromise = new Promise((resolve, _) => {
        setTimeout(() => resolve(saveCalls), 0);
      });
      await expect(savePromise).resolves.toStrictEqual([`{"token":"test","record":{"id":"id1"}}`]);

      const clearPromise = new Promise((resolve, _) => {
        setTimeout(() => resolve(clearCalls), 0);
      });
      await expect(clearPromise).resolves.toStrictEqual(["clear_test"]);
    });
  });

  describe("OAuth2 token metadata", function () {
    test("Should persist and load the token metadata", async function () {
      const calls: Array<string> = [];

      const store = new AsyncAuthStore({
        save: async (payload) => {
          calls.push(payload);
        },
        initial: JSON.stringify({
          token: "test1",
          record: { id: "id1" },
          refreshToken: "rt1",
          idToken: "it1",
        }),
      });

      await new Promise((r) => setTimeout(r, 0));

      assert.equal(store.token, "test1");
      assert.equal(store.refreshToken, "rt1");
      assert.equal(store.idToken, "it1");

      store.save("test2", null, { refreshToken: "rt2" });

      await new Promise((r) => setTimeout(r, 0));

      const last = JSON.parse(calls[calls.length - 1]);
      assert.equal(last.token, "test2");
      assert.equal(last.refreshToken, "rt2");
      assert.isUndefined(last.idToken);
    });
  });

  describe("ready / fromStorage()", function () {
    test("ready resolves after the initial state is loaded", async function () {
      let release: (v: string) => void = () => {};
      const initial = new Promise<string>((r) => (release = r));
      const store = new AsyncAuthStore({ save: async () => {}, initial });

      let ready = false;
      store.ready.then(() => (ready = true));
      await Promise.resolve();
      assert.isFalse(ready);
      assert.equal(store.token, "");

      release(JSON.stringify({ token: "t1", record: { id: "r1" }, refreshToken: "rt1" }));
      await store.ready;
      assert.equal(store.token, "t1");
      assert.equal(store.refreshToken, "rt1");
    });

    test("fromStorage() loads, saves and removes the state of an AsyncStorage-like storage", async function () {
      const data = new Map<string, string>();
      const storage = {
        getItem: async (k: string) => data.get(k) ?? null,
        setItem: async (k: string, v: string) => {
          data.set(k, v);
        },
        removeItem: async (k: string) => {
          data.delete(k);
        },
      };

      data.set("app_auth", JSON.stringify({ token: "t0", record: null, idToken: "i0" }));

      const store = AsyncAuthStore.fromStorage(storage, "app_auth");
      await store.ready;
      assert.equal(store.token, "t0");
      assert.equal(store.idToken, "i0");

      store.save("t1", { id: "r1" } as any, { refreshToken: "rt1" });
      await store.flush();
      const restored = AsyncAuthStore.fromStorage(storage, "app_auth");
      await restored.ready;
      assert.equal(restored.token, "t1");
      assert.equal(restored.refreshToken, "rt1");
      assert.equal(restored.record?.id, "r1");
      await restored.flush(); // the loaded state is normalized and saved back

      store.clear();
      await store.flush();
      const cleared = AsyncAuthStore.fromStorage(storage, "app_auth");
      await cleared.ready;
      assert.isFalse(data.has("app_auth"));
      assert.equal(cleared.token, "");
    });

    test("fromStorage() works with a sync storage and the default key", async function () {
      const data = new Map<string, string>();
      const store = AsyncAuthStore.fromStorage({
        getItem: (k) => data.get(k),
        setItem: (k, v) => data.set(k, v),
        removeItem: (k) => data.delete(k),
      });
      await store.ready;
      store.save("t2", null);
      await store.flush();
      await AsyncAuthStore.fromStorage({
        getItem: (k) => data.get(k),
        setItem: () => {},
        removeItem: () => {},
      }).ready;
      assert.include(data.get("pb_auth") || "", "t2");
    });
  });
});
