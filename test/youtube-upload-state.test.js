import test from "node:test";
import assert from "node:assert/strict";
import { buildYouTubeUploadConfirmation, formatUploadBytes } from "../public/youtube-upload-state.js";

test("private upload confirmation identifies source, channel, size, duration, and safety", () => {
  const message = buildYouTubeUploadConfirmation({ source: { filename: "industrial.mp4", size: 1_073_741_824, duration: 3640.15 }, channel: { id: "UC-destination", name: "Destination", handle: "@destination" }, title: "Industrial Afterhours" });
  assert.match(message, /Destination \(@destination\)/); assert.match(message, /UC-destination/); assert.match(message, /industrial\.mp4/); assert.match(message, /1\.00 GB/); assert.match(message, /60:40/);
  assert.match(message, /Visibility: PRIVATE/); assert.match(message, /one resumable upload/); assert.match(message, /will not publish, schedule/);
  assert.match(message, /Altered\/synthetic content: YES/);
  assert.match(message, /Audience: Not made for kids/);
  assert.equal(formatUploadBytes(0), "0 B");
});
