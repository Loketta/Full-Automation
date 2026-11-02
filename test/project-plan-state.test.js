import test from "node:test";
import assert from "node:assert/strict";
import { buildAppendConfirmation } from "../public/project-plan-state.js";

test("append confirmation identifies plan, target, count, preservation, revision, and local-only safety", () => {
  const message = buildAppendConfirmation({
    planName: "Expansion", targetProjectName: "Existing Project", trackCount: 3, revised: true,
  });
  assert.match(message, /Plan: Expansion/);
  assert.match(message, /Target project: Existing Project/);
  assert.match(message, /Tracks to add: 3/);
  assert.match(message, /Existing tracks, recordings, review statuses, project details, and audio will remain unchanged/);
  assert.match(message, /revised plan version/);
  assert.match(message, /No music will be generated and no paid request/);
});
