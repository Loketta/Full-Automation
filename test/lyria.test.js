import test from "node:test";
import assert from "node:assert/strict";
import { generateInstrumental, LYRIA_MODEL, toPublicError } from "../src/lyria.js";

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
    message: "Lyria is rate limited. Wait a moment, then choose when to try again.",
  });
  assert.equal(toPublicError(new Error("secret detail")).status, 502);
  assert.doesNotMatch(toPublicError(new Error("secret detail")).message, /secret detail/);
});
