export function hasSubstantivePromptRevision(original, revised) {
  return canonicalPrompt(original) !== canonicalPrompt(revised);
}

export function buildRegenerationConfirmation(recording, revisedPrompt) {
  return `Replace rejected recording: ${recording.title}\nFile being replaced: ${recording.filename}\n\nRevised prompt that will be used:\n${revisedPrompt.trim()}\n\nThis makes exactly one paid Lyria 3.5 request and may incur API charges. The original recording is preserved unless the replacement is safely committed. No automatic retry will be made. Continue?`;
}

export function formatProjectProgress(progress) {
  return `${progress.accepted} accepted · ${progress.rejected} rejected · ${progress.awaitingReview} awaiting review · ${progress.pending} not generated`;
}

function canonicalPrompt(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}
