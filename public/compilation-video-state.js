export function formatCompilationDuration(seconds) {
  const value = Number(seconds) || 0;
  const minutes = Math.floor(value / 60);
  const remaining = value - minutes * 60;
  return `${minutes}:${remaining.toFixed(2).padStart(5, "0")}`;
}

export function buildCompilationVideoConfirmation(plan) {
  const provenance = plan.provenance?.verified ? "Chapter provenance: verified." : `WARNING — chapter provenance ${plan.provenance?.status ?? "incomplete"}: ${plan.provenance?.message ?? "Automatic YouTube chapters may be unavailable."}`;
  return `Render full-length compilation video locally?\n\nWAV master: ${plan.master.filename}\nVisual: ${plan.asset.filename}\nWAV duration: ${formatCompilationDuration(plan.master.duration)}\nVisual loop: ${formatCompilationDuration(plan.asset.duration)}\nExpected output: ${formatCompilationDuration(plan.expectedDuration)}\n${provenance}\nVideo: H.264, 1920 × 1080, yuv420p\nAudio: AAC 320 kbps, 48 kHz stereo\nDestination: ${plan.outputFilename}\n\nFFmpeg will start only after this confirmation. Continuing with incomplete provenance will not create automatic chapters. No music or imagery will be generated and nothing will be uploaded.`;
}
