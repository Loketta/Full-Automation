import test from "node:test";
import assert from "node:assert/strict";
import { buildCompilationVideoConfirmation } from "../public/compilation-video-state.js";

test("compilation confirmation identifies every approved input, output property, and explicit local render", () => {
  const message = buildCompilationVideoConfirmation({
    master: { filename: "industrial.wav", duration: 3700.5 }, asset: { filename: "harbour.mp4", duration: 12 }, expectedDuration: 3700.5, outputFilename: "industrial.mp4",
  });
  assert.match(message, /industrial\.wav/); assert.match(message, /harbour\.mp4/); assert.match(message, /61:40\.50/);
  assert.match(message, /H\.264, 1920 × 1080, yuv420p/); assert.match(message, /AAC 320 kbps, 48 kHz stereo/);
  assert.match(message, /FFmpeg will start only after this confirmation/); assert.match(message, /nothing will be uploaded/);
});
