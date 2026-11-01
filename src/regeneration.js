import { validatePrompt } from "./prompt.js";
import { ProjectConflictError, ProjectValidationError } from "./projects.js";

export function validateRegeneration({ project, plannedTrack, recording, revisedPrompt, expected }) {
  if (plannedTrack.status !== "Generated" || !plannedTrack.libraryTrackId || plannedTrack.libraryTrackId !== recording?.id) {
    throw new ProjectConflictError("This planned track is not linked to the displayed recording. Refresh before regenerating.");
  }
  if (recording.reviewStatus !== "Reject") {
    throw new ProjectConflictError("Only a recording currently marked Reject can be regenerated.");
  }
  if (!expected || expected.libraryTrackId !== recording.id || expected.prompt !== recording.prompt) {
    throw new ProjectConflictError("The recording or prompt changed after it was displayed. Refresh and review it before regenerating.");
  }
  const prompt = validatePrompt(revisedPrompt);
  if (canonicalPrompt(prompt) === canonicalPrompt(recording.prompt)) {
    throw new ProjectValidationError("Revise the rejected recording's prompt before regenerating; whitespace-only changes do not qualify.");
  }
  return { project, plannedTrack, recording, prompt };
}

export async function regenerateRejectedRecording({
  projectId,
  plannedTrackId,
  revisedPrompt,
  expected,
  projects,
  library,
  generateAudio,
  saveAudio,
  logger = console,
}) {
  const { project, track: plannedTrack } = projects.getTrack(projectId, plannedTrackId);
  const recording = plannedTrack.libraryTrackId ? library.get(plannedTrack.libraryTrackId) : undefined;
  const validated = validateRegeneration({ project, plannedTrack, recording, revisedPrompt, expected });

  // Exactly one paid call. The original remains linked and untouched throughout it.
  const audio = await generateAudio(validated.prompt);
  const filename = await saveAudio(audio);
  let replacement;
  try {
    replacement = await library.registerGenerated({
      filename,
      title: plannedTrack.title,
      prompt: validated.prompt,
      projectId,
      plannedTrackId,
      replacementForLibraryTrackId: recording.id,
    });
  } catch (error) {
    await library.removeUnregisteredFile(filename).catch((cleanupError) => {
      logger.error("Unregistered replacement MP3 cleanup failed:", safeError(cleanupError));
    });
    throw error;
  }

  try {
    if (library.get(recording.id).reviewStatus !== "Reject") {
      throw new ProjectConflictError("The recording is no longer marked Reject. The generated replacement was not linked.");
    }
    await projects.commitReplacement(projectId, plannedTrackId, {
      oldLibraryTrackId: recording.id,
      newLibraryTrackId: replacement.id,
      prompt: validated.prompt,
    });
  } catch (error) {
    await library.delete(replacement.id).catch((cleanupError) => {
      logger.error("Prepared replacement rollback failed; startup recovery is required:", safeError(cleanupError));
    });
    throw error;
  }

  try {
    replacement = await library.finalizeReplacement(replacement.id);
  } catch (error) {
    logger.error("Replacement committed, but finalization is pending restart recovery:", safeError(error));
    return {
      replacement,
      replaced: recording,
      warning: "The replacement is safely linked, but cleanup could not be finalized. The rejected MP3 was preserved; restart the app to recover before regenerating anything else.",
    };
  }

  const warning = await cleanupOldRecording({ projects, library, projectId, plannedTrackId, oldLibraryTrackId: recording.id, logger });
  return { replacement, replaced: recording, warning };
}

export async function recoverReplacementTransactions(projects, library, logger = console) {
  let pending = false;
  for (const recording of library.list().filter((track) => track.replacementForLibraryTrackId)) {
    try {
      if (projects.referencesLibraryTrack(recording.id)) await library.finalizeReplacement(recording.id);
      else await library.delete(recording.id);
    } catch (error) {
      pending = true;
      logger.error("Replacement preparation recovery remains pending:", safeError(error));
    }
  }

  for (const cleanup of projects.replacementCleanups()) {
    try {
      const { track } = projects.getTrack(cleanup.projectId, cleanup.plannedTrackId);
      const current = track.libraryTrackId ? library.list().find((candidate) => candidate.id === track.libraryTrackId) : undefined;
      if (current?.replacementForLibraryTrackId) continue;
      const warning = await cleanupOldRecording({ projects, library, ...cleanup, logger });
      if (warning) pending = true;
    } catch (error) {
      pending = true;
      logger.error("Replacement cleanup recovery remains pending:", safeError(error));
    }
  }
  return {
    pending,
    message: pending
      ? "A recording replacement could not be fully recovered at startup. Paid generation is blocked. Manually inspect the project, Track Library, output files, and terminal diagnostic, then restart safely. No request was retried or resumed."
      : undefined,
  };
}

export function decorateProjectsWithRecordings(projects, libraryTracks) {
  const byId = new Map(libraryTracks.map((track) => [track.id, track]));
  return projects.map((project) => {
    const decorated = {
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        recording: track.libraryTrackId ? byId.get(track.libraryTrackId) : undefined,
      })),
    };
    decorated.progress = projectProgress(decorated.tracks);
    return decorated;
  });
}

export function projectProgress(tracks) {
  const counts = { accepted: 0, rejected: 0, awaitingReview: 0, pending: 0 };
  for (const track of tracks) {
    if (track.status !== "Generated" || !track.recording) counts.pending += 1;
    else if (track.recording.reviewStatus === "Keep") counts.accepted += 1;
    else if (track.recording.reviewStatus === "Reject") counts.rejected += 1;
    else counts.awaitingReview += 1;
  }
  return counts;
}

async function cleanupOldRecording({ projects, library, projectId, plannedTrackId, oldLibraryTrackId, logger }) {
  try {
    if (!projects.referencesLibraryTrack(oldLibraryTrackId)) {
      const exists = library.list().some((track) => track.id === oldLibraryTrackId);
      if (exists) await library.delete(oldLibraryTrackId);
    }
    await projects.completeReplacementCleanup(projectId, plannedTrackId, oldLibraryTrackId);
    return undefined;
  } catch (error) {
    logger.error("Rejected recording cleanup is pending restart recovery:", safeError(error));
    return "The replacement is saved and linked, but rejected-recording cleanup is pending. Restart the app to recover; do not regenerate this track again.";
  }
}

function canonicalPrompt(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function safeError(error) {
  return { name: error?.name, message: error?.message, code: error?.code };
}
