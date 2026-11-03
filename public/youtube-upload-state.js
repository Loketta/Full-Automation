export function formatUploadBytes(bytes) {
  if (!Number.isFinite(bytes)) return "Unknown";
  const units = ["B", "KB", "MB", "GB"]; let value = bytes; let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) { value /= 1024; unit = units[index]; }
  return `${value.toFixed(unit === "B" ? 0 : 2)} ${unit}`;
}
export function formatUploadDuration(seconds) { const value = Number(seconds) || 0; return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`; }
export function buildYouTubeUploadConfirmation(plan) {
  return `Upload this completed compilation to YouTube?\n\nDestination: ${plan.channel.name}${plan.channel.handle ? ` (${plan.channel.handle})` : ""}\nChannel ID: ${plan.channel.id}\nFile: ${plan.source.filename}\nSize: ${formatUploadBytes(plan.source.size)}\nDuration: ${formatUploadDuration(plan.source.duration)}\nTitle: ${plan.title}\nVisibility: PRIVATE\n\nThis explicitly starts one resumable upload. It will not publish, schedule, or make the video Public or Unlisted.`;
}
