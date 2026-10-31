import test from "node:test";
import assert from "node:assert/strict";
import { reportGenerationError } from "../src/app.js";

test("API failures are logged safely and returned as actionable browser errors", () => {
  const apiKey = "AIzaNeverExposeThisKey123456789012345";
  const providerError = Object.assign(new Error(`Forbidden ${apiKey}`), {
    status: 403,
    error: { status: "PERMISSION_DENIED", message: `API key ${apiKey} lacks access` },
  });
  const logged = [];
  const publicError = reportGenerationError(providerError, {
    apiKey,
    logger: { error: (...values) => logged.push(values) },
  });

  assert.equal(publicError.status, 502);
  assert.match(publicError.message, /API key|Lyria access/);
  assert.doesNotMatch(publicError.message, /AIza|NeverExposeThisKey/);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /no retry/);
  assert.doesNotMatch(JSON.stringify(logged), /AIza|NeverExposeThisKey/);
  assert.match(JSON.stringify(logged), /PERMISSION_DENIED/);
});
