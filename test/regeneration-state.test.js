import test from "node:test";
import assert from "node:assert/strict";
import { buildRegenerationConfirmation, formatProjectProgress, hasSubstantivePromptRevision } from "../public/regeneration-state.js";

test("client prompt validation rejects whitespace-only regeneration edits", () => {
  assert.equal(hasSubstantivePromptRevision("Dark instrumental synth pulse", "  Dark   instrumental\nsynth pulse  "), false);
  assert.equal(hasSubstantivePromptRevision("Dark instrumental synth pulse", "Dark instrumental synth pulse with heavier drums"), true);
});

test("regeneration confirmation identifies the replaced file, revised prompt, paid call, and no retry", () => {
  const message = buildRegenerationConfirmation(
    { title: "Neon Rain", filename: "neon-rain.mp3" },
    "Revised instrumental prompt with heavier drums",
  );
  assert.match(message, /Neon Rain/);
  assert.match(message, /neon-rain\.mp3/);
  assert.match(message, /Revised instrumental prompt with heavier drums/);
  assert.match(message, /exactly one paid Lyria 3\.5 request/);
  assert.match(message, /No automatic retry/);
});

test("project progress text reports all four review groups", () => {
  assert.equal(formatProjectProgress({ accepted: 2, rejected: 1, awaitingReview: 3, pending: 4 }),
    "2 accepted · 1 rejected · 3 awaiting review · 4 not generated");
});
