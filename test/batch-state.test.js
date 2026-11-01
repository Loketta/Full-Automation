import test from "node:test";
import assert from "node:assert/strict";
import { buildBatchConfirmation, buildBatchSnapshot, describeBatch } from "../public/batch-state.js";

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
