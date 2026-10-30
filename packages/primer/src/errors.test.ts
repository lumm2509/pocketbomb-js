import { describe, assert, test } from "vitest";
import { ClientResponseError } from "./errors";

describe("ClientResponseError", function () {
  describe("constructor()", function () {
    test("with object-like value", function () {
      const err = new ClientResponseError({
        url: "http://example.com",
        status: 400,
        response: { message: "test message" },
        isAbort: true,
        originalError: "test",
      });

      assert.equal(err.url, "http://example.com");
      assert.equal(err.status, 400);
      assert.deepEqual(err.response, { message: "test message" });
      assert.equal(err.isAbort, true);
      assert.equal(err.originalError, "test");
      assert.equal(err.message, "test message");
    });

    test("with non-object value", function () {
      const err = new ClientResponseError("test");

      assert.equal(err.url, "");
      assert.equal(err.status, 0);
      assert.deepEqual(err.response, {});
      assert.equal(err.isAbort, false);
      assert.equal(err.originalError, "test");
      assert.equal(err.message, "Something went wrong.");
    });

    test("with plain error", function () {
      const plainErr = new Error("test");
      const err = new ClientResponseError(plainErr);

      assert.equal(err.url, "");
      assert.equal(err.status, 0);
      assert.deepEqual(err.response, {});
      assert.equal(err.isAbort, false);
      assert.equal(err.originalError, plainErr);
      assert.equal(err.message, "Something went wrong.");
    });

    test("with ClientResponseError error", function () {
      const err0 = new ClientResponseError({
        url: "http://example.com",
        status: 400,
        response: { message: "test message" },
        isAbort: true,
        originalError: "test",
      });
      const err = new ClientResponseError(err0);

      assert.equal(err.url, "http://example.com");
      assert.equal(err.status, 400);
      assert.deepEqual(err.response, { message: "test message" });
      assert.equal(err.isAbort, true);
      assert.equal(err.originalError, "test");
      assert.equal(err.message, "test message");
    });

    // Safari may throw this on response.json() failure
    test("with DOMException.SyntaxError", function () {
      const err0 = new DOMException("test_err", "SyntaxError");
      const err = new ClientResponseError(err0);

      assert.equal(err.url, "");
      assert.equal(err.status, 0);
      assert.deepEqual(err.response, {});
      assert.equal(err.isAbort, false);
      assert.equal(err.originalError, err0);
      assert.include(err.message, "Something went wrong.");
    });

    test("with DOMException.AbortError", function () {
      const err0 = new DOMException("test_err", "AbortError");
      const err = new ClientResponseError(err0);

      assert.equal(err.url, "");
      assert.equal(err.status, 0);
      assert.deepEqual(err.response, {});
      assert.equal(err.isAbort, true);
      assert.equal(err.originalError, err0);
      assert.include(err.message, "request was aborted");
    });

    // React Native throws a plain Error with message "Aborted" instead of DOMException
    test("with React Native abort error", function () {
      const err0 = new Error("Aborted");
      const err = new ClientResponseError(err0);

      assert.equal(err.url, "");
      assert.equal(err.status, 0);
      assert.deepEqual(err.response, {});
      assert.equal(err.isAbort, true);
      assert.equal(err.originalError, err0);
      assert.include(err.message, "request was aborted");
    });
  });

  describe("OAuth2 errors", function () {
    test("Should map the OAuth2 error response", function () {
      const err = new ClientResponseError({
        status: 400,
        data: {
          error: "invalid_grant",
          error_description: "The token is expired.",
        },
      });

      assert.equal(err.oauth2Error, "invalid_grant");
      assert.equal(err.oauth2ErrorDescription, "The token is expired.");
      assert.equal(err.message, "The token is expired.");

      // rewrapped
      const wrapped = new ClientResponseError(err);
      assert.equal(wrapped.oauth2Error, "invalid_grant");
      assert.equal(wrapped.message, "The token is expired.");
    });

    test("Should fallback to the error code without description", function () {
      const err = new ClientResponseError({
        status: 401,
        data: { error: "invalid_client" },
      });

      assert.equal(err.message, "invalid_client");
    });

    test("Should not set OAuth2 fields for regular API errors", function () {
      const err = new ClientResponseError({
        status: 400,
        data: { message: "Bad request." },
      });

      assert.equal(err.oauth2Error, "");
      assert.equal(err.message, "Bad request.");
    });
  });
});
