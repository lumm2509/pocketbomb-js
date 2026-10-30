import { describe, assert, test, beforeAll, afterAll, afterEach } from "vitest";
import { FetchMock } from "./test-utils/mocks";
import {
  attachAccount,
  createAccountClient,
  createPublicClient,
  defaultAccountAuthStore,
} from "./factories";
import { Client } from "./client";
import { AuthStore } from "./auth/store";
import { LocalAuthStore } from "./auth/local-store";

const base = "http://test.local";

function withFakeDocument(fn: () => void) {
  (globalThis as any).document = {};
  try {
    fn();
  } finally {
    delete (globalThis as any).document;
  }
}

describe("factories", function () {
  const fetchMock = new FetchMock();

  beforeAll(function () {
    fetchMock.init();
  });

  afterAll(function () {
    fetchMock.restore();
  });

  afterEach(function () {
    fetchMock.clearMocks();
  });

  describe("createPublicClient()", function () {
    test("public key", function () {
      const pb = createPublicClient({ url: base, publicKey: "pb_pk_1" });

      assert.equal(pb.publicKey, "pb_pk_1");
      assert.equal(pb.privateKey, "");
      assert.isNull(pb.authStrategy);
    });

    test("private key requires the buyer IP or buyerContext none", function () {
      assert.throws(() => createPublicClient({ url: base, privateKey: "pb_sk_1" }), /buyerIp/);

      const withIp = createPublicClient({
        url: base,
        privateKey: "pb_sk_1",
        buyerIp: "1.2.3.4",
      });
      assert.equal(withIp.privateKey, "pb_sk_1");
      assert.equal(withIp.buyerIp, "1.2.3.4");

      const job = createPublicClient({
        url: base,
        privateKey: "pb_sk_1",
        buyerContext: "none",
      });
      assert.equal(job.buyerIp, "");
    });

    test("requires a key", function () {
      assert.throws(() => createPublicClient({ url: base } as any), /publicKey/);
    });

    test("private key throws in browsers unless dangerouslyAllowBrowser", function () {
      withFakeDocument(() => {
        assert.throws(
          () =>
            createPublicClient({
              url: base,
              privateKey: "pb_sk_1",
              buyerContext: "none",
            }),
          /browser/,
        );

        // the public keys are browser-safe
        createPublicClient({ url: base, publicKey: "pb_pk_1" });

        createPublicClient({
          url: base,
          privateKey: "pb_sk_1",
          buyerContext: "none",
          dangerouslyAllowBrowser: true,
        });
      });
    });
  });

  describe("createAccountClient()", function () {
    test("Should configure the account service and strategy", function () {
      const pb = createAccountClient({
        url: base,
        collection: "users",
        clientId: "app",
        redirectUri: base + "/cb",
        publicKey: "pb_pk_1",
        refreshThreshold: 120,
      });

      assert.isTrue(pb.isAccountClient);
      assert.equal(pb.authStrategy, pb.account);
      assert.equal(pb.autoRefreshThreshold, 120);
      assert.equal(pb.publicKey, "pb_pk_1");
      assert.equal(pb.account.issuerPath, "/oauth2/users");
      assert.deepEqual(pb.account.config.scopes, ["openid", "email"]);
    });
  });

  describe("attachAccount() / defaultAccountAuthStore()", function () {
    test("Should attach the account and its refresh strategy to an existing client", function () {
      const client = new Client(base, { publicKey: "pb_pk_1" });

      const result = attachAccount(client, {
        collection: "users",
        clientId: "app",
        redirectUri: base + "/cb",
        refreshThreshold: 30,
      });

      assert.equal(result, client);
      assert.isTrue(client.isAccountClient);
      assert.equal(client.authStrategy, client.account);
      assert.equal(client.autoRefreshThreshold, 30);
    });

    test("Should return a LocalAuthStore in browsers and an in-memory store elsewhere", function () {
      const memory = defaultAccountAuthStore("users", "app");
      assert.instanceOf(memory, AuthStore);
      assert.notInstanceOf(memory, LocalAuthStore);

      withFakeDocument(() => {
        assert.instanceOf(defaultAccountAuthStore("users", "app"), LocalAuthStore);
      });
    });

    test("createAccountClient() uses the default account store and passes the client options", async function () {
      const calls: Array<string> = [];
      const pb = createAccountClient({
        url: base,
        collection: "users",
        clientId: "app",
        redirectUri: base + "/cb",
        lang: "bg-BG",
        autoCancellation: false,
        fetch: async (url) => {
          calls.push(String(url));
          return new Response("{}", { status: 200 });
        },
      });

      assert.equal(pb.lang, "bg-BG");
      assert.notInstanceOf(pb.authStore, LocalAuthStore);
      await pb.health.check();
      assert.deepEqual(calls, [base + "/api/health"]);
    });
  });
});
