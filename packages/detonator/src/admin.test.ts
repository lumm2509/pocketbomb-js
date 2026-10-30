import { afterAll, afterEach, assert, beforeAll, describe, expect, test } from "vitest";
import { base64Decode } from "pocketbomb-primer";
import { baseURLFromIssuer, createAdminClient, exchangeLaunchToken } from "./admin";
import { dummyJWT, FetchMock } from "./test-utils/mocks";

const base = "http://test.local";
const installationsTokenURL = base + "/oauth2/_applicationInstallations/token";

function basicCredentials(config: any): string {
  const header = config?.headers?.["Authorization"] || "";
  if (!header.startsWith("Basic ")) {
    return "";
  }
  return new TextDecoder().decode(base64Decode(header.substring(6)));
}

function withFakeDocument(fn: () => void) {
  (globalThis as any).document = {};
  try {
    fn();
  } finally {
    delete (globalThis as any).document;
  }
}

describe("admin clients (ported from the P1 factories tests)", function () {
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

  describe("createAdminClient()", function () {
    test("Should throw in browsers", function () {
      withFakeDocument(() => {
        assert.throws(
          () =>
            createAdminClient({
              url: base,
              clientId: "c",
              clientSecret: "s",
            }),
          /browser/,
        );
      });
    });

    test("Should lazily fetch a client_credentials token and re-fetch it before expiry", async function () {
      const pb = createAdminClient({
        url: base,
        clientId: "pba_1",
        clientSecret: "secret 1",
        scopes: ["read_posts"],
      });

      const tokens = [
        dummyJWT({ exp: Math.floor(Date.now() / 1000) + 30 }), // expires within the threshold
        dummyJWT({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      ];
      let tokenRequests = 0;

      fetchMock.on({
        method: "POST",
        url: installationsTokenURL,
        additionalMatcher: (_, config: any) => {
          const f = new URLSearchParams(config.body);
          return (
            basicCredentials(config) === "pba_1:secret+1" &&
            f.get("grant_type") === "client_credentials" &&
            f.get("scope") === "read_posts" &&
            !f.get("client_id") &&
            !f.get("client_secret")
          );
        },
        replyCode: 200,
        replyBody: () => ({
          access_token: tokens[tokenRequests++],
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read_posts",
        }),
      });

      const seen: Array<string> = [];
      fetchMock.on({
        method: "GET",
        url: base + "/api/collections/posts/records?page=1&perPage=30",
        additionalMatcher: (_, config: any) => {
          seen.push(config.headers["Authorization"]);
          return true;
        },
        replyCode: 200,
        replyBody: { items: [] },
      });

      await pb.collection("posts").getList();
      await pb.collection("posts").getList();
      await pb.collection("posts").getList();

      assert.equal(tokenRequests, 2);
      // 1st: lazy fetch (token expiring within the threshold), 2nd: re-fetch, 3rd: reuse
      assert.deepEqual(seen, [tokens[0], tokens[1], tokens[1]]);
      assert.equal(pb.authStore.scope, "read_posts");
      assert.equal(pb.authStore.clientId, "pba_1");
    });

    test("Should throw the token endpoint error", async function () {
      const pb = createAdminClient({
        url: base,
        clientId: "c",
        clientSecret: "bad",
      });

      fetchMock.on({
        method: "POST",
        url: installationsTokenURL,
        replyCode: 401,
        replyBody: {
          error: "invalid_client",
          error_description: "Client authentication failed.",
        },
      });

      await expect(pb.collection("posts").getList()).rejects.toMatchObject({
        status: 401,
        oauth2Error: "invalid_client",
      });
    });
  });

  describe("exchangeLaunchToken()", function () {
    test("Should exchange the launch token for an online token client", async function () {
      const online = dummyJWT({ exp: Math.floor(Date.now() / 1000) + 600 });

      fetchMock.on({
        method: "POST",
        url: installationsTokenURL,
        additionalMatcher: (_, config: any) => {
          const f = new URLSearchParams(config.body);
          return (
            basicCredentials(config) === "pba_1:s1" &&
            f.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange" &&
            f.get("subject_token") === "launch.jwt.token" &&
            f.get("subject_token_type") === "urn:pocketbase:params:oauth:token-type:launch_token"
          );
        },
        replyCode: 200,
        replyBody: {
          access_token: online,
          token_type: "Bearer",
          expires_in: 600,
          scope: "read_posts",
          associated_user: { id: "staff1", roles: ["Manager"] },
        },
      });

      const pb = await exchangeLaunchToken({
        url: base,
        clientId: "pba_1",
        clientSecret: "s1",
        launchToken: "launch.jwt.token",
      });

      assert.equal(pb.authStore.token, online);
      assert.deepEqual(pb.authStore.meta.associatedUser, {
        id: "staff1",
        roles: ["Manager"],
      });
      assert.isNull(pb.authStrategy);
    });
  });

  describe("baseURLFromIssuer()", function () {
    test("Should return the base URL of the installations issuer", function () {
      assert.equal(
        baseURLFromIssuer("https://pb.example.com/oauth2/_applicationInstallations"),
        "https://pb.example.com",
      );
      assert.throws(() => baseURLFromIssuer("https://pb.example.com/oauth2/users"), /Invalid/);
    });
  });
});
