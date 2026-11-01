export function plannedTrackDraft(title, direction, prompt) {
  return {
    title: String(title ?? "").trim(),
    direction: String(direction ?? "").trim(),
    prompt: String(prompt ?? "").trim(),
  };
}

export function hasUnsavedPlannedTrackChanges(saved, draft) {
  const normalized = plannedTrackDraft(draft?.title, draft?.direction, draft?.prompt);
  return normalized.title !== saved.title
    || normalized.direction !== saved.direction
    || normalized.prompt !== saved.prompt;
}

export function buildPaidGenerationConfirmation(saved) {
  return `This makes exactly one paid Lyria 3.5 request.\n\nSaved title:\n${saved.title}\n\nSaved prompt that will be sent:\n${saved.prompt}\n\nGenerate now?`;
}

export function generationSnapshot(saved) {
  return {
    title: saved.title,
    direction: saved.direction,
    prompt: saved.prompt,
  };
}

export function configurePlannedTrackMessage(element) {
  element.className = "planned-track-message";
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");
  element.setAttribute("aria-atomic", "true");
  return element;
}

export function showPlannedTrackMessage(element, message) {
  element.textContent = message;
}
