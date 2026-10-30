import { assert, describe, test } from "vitest";
import { graphqlspConfig } from "./config";

describe("ts-plugin config", function () {
  test("defaults and overrides", function () {
    assert.deepEqual(graphqlspConfig(), {
      schema: ".dynamite/schema.graphql",
      templateIsCallExpression: true,
      template: "graphql",
      trackFieldUsage: false,
      shouldCheckForColocatedFragments: false,
    });
    assert.deepEqual(graphqlspConfig({ schema: "s.json", trackFieldUsage: true }), {
      schema: "s.json",
      templateIsCallExpression: true,
      template: "graphql",
      trackFieldUsage: true,
      shouldCheckForColocatedFragments: false,
    });
  });

  test("the built plugin is a CommonJS tsserver plugin factory wrapping graphqlsp", async function () {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const factory = require("../../dist/ts-plugin/index.cjs");
    assert.equal(typeof factory, "function");

    // the factory accepts the typescript module and returns a plugin with create()
    const plugin = factory({ typescript: require("typescript") });
    assert.equal(typeof plugin.create, "function");
  });
});
