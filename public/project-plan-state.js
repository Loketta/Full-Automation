export function buildAppendConfirmation(approval) {
  const revision = approval.revised ? "\nThis is a revised plan version and will be appended only after this confirmation." : "";
  return `Append repository plan?\n\nPlan: ${approval.planName}\nTarget project: ${approval.targetProjectName}\nTracks to add: ${approval.trackCount}\n\nExisting tracks, recordings, review statuses, project details, and audio will remain unchanged.${revision}\n\nNo music will be generated and no paid request will be made.`;
}
