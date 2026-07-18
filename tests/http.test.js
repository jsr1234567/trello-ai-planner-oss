import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithRetry } from "../src/http.js";
import { splitTelegramMessage } from "../src/telegram.js";

test("retries transient read failures before returning a response", async () => {
  let calls = 0;
  const response = await fetchWithRetry("https://example.test", {}, {
    retries: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return { status: calls < 3 ? 503 : 200 };
    }
  });
  assert.equal(calls, 3);
  assert.equal(response.status, 200);
});

test("times out a request that does not settle", async () => {
  await assert.rejects(
    fetchWithRetry("https://example.test", {}, {
      timeoutMs: 5,
      fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })
    }),
    /timed out after 5ms/
  );
});

test("splits long Telegram messages on readable boundaries without dropping text", () => {
  const text = `${"first section ".repeat(400)}\n${"second section ".repeat(400)}`;
  const chunks = splitTelegramMessage(text, 1000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
  assert.equal(chunks.join(""), text);
});
