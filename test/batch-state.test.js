import test from "node:test";
import assert from "node:assert/strict";
import { batchSelectionUiState, buildBatchConfirmation, buildBatchSnapshot, describeBatch, isBatchEligibleTrack, reconcileBatchSelection, updateBatchSelection } from "../public/batch-state.js";

const project = {
  name: "Night Drive",
  tracks: [
    { id: "one", title: "One", direction: "First", prompt: "First instrumental prompt", status: "Pending" },
    { id: "two", title: "Two", direction: "Second", prompt: "Second instrumental prompt", status: "Generated" },
    { id: "three", title: "Three", direction: "Third", prompt: "Third instrumental prompt", status: "Pending" },
  ],
};

test("batch snapshot preserves project order and excludes generated tracks", () => {
  const result = buildBatchSnapshot(project, ["three", "two", "one"]);
  assert.deepEqual(result.tracks.map((track) => track.id), ["one", "three"]);
  assert.deepEqual(result.tracks[0], {
    id: "one", title: "One", direction: "First", prompt: "First instrumental prompt",
  });
});

test("confirmation names project, tracks, exact paid count, charges, and no retries", () => {
  const confirmation = buildBatchConfirmation(project.name, buildBatchSnapshot(project, ["one", "three"]).tracks);
  assert.match(confirmation, /Project: Night Drive/);
  assert.match(confirmation, /1\. One[\s\S]*2\. Three/);
  assert.match(confirmation, /exactly 2 paid Lyria requests/);
  assert.match(confirmation, /incurs API charges/);
  assert.match(confirmation, /never retries/);
});

test("batch status descriptions expose progress and safe stopping behaviour", () => {
  const batch = { authorizedRequestCount: 3, requestsStarted: 1, completed: [], status: "stopping" };
  assert.match(describeBatch(batch), /current request will finish/);
  assert.match(describeBatch(batch), /0 of 3 completed; 1 paid request started/);
});

test("shared batch selection preserves project order, eligibility, synchronization, and the five-track limit", () => {
  const project = { tracks: Array.from({ length: 7 }, (_value, index) => ({ id: `track-${index + 1}`, status: index === 6 ? "Generated" : "Pending" })) };
  let selected = [];
  for (const id of ["track-4", "track-2", "track-5", "track-1", "track-3"]) selected = updateBatchSelection(project, selected, id, true).selectedIds;
  assert.deepEqual(selected, ["track-1", "track-2", "track-3", "track-4", "track-5"]);
  const exceeded = updateBatchSelection(project, selected, "track-6", true);
  assert.equal(exceeded.limitExceeded, true);
  assert.deepEqual(exceeded.selectedIds, selected);
  selected = updateBatchSelection(project, selected, "track-2", false).selectedIds;
  assert.deepEqual(selected, ["track-1", "track-3", "track-4", "track-5"]);
  assert.equal(isBatchEligibleTrack(project.tracks[6]), false);
  assert.deepEqual(reconcileBatchSelection({ tracks: [project.tracks[3], project.tracks[6]] }, selected), ["track-4"]);
});

test("batch selection controls disable consistently while blocked", () => {
  assert.deepEqual(batchSelectionUiState(0, false), { generateDisabled: true, clearDisabled: true, checkboxesDisabled: false });
  assert.deepEqual(batchSelectionUiState(3, false), { generateDisabled: false, clearDisabled: false, checkboxesDisabled: false });
  assert.deepEqual(batchSelectionUiState(3, true), { generateDisabled: true, clearDisabled: true, checkboxesDisabled: true });
});
