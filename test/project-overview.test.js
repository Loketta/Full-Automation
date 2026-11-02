import test from "node:test";
import assert from "node:assert/strict";
import { buildProjectTrackOverview, focusPlannedTrack } from "../public/project-overview.js";

function projectWithStatuses() {
  return { tracks: [
    { id: "keep", title: "Kept Track", status: "Generated", recording: { reviewStatus: "Keep" } },
    { id: "reject", title: "Rejected Track", status: "Generated", recording: { reviewStatus: "Reject" } },
    { id: "review", title: "Review Track", status: "Generated", recording: { reviewStatus: "Unreviewed" } },
    { id: "pending", title: "Pending Track", status: "Pending" },
    { id: "missing", title: "Missing Recording", status: "Generated" },
  ] };
}

test("track overview categorises titles and counts from current project state", () => {
  const overview = buildProjectTrackOverview(projectWithStatuses());
  assert.deepEqual(overview.map(({ label, count }) => [label, count]), [
    ["Accepted", 1], ["Rejected", 1], ["Awaiting Review", 1], ["Not Generated", 2],
  ]);
  assert.deepEqual(overview[0].tracks.map((track) => track.title), ["Kept Track"]);
  assert.deepEqual(overview[3].tracks.map((track) => track.title), ["Pending Track", "Missing Recording"]);
});

test("selected project changes produce a fresh overview including empty groups", () => {
  const first = buildProjectTrackOverview(projectWithStatuses());
  const second = buildProjectTrackOverview({ tracks: [{ id: "new", title: "New Pending", status: "Pending" }] });
  assert.equal(first[0].count, 1);
  assert.deepEqual(second.map((group) => group.count), [0, 0, 0, 1]);
  assert.equal(second[3].tracks[0].title, "New Pending");
});

test("overview navigation scrolls to and focuses the corresponding track editor", () => {
  const calls = [];
  const card = { dataset: { plannedTrackId: "target" }, scrollIntoView: (options) => calls.push(["scroll", options]), focus: (options) => calls.push(["focus", options]) };
  const root = { querySelectorAll: () => [{ dataset: { plannedTrackId: "other" } }, card] };
  assert.equal(focusPlannedTrack("target", root), true);
  assert.deepEqual(calls, [["scroll", { block: "start", behavior: "smooth" }], ["focus", { preventScroll: true }]]);
  assert.equal(focusPlannedTrack("absent", root), false);
});
