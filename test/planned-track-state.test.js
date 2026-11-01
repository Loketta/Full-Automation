import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPaidGenerationConfirmation,
  configurePlannedTrackMessage,
  generationSnapshot,
  hasUnsavedPlannedTrackChanges,
  plannedTrackDraft,
  showPlannedTrackMessage,
} from "../public/planned-track-state.js";

const saved = {
  title: "Saved Title",
  direction: "Saved direction",
  prompt: "Saved complete instrumental prompt. No vocals.",
};

test("detects unsaved title, direction, and prompt changes", () => {
  assert.equal(hasUnsavedPlannedTrackChanges(saved, { ...saved }), false);
  assert.equal(hasUnsavedPlannedTrackChanges(saved, { ...saved, title: "Edited" }), true);
  assert.equal(hasUnsavedPlannedTrackChanges(saved, { ...saved, direction: "Edited" }), true);
  assert.equal(hasUnsavedPlannedTrackChanges(saved, { ...saved, prompt: "Edited prompt" }), true);
});

test("configures an accessible per-card live region and displays feedback", () => {
  const attributes = {};
  const element = {
    className: "",
    textContent: "",
    setAttribute(name, value) { attributes[name] = value; },
  };
  configurePlannedTrackMessage(element);
  showPlannedTrackMessage(element, "Unsaved changes detected.");

  assert.equal(element.className, "planned-track-message");
  assert.equal(element.textContent, "Unsaved changes detected.");
  assert.deepEqual(attributes, {
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
  });
});

test("normalizes harmless surrounding whitespace before dirty comparison", () => {
  const draft = plannedTrackDraft(`  ${saved.title} `, `${saved.direction}\n`, ` ${saved.prompt}  `);
  assert.deepEqual(draft, saved);
  assert.equal(hasUnsavedPlannedTrackChanges(saved, draft), false);
});

test("paid confirmation identifies the exact saved title and prompt", () => {
  const confirmation = buildPaidGenerationConfirmation(saved);
  assert.match(confirmation, /exactly one paid Lyria 3\.5 request/);
  assert.match(confirmation, /Saved Title/);
  assert.match(confirmation, /Saved complete instrumental prompt\. No vocals\./);
  assert.doesNotMatch(confirmation, /Edited/);
  assert.deepEqual(generationSnapshot(saved), saved);
});
