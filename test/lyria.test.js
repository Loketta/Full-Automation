import test from "node:test";
import assert from "node:assert/strict";
import { createSafeDiagnostic, generateInstrumental, LYRIA_MODEL, toPublicError } from "../src/lyria.js";

test("makes exactly one Lyria 3.5 interaction and returns its MP3 data", async () => {
  const calls = [];
  const client = { interactions: { create: async (request) => {
    calls.push(request);
    return { output_audio: { data: "bXAz" } };
  } } };

  assert.equal(await generateInstrumental(client, "Cyberpunk at 105 BPM"), "bXAz");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, LYRIA_MODEL);
  assert.equal(calls[0].response_format.type, "audio");
  assert.match(calls[0].input, /No vocals/);
});

test("does not retry a failed chargeable request", async () => {
  let calls = 0;
  const client = { interactions: { create: async () => {
    calls += 1;
    throw Object.assign(new Error("quota"), { status: 429 });
  } } };

  await assert.rejects(() => generateInstrumental(client, "Cyberpunk instrumental"));
  assert.equal(calls, 1);
});

test("maps rate limit and unknown failures to safe public errors", () => {
  assert.deepEqual(toPublicError({ status: 429 }), {
    status: 429,
    message: "Google rate-limited the request or the project has no available quota. Check Gemini API billing and quota, then wait before choosing to try again.",
  });
  assert.equal(toPublicError(new Error("secret detail")).status, 502);
  assert.doesNotMatch(toPublicError(new Error("secret detail")).message, /secret detail/);
});

test("maps common Google and network failures to actionable browser messages", () => {
  assert.match(toPublicError({ status: 403 }).message, /API key|Lyria access/);
  assert.match(toPublicError({ status: 400 }).message, /rejected the Lyria request/);
  assert.match(toPublicError({ status: 404 }).message, /model lyria-3\.5/);
  assert.match(toPublicError({ status: 503 }).message, /service returned a server error/);
  assert.match(toPublicError({ name: "APIConnectionError" }).message, /internet connection/);
});

test("creates useful diagnostics while redacting keys and authentication data", () => {
  const apiKey = "AIzaSecretKeyMaterial123456789012345";
  const error = Object.assign(new Error(`request failed with key=${apiKey}`), {
    status: 403,
    error: {
      status: "PERMISSION_DENIED",
      message: `x-goog-api-key: ${apiKey}`,
    },
    headers: new Headers({ "x-goog-request-id": "request-123" }),
  });

  const diagnostic = createSafeDiagnostic(error, [apiKey]);
  const serialized = JSON.stringify(diagnostic);
  assert.equal(diagnostic.httpStatus, 403);
  assert.equal(diagnostic.providerCode, "PERMISSION_DENIED");
  assert.equal(diagnostic.requestId, "request-123");
  assert.doesNotMatch(serialized, /AIza|SecretKeyMaterial|x-goog-api-key/i);
  assert.match(serialized, /REDACTED/);
});
