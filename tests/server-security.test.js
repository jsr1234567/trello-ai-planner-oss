import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeServerConfig, isLoopbackHost, validBearerToken } from "../src/api-security.js";

test("only loopback is allowed without an API bearer token", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("example.test"), false);
  assert.doesNotThrow(() => assertSafeServerConfig({ host: "localhost" }));
  assert.throws(() => assertSafeServerConfig({ host: "example.test" }), /PLANNER_API_TOKEN/);
  assert.doesNotThrow(() => assertSafeServerConfig({ host: "example.test", apiToken: "test-token" }));
});

test("bearer tokens require an exact constant-time comparable value", () => {
  assert.equal(validBearerToken("Bearer test-token", "test-token"), true);
  assert.equal(validBearerToken("Bearer wrong-token", "test-token"), false);
  assert.equal(validBearerToken(undefined, "test-token"), false);
});
