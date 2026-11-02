export const PROJECT_OVERVIEW_GROUPS = [
  { key: "accepted", label: "Accepted" },
  { key: "rejected", label: "Rejected" },
  { key: "awaitingReview", label: "Awaiting Review" },
  { key: "notGenerated", label: "Not Generated" },
];

export function buildProjectTrackOverview(project) {
  const groups = Object.fromEntries(PROJECT_OVERVIEW_GROUPS.map(({ key }) => [key, []]));
  for (const track of project?.tracks ?? []) {
    if (track.status !== "Generated" || !track.recording) groups.notGenerated.push(track);
    else if (track.recording.reviewStatus === "Keep") groups.accepted.push(track);
    else if (track.recording.reviewStatus === "Reject") groups.rejected.push(track);
    else groups.awaitingReview.push(track);
  }
  return PROJECT_OVERVIEW_GROUPS.map(({ key, label }) => ({ key, label, tracks: groups[key], count: groups[key].length }));
}

export function focusPlannedTrack(trackId, root = document) {
  const card = [...root.querySelectorAll("[data-planned-track-id]")].find((candidate) => candidate.dataset.plannedTrackId === trackId);
  if (!card) return false;
  card.scrollIntoView({ block: "start", behavior: "smooth" });
  card.focus({ preventScroll: true });
  return true;
}
