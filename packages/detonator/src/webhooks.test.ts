import { describe, assert, test } from "vitest";
import {
  getHeaderValue,
  signWebhookBody,
  verifyWebhookSignature,
  WebhookHeaders,
} from "./webhooks";

// test vectors from the PocketBase tools/webhooks/signature_test.go:
// echo -n '{"a":1}' | openssl dgst -sha256 -hmac "secret" -binary | base64
const goBody = '{"a":1}';
const goSecret = "secret";
const goSignature = "qp4uNXX11wmLbKzNeQiIw21f22M0KnO62i1qUXR6hJQ=";

describe("webhooks", function () {
  describe("signWebhookBody()", function () {
    test("Should match the Go webhooks.Sign test vector", async function () {
      assert.equal(await signWebhookBody(goBody, goSecret), goSignature);
      assert.equal(await signWebhookBody(new TextEncoder().encode(goBody), goSecret), goSignature);
    });
  });

  describe("verifyWebhookSignature()", function () {
    const scenarios: Array<[string, any, boolean]> = [
      ["valid", { body: goBody, secret: goSecret, signature: goSignature }, true],
      [
        "valid with spaces",
        { body: goBody, secret: goSecret, signature: " " + goSignature + " " },
        true,
      ],
      ["empty secret", { body: goBody, secret: "", signature: goSignature }, false],
      ["empty signature", { body: goBody, secret: goSecret, signature: "" }, false],
      ["different secret", { body: goBody, secret: "secret2", signature: goSignature }, false],
      ["different body", { body: '{"a":2}', secret: goSecret, signature: goSignature }, false],
      ["non-base64 signature", { body: goBody, secret: goSecret, signature: "!!!" }, false],
      [
        "truncated signature",
        {
          body: goBody,
          secret: goSecret,
          signature: goSignature.substring(0, 20),
        },
        false,
      ],
    ];

    for (const [name, options, expected] of scenarios) {
      test(name, async function () {
        assert.equal(await verifyWebhookSignature(options), expected);
      });
    }

    test("Should read the signature from a Headers instance", async function () {
      const headers = new Headers({ [WebhookHeaders.hmac]: goSignature });
      assert.isTrue(await verifyWebhookSignature({ body: goBody, secret: goSecret, headers }));
      assert.isFalse(await verifyWebhookSignature({ body: goBody, secret: "x", headers }));
    });

    test("Should read the signature from a plain (Node.js) headers object", async function () {
      const headers = { "x-pb-hmac-sha256": goSignature };
      assert.isTrue(await verifyWebhookSignature({ body: goBody, secret: goSecret, headers }));
    });

    test("Should fail without a signature header", async function () {
      assert.isFalse(
        await verifyWebhookSignature({
          body: goBody,
          secret: goSecret,
          headers: {},
        }),
      );
    });
  });

  describe("getHeaderValue()", function () {
    test("Should return case-insensitive header values", function () {
      assert.equal(getHeaderValue({ "X-Test": "a" }, "x-test"), "a");
      assert.equal(getHeaderValue({ "x-test": ["b", "c"] }, "X-TEST"), "b");
      assert.equal(getHeaderValue(new Headers({ "x-test": "d" }), "X-Test"), "d");
      assert.equal(getHeaderValue(undefined, "x-test"), "");
    });
  });
});
