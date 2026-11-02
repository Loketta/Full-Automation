import test from "node:test";
import assert from "node:assert/strict";
import { buildMixConfirmation, formatMixDuration } from "../public/mix-state.js";

test("mix UI formats duration and confirmation includes the complete approved plan", () => {
  assert.equal(formatMixDuration(3721), "62:01");
  const message = buildMixConfirmation({
    title: "Night Mix", tracks: [{ title: "One", duration: 1900 }, { title: "Two", duration: 1900 }],
    transitions: [{ duration: 8 }], totalCrossfadeOverlap: 8, expectedDuration: 3792, outputFilename: "night-mix.wav",
  });
  assert.match(message, /Night Mix/);
  assert.match(message, /1\. One — 31:40/);
  assert.match(message, /Join 1: 8 seconds/);
  assert.match(message, /Expected duration: 63:12/);
  assert.match(message, /night-mix\.wav/);
  assert.match(message, /does not generate music or upload/);
});
