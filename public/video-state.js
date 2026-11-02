export function buildVideoConfirmation(plan) {
  return `Create local video?\n\nRecording: ${plan.track.title} (${plan.track.filename})\nAnimation: ${plan.asset.filename}\nOutput: ${plan.outputFilename}\n\nThis runs FFmpeg locally. It does not generate music, call Lyria, or upload to YouTube.`;
}
