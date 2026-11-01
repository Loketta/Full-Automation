export function buildBatchSnapshot(project, selectedIds) {
  const selected = new Set(selectedIds);
  return {
    projectName: project.name,
    tracks: project.tracks
      .filter((track) => selected.has(track.id) && track.status === "Pending")
      .map(({ id, title, direction, prompt }) => ({ id, title, direction, prompt })),
  };
}

export function buildBatchConfirmation(projectName, tracks) {
  const count = tracks.length;
  const titles = tracks.map((track, index) => `${index + 1}. ${track.title}`).join("\n");
  return `Project: ${projectName}\n\nSelected tracks:\n${titles}\n\nAuthorise exactly ${count} paid Lyria request${count === 1 ? "" : "s"}? Generation incurs API charges. The batch stops on failure and never retries automatically.`;
}

export function describeBatch(batch) {
  const progress = `${batch.completed.length} of ${batch.authorizedRequestCount} completed; ${batch.requestsStarted} paid request${batch.requestsStarted === 1 ? "" : "s"} started.`;
  if (batch.status === "completed") return `Batch completed. ${progress}`;
  if (batch.status === "failed") return `${batch.failure} ${progress}`;
  if (batch.status === "stopped") return `Batch stopped. No further requests will start. ${progress}`;
  if (batch.status === "interrupted") return `${batch.failure} ${progress}`;
  if (batch.status === "stopping") return `Stop requested. The current request will finish, then no further request will start. ${progress}`;
  return `Batch running. ${progress}`;
}
