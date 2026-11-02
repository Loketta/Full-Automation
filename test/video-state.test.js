import test from "node:test";
import assert from "node:assert/strict";
import { buildVideoConfirmation } from "../public/video-state.js";

test("video confirmation identifies recording, animation, output, and local-only scope", () => {
  const message = buildVideoConfirmation({
    track: { title: "Harbour Theme", filename: "harbour.mp3" },
    asset: { filename: "Harbour Docks Master.mp4" },
    outputFilename: "harbour-theme-video.mp4",
  });
  assert.match(message, /Harbour Theme \(harbour\.mp3\)/);
  assert.match(message, /Harbour Docks Master\.mp4/);
  assert.match(message, /harbour-theme-video\.mp4/);
  assert.match(message, /does not generate music, call Lyria, or upload to YouTube/);
});
