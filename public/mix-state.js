export function formatMixDuration(seconds) {
  const rounded = Math.round(Number(seconds) || 0);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

export function buildMixTrackViewModels(trackIds, libraryTracks) {
  const tracksById = new Map(libraryTracks.map((track) => [track.id, track]));
  return trackIds.map((id) => ({ id, track: tracksById.get(id), missing: !tracksById.has(id) }));
}

export function removeMixTrackId(trackIds, index) {
  return trackIds.filter((_id, candidateIndex) => candidateIndex !== index);
}

export function addRecordingToMix(trackIds, trackId) {
  if (!trackId || trackIds.includes(trackId)) return { trackIds: [...trackIds], added: false };
  return { trackIds: [...trackIds, trackId], added: true };
}

export function addAcceptedProjectRecordings(trackIds, project) {
  const acceptedIds = (project?.tracks ?? [])
    .filter((track) => track.status === "Generated" && track.recording?.reviewStatus === "Keep")
    .map((track) => track.recording.id);
  const seen = new Set(trackIds); const additions = [];
  for (const id of acceptedIds) { if (!seen.has(id)) { seen.add(id); additions.push(id); } }
  return { trackIds: [...trackIds, ...additions], addedCount: additions.length, skippedCount: acceptedIds.length - additions.length, acceptedCount: acceptedIds.length };
}

export function describeMixDuration(preview) {
  const requirement = `Required: strictly more than ${formatMixDuration(preview.minimumDuration)}`;
  const shortfall = preview.meetsMinimum ? "Minimum satisfied"
    : preview.shortfallSeconds > 0 ? `Shortfall: ${formatMixDuration(preview.shortfallSeconds)}`
      : `Shortfall: 0:00, but the mix must exceed ${formatMixDuration(preview.minimumDuration)} by a positive duration`;
  return `Source total: ${formatMixDuration(preview.totalSourceDuration)} · Crossfade overlap: ${formatMixDuration(preview.totalCrossfadeOverlap)} · Estimated final: ${formatMixDuration(preview.expectedDuration)} · ${requirement} · ${shortfall}`;
}

export function buildMixConfirmation(plan) {
  const tracks = plan.tracks.map((track, index) => `${index + 1}. ${track.title} — ${formatMixDuration(track.duration)}`).join("\n");
  const transitions = plan.transitions.map((transition, index) => `Join ${index + 1}: ${transition.duration} seconds`).join("\n");
  return `Render local WAV master?\n\nMix: ${plan.title}\n${tracks}\n\nCrossfades:\n${transitions}\nTotal overlap: ${formatMixDuration(plan.totalCrossfadeOverlap)}\nExpected duration: ${formatMixDuration(plan.expectedDuration)}\nOutput: ${plan.outputFilename}\n\nThis runs FFmpeg locally and does not generate music or upload anything.`;
}
