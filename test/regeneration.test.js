import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rename as fsRename, rm, writeFile } from "node:fs/promises";
import { TrackLibrary } from "../src/library.js";
import { ProjectStore } from "../src/projects.js";
import {
  decorateProjectsWithRecordings,
  projectProgress,
  recoverReplacementTransactions,
  regenerateRejectedRecording,
  validateRegeneration,
} from "../src/regeneration.js";

async function fixture(t, projectDependencies = {}) {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-regeneration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  let id = 0;
  const dependencies = {
    randomUUID: () => `50000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    now: () => new Date("2026-11-01T16:00:00.000Z"),
  };
  const library = new TrackLibrary(output, dependencies);
  const projects = new ProjectStore(output, { ...dependencies, ...projectDependencies });
  await library.initialize();
  await projects.initialize();
  const project = await projects.import({
    version: 1,
    name: "Review Project",
    theme: "Instrumental review test",
    tracks: [
      { title: "Rejected Track", direction: "Dark opening", prompt: "Original instrumental prompt with dark synths and no vocals." },
      { title: "Other Track", direction: "Bright ending", prompt: "Other instrumental prompt with bright synths and no vocals." },
    ],
  });
  const planned = project.tracks[0];
  await writeFile(path.join(output, "rejected.mp3"), "original rejected audio");
  const recording = await library.registerGenerated({
    filename: "rejected.mp3", title: planned.title, prompt: planned.prompt,
    projectId: project.id, plannedTrackId: planned.id,
  });
  await library.update(recording.id, { reviewStatus: "Reject" });
  await projects.linkGenerated(project.id, planned.id, recording.id);
  return { root, output, dependencies, library, projects, project, planned, recording: library.get(recording.id) };
}

function request(values, prompt = "Revised instrumental prompt with heavier drums and no vocals.") {
  return {
    projectId: values.project.id,
    plannedTrackId: values.planned.id,
    revisedPrompt: prompt,
    expected: { libraryTrackId: values.recording.id, prompt: values.recording.prompt },
    projects: values.projects,
    library: values.library,
  };
}

test("project recordings use library review status and produce accurate progress without reordering", async (t) => {
  const values = await fixture(t);
  const decorated = decorateProjectsWithRecordings(values.projects.list(), values.library.list())[0];
  assert.deepEqual(decorated.tracks.map((track) => track.id), values.project.tracks.map((track) => track.id));
  assert.equal(decorated.tracks[0].recording.reviewStatus, "Reject");
  assert.deepEqual(decorated.progress, { accepted: 0, rejected: 1, awaitingReview: 0, pending: 1 });

  await values.library.update(values.recording.id, { reviewStatus: "Keep" });
  const updated = decorateProjectsWithRecordings(values.projects.list(), values.library.list())[0];
  assert.equal(updated.tracks[0].recording.reviewStatus, "Keep");
  assert.deepEqual(updated.progress, { accepted: 1, rejected: 0, awaitingReview: 0, pending: 1 });
  assert.deepEqual(projectProgress([]), { accepted: 0, rejected: 0, awaitingReview: 0, pending: 0 });
});

test("server validation requires Reject, a fresh recording snapshot, and a substantive prompt revision", async (t) => {
  const values = await fixture(t);
  const current = values.projects.getTrack(values.project.id, values.planned.id);
  assert.throws(() => validateRegeneration({
    project: current.project, plannedTrack: current.track, recording: values.recording,
    revisedPrompt: `  ${values.recording.prompt.replaceAll(" ", "   ")}  `,
    expected: { libraryTrackId: values.recording.id, prompt: values.recording.prompt },
  }), /whitespace-only changes/);
  assert.throws(() => validateRegeneration({
    project: current.project, plannedTrack: current.track, recording: values.recording,
    revisedPrompt: "A substantively revised instrumental prompt.",
    expected: { libraryTrackId: "stale", prompt: values.recording.prompt },
  }), /changed after it was displayed/);
  values.recording.reviewStatus = "Keep";
  assert.throws(() => validateRegeneration({
    project: current.project, plannedTrack: current.track, recording: values.recording,
    revisedPrompt: "A substantively revised instrumental prompt.",
    expected: { libraryTrackId: values.recording.id, prompt: values.recording.prompt },
  }), /marked Reject/);
});

test("safe regeneration commits an Unreviewed replacement before deleting the rejected recording", async (t) => {
  const values = await fixture(t);
  let paidCalls = 0;
  const result = await regenerateRejectedRecording({
    ...request(values),
    generateAudio: async () => { paidCalls += 1; return "replacement audio"; },
    saveAudio: async (audio) => { await writeFile(path.join(values.output, "replacement.mp3"), audio); return "replacement.mp3"; },
  });

  assert.equal(paidCalls, 1);
  assert.equal(result.replacement.reviewStatus, "Unreviewed");
  assert.equal(values.library.list().length, 1);
  assert.equal(values.library.list()[0].id, result.replacement.id);
  assert.equal(values.library.list().some((track) => track.id === values.recording.id), false);
  assert.equal(await readFile(path.join(values.output, "replacement.mp3"), "utf8"), "replacement audio");
  await assert.rejects(() => readFile(path.join(values.output, "rejected.mp3")), /ENOENT/);
  const linked = values.projects.getTrack(values.project.id, values.planned.id).track;
  assert.equal(linked.libraryTrackId, result.replacement.id);
  assert.equal(linked.prompt, request(values).revisedPrompt);
  assert.equal(linked.replacementCleanupId, undefined);

  const restartedLibrary = new TrackLibrary(values.output, values.dependencies);
  const restartedProjects = new ProjectStore(values.output, values.dependencies);
  await restartedLibrary.initialize();
  await restartedProjects.initialize();
  await recoverReplacementTransactions(restartedProjects, restartedLibrary);
  await restartedProjects.reconcileLibraryLinks(restartedLibrary.list());
  assert.equal(restartedProjects.getTrack(values.project.id, values.planned.id).track.libraryTrackId, result.replacement.id);
  assert.equal(restartedLibrary.get(result.replacement.id).reviewStatus, "Unreviewed");
});

test("generation failure makes one call and preserves the rejected recording and project link", async (t) => {
  const values = await fixture(t);
  let calls = 0;
  await assert.rejects(() => regenerateRejectedRecording({
    ...request(values),
    generateAudio: async () => { calls += 1; throw new Error("mock provider failure"); },
    saveAudio: async () => { throw new Error("must not save"); },
  }), /mock provider failure/);
  assert.equal(calls, 1);
  assert.equal(values.library.get(values.recording.id).reviewStatus, "Reject");
  assert.equal(values.projects.getTrack(values.project.id, values.planned.id).track.libraryTrackId, values.recording.id);
  assert.equal(await readFile(path.join(values.output, "rejected.mp3"), "utf8"), "original rejected audio");
});

test("project commit failure rolls back the prepared replacement and preserves the original", async (t) => {
  let failProjectWrites = false;
  const values = await fixture(t, {
    rename: async (source, destination) => {
      if (failProjectWrites && path.basename(destination) === "projects.json") throw new Error("mock project persistence failure");
      return fsRename(source, destination);
    },
  });
  failProjectWrites = true;
  await assert.rejects(() => regenerateRejectedRecording({
    ...request(values),
    generateAudio: async () => "replacement audio",
    saveAudio: async (audio) => { await writeFile(path.join(values.output, "rollback.mp3"), audio); return "rollback.mp3"; },
  }), /mock project persistence failure/);
  assert.equal(values.projects.getTrack(values.project.id, values.planned.id).track.libraryTrackId, values.recording.id);
  assert.equal(values.library.list().length, 1);
  assert.equal(values.library.get(values.recording.id).reviewStatus, "Reject");
  assert.equal(await readFile(path.join(values.output, "rejected.mp3"), "utf8"), "original rejected audio");
});

test("restart recovery deletes an abandoned prepared replacement without touching the original", async (t) => {
  const values = await fixture(t);
  await writeFile(path.join(values.output, "prepared.mp3"), "prepared audio");
  const prepared = await values.library.registerGenerated({
    filename: "prepared.mp3", title: values.planned.title, prompt: "Revised prepared instrumental prompt.",
    projectId: values.project.id, plannedTrackId: values.planned.id,
    replacementForLibraryTrackId: values.recording.id,
  });
  const recovery = await recoverReplacementTransactions(values.projects, values.library);
  await values.projects.reconcileLibraryLinks(values.library.list());
  assert.equal(recovery.pending, false);
  assert.equal(values.library.list().some((track) => track.id === prepared.id), false);
  assert.equal(values.library.get(values.recording.id).reviewStatus, "Reject");
  assert.equal(values.projects.getTrack(values.project.id, values.planned.id).track.libraryTrackId, values.recording.id);
});

test("missing committed replacement blocks recovery without relinking or deleting the rejected original", async (t) => {
  const values = await fixture(t);
  const missingReplacementId = "50000000-0000-4000-8000-999999999999";
  await values.projects.commitReplacement(values.project.id, values.planned.id, {
    oldLibraryTrackId: values.recording.id,
    newLibraryTrackId: missingReplacementId,
    prompt: "Revised instrumental prompt whose committed library entry is missing.",
  });

  const recovery = await recoverReplacementTransactions(values.projects, values.library, { error() {} });
  await values.projects.reconcileLibraryLinks(values.library.list());
  const interrupted = values.projects.getTrack(values.project.id, values.planned.id).track;
  assert.equal(recovery.pending, true);
  assert.match(recovery.message, /Paid generation is blocked/);
  assert.equal(interrupted.libraryTrackId, missingReplacementId);
  assert.equal(interrupted.replacementCleanupId, values.recording.id);
  assert.equal(values.library.get(values.recording.id).reviewStatus, "Reject");
  assert.equal(await readFile(path.join(values.output, "rejected.mp3"), "utf8"), "original rejected audio");
});

test("missing original during an uncommitted preparation preserves the prepared entry and blocks reconciliation", async (t) => {
  const values = await fixture(t);
  await writeFile(path.join(values.output, "unclassified-prepared.mp3"), "prepared audio");
  const prepared = await values.library.registerGenerated({
    filename: "unclassified-prepared.mp3", title: values.planned.title,
    prompt: "Revised instrumental prompt with missing original metadata.",
    projectId: values.project.id, plannedTrackId: values.planned.id,
    replacementForLibraryTrackId: values.recording.id,
  });
  await values.library.delete(values.recording.id);

  const recovery = await recoverReplacementTransactions(values.projects, values.library, { error() {} });
  await values.projects.reconcileLibraryLinks(values.library.list());
  assert.equal(recovery.pending, true);
  assert.equal(values.library.get(prepared.id).replacementForLibraryTrackId, values.recording.id);
  assert.equal(values.projects.getTrack(values.project.id, values.planned.id).track.libraryTrackId, values.recording.id);
  assert.equal(await readFile(path.join(values.output, "unclassified-prepared.mp3"), "utf8"), "prepared audio");
});

test("old-recording deletion failure keeps a recovery marker and restart completes cleanup", async (t) => {
  const values = await fixture(t);
  const originalDelete = values.library.delete.bind(values.library);
  let failOldDelete = true;
  values.library.delete = async (id) => {
    if (id === values.recording.id && failOldDelete) {
      failOldDelete = false;
      throw new Error("mock old recording cleanup failure");
    }
    return originalDelete(id);
  };
  const result = await regenerateRejectedRecording({
    ...request(values),
    logger: { error() {} },
    generateAudio: async () => "replacement audio",
    saveAudio: async (audio) => { await writeFile(path.join(values.output, "cleanup-recovery.mp3"), audio); return "cleanup-recovery.mp3"; },
  });
  assert.match(result.warning, /cleanup is pending/);
  const pending = values.projects.getTrack(values.project.id, values.planned.id).track;
  assert.equal(pending.libraryTrackId, result.replacement.id);
  assert.equal(pending.replacementCleanupId, values.recording.id);
  assert.equal(values.library.list().some((track) => track.id === values.recording.id), true);

  await recoverReplacementTransactions(values.projects, values.library);
  assert.equal(values.library.list().some((track) => track.id === values.recording.id), false);
  assert.equal(values.projects.getTrack(values.project.id, values.planned.id).track.replacementCleanupId, undefined);
});

test("a rejected recording referenced by another planned track is retained without a history UI", async (t) => {
  const values = await fixture(t);
  const other = values.project.tracks[1];
  await values.projects.linkGenerated(values.project.id, other.id, values.recording.id);
  const result = await regenerateRejectedRecording({
    ...request(values),
    generateAudio: async () => "replacement audio",
    saveAudio: async (audio) => { await writeFile(path.join(values.output, "shared-replacement.mp3"), audio); return "shared-replacement.mp3"; },
  });
  assert.equal(result.warning, undefined);
  assert.equal(values.library.list().some((track) => track.id === values.recording.id), true);
  assert.equal(values.projects.getTrack(values.project.id, other.id).track.libraryTrackId, values.recording.id);
  assert.equal(values.projects.getTrack(values.project.id, values.planned.id).track.libraryTrackId, result.replacement.id);
});
