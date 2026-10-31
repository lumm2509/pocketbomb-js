import { describe, assert, test, beforeAll, afterAll, afterEach } from "vitest";
import { Client } from "../client";
import { FetchMock } from "../test-utils/mocks";
import { GraphQLSchemaService } from "./graphql-schema";

describe("GraphQLSchemaService", function () {
  const service = new GraphQLSchemaService(new Client("test_base_url"));
  const fetchMock = new FetchMock();

  beforeAll(() => fetchMock.init());
  afterAll(() => fetchMock.restore());
  afterEach(() => fetchMock.clearMocks());

  test("get(), plan() and apply() send the schema editor requests", async function () {
    fetchMock.on({
      method: "GET",
      url: "test_base_url/api/graphql/schema",
      replyCode: 200,
      replyBody: { schema: "type A", source: "stored", canApply: true },
    });
    assert.equal((await service.get()).source, "stored");

    fetchMock.on({
      method: "POST",
      url: "test_base_url/api/graphql/schema/plan",
      body: { schema: "type A" },
      replyCode: 200,
      replyBody: { changes: [], warnings: [], errors: [], planHash: "h", canApply: true },
    });
    assert.equal((await service.plan("type A")).planHash, "h");

    fetchMock.on({
      method: "POST",
      url: "test_base_url/api/graphql/schema/apply",
      body: { schema: "type A", planHash: "h", allowDestructive: true },
      replyCode: 200,
      replyBody: { changes: [], warnings: [], errors: [], planHash: "h", canApply: true },
    });
    const applied = await service.apply({
      schema: "type A",
      planHash: "h",
      allowDestructive: true,
    });
    assert.equal(applied.planHash, "h");
  });
});
