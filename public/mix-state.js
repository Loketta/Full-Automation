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

export function buildMixConfirmation(plan) {
  const tracks = plan.tracks.map((track, index) => `${index + 1}. ${track.title} — ${formatMixDuration(track.duration)}`).join("\n");
  const transitions = plan.transitions.map((transition, index) => `Join ${index + 1}: ${transition.duration} seconds`).join("\n");
  return `Render local WAV master?\n\nMix: ${plan.title}\n${tracks}\n\nCrossfades:\n${transitions}\nTotal overlap: ${formatMixDuration(plan.totalCrossfadeOverlap)}\nExpected duration: ${formatMixDuration(plan.expectedDuration)}\nOutput: ${plan.outputFilename}\n\nThis runs FFmpeg locally and does not generate music or upload anything.`;
}
