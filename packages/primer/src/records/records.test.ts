import { describe, assert, test, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { crudServiceTestsSuite } from "../test-utils/suites";
import { FetchMock } from "../test-utils/mocks";
import { Client } from "../client";
import { RecordService } from "./records";

describe("RecordService", function () {
  const client = new Client("test_base_url/");
  const service = new RecordService(client, "sub=");

  crudServiceTestsSuite(service, "/api/collections/sub%3D/records");

  const fetchMock = new FetchMock();

  beforeEach(function () {
    service.client.authStore.clear(); // reset
  });

  beforeAll(function () {
    fetchMock.init();
  });

  afterAll(function () {
    fetchMock.restore();
  });

  afterEach(function () {
    fetchMock.clearMocks();
  });

  describe("AuthStore sync", function () {
    test("Should update the AuthStore record model on matching update id and collection", async function () {
      fetchMock.on({
        method: "PATCH",
        url: service.client.buildURL("/api/collections/sub%3D/records/test123"),
        replyCode: 200,
        replyBody: {
          id: "test123",
          email: "new@example.com",
          name: "name_new",
          expand: { b: 3 },
        },
      });

      service.client.authStore.save("test_token", {
        id: "test123",
        collectionName: "sub=",
        name: "abc",
        expand: { a: 1, b: 2 },
      } as any);

      await service.update("test123", {});

      assert.equal(service.client.authStore.record?.id, "test123");
      assert.equal(service.client.authStore.record?.collectionName, "sub=");
      assert.equal(service.client.authStore.record?.name, "name_new");
      assert.equal(service.client.authStore.record?.email, "new@example.com");
      assert.equal(service.client.authStore.record?.expand?.a, 1);
      assert.equal(service.client.authStore.record?.expand?.b, 3);
    });

    test("Should not update the AuthStore record model on matching id but mismatched collection", async function () {
      fetchMock.on({
        method: "PATCH",
        url: service.client.buildURL("/api/collections/sub%3D/records/test123"),
        replyCode: 200,
        replyBody: {
          id: "test123",
          email: "new@example.com",
        },
      });

      service.client.authStore.save("test_token", {
        id: "test123",
        email: "old@example.com",
        collectionName: "diff",
      } as any);

      await service.update("test123", {});

      assert.equal(service.client.authStore.record?.email, "old@example.com");
    });

    test("Should not update the AuthStore record model on mismatched update id", async function () {
      fetchMock.on({
        method: "PATCH",
        url: service.client.buildURL("/api/collections/sub%3D/records/test123"),
        replyCode: 200,
        replyBody: {
          id: "test123",
          email: "new@example.com",
        },
      });

      service.client.authStore.save("test_token", {
        id: "test456",
        email: "old@example.com",
        collectionName: "sub=",
      } as any);

      await service.update("test123", {});

      assert.equal(service.client.authStore.record?.email, "old@example.com");
    });

    test("Should delete the AuthStore record model on matching delete id and collection", async function () {
      fetchMock.on({
        method: "DELETE",
        url: service.client.buildURL("/api/collections/sub%3D/records/test123"),
        replyCode: 204,
      });

      service.client.authStore.save("test_token", {
        id: "test123",
        collectionName: "sub=",
      } as any);

      await service.delete("test123");

      assert.isNull(service.client.authStore.record);
    });

    test("Should not delete the AuthStore record model on matching delete id but mismatched collection", async function () {
      fetchMock.on({
        method: "DELETE",
        url: service.client.buildURL("/api/collections/sub%3D/records/test123"),
        replyCode: 204,
      });

      service.client.authStore.save("test_token", {
        id: "test123",
        collectionName: "diff",
      } as any);

      await service.delete("test123");

      assert.isNotNull(service.client.authStore.record);
    });

    test("Should not delete the AuthStore record model on mismatched delete id", async function () {
      fetchMock.on({
        method: "DELETE",
        url: service.client.buildURL("/api/collections/sub%3D/records/test123"),
        replyCode: 204,
      });

      service.client.authStore.save("test_token", {
        id: "test456",
        collectionName: "sub=",
      } as any);

      await service.delete("test123");

      assert.isNotNull(service.client.authStore.record);
    });
  });
  describe("requestVerification()", function () {
    test("Should send a password reset request", async function () {
      fetchMock.on({
        method: "POST",
        url: service.client.buildURL(service.baseCollectionPath) + "/request-verification?q1=456",
        body: {
          email: "test@example.com",
        },
        additionalMatcher: (_, config) => {
          return config?.headers?.["x-test"] === "789";
        },
        replyCode: 204,
        replyBody: true,
      });

      const result = await service.requestVerification("test@example.com", {
        q1: 456,
        headers: { "x-test": "789" },
      });

      assert.isTrue(result);
    });
  });

  describe("requestEmailChange()", function () {
    test("Should send an email change request", async function () {
      fetchMock.on({
        method: "POST",
        url: service.client.buildURL(service.baseCollectionPath) + "/request-email-change?q1=456",
        body: {
          newEmail: "test@example.com",
        },
        additionalMatcher: (_, config) => {
          return config?.headers?.["x-test"] === "789";
        },
        replyCode: 204,
        replyBody: true,
      });

      const result = await service.requestEmailChange("test@example.com", {
        q1: 456,
        headers: { "x-test": "789" },
      });

      assert.isTrue(result);
    });
  });
});
