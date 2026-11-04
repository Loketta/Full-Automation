import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rename as fsRename, rm, writeFile } from "node:fs/promises";
import { TrackLibrary } from "../src/library.js";
import { assertGenerationSnapshot, MAX_IMPORT_BYTES, ProjectConflictError, ProjectNotFoundError, ProjectStore, ProjectValidationError, validateImport } from "../src/projects.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-projects-"));
  const output = path.join(root, "output");
  t.after(() => rm(root, { recursive: true, force: true }));
  let id = 0;
  const dependencies = {
    randomUUID: () => `10000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    now: () => new Date("2026-11-01T15:00:00.000Z"),
  };
  return { root, output, dependencies };
}

const validImport = {
  version: 1,
  name: "Night City",
  theme: "Dark instrumental cyberpunk with industrial percussion.",
  tracks: [
    { title: "First", direction: "Slow mechanical opening.", prompt: "Instrumental cyberpunk with a slow mechanical opening. No vocals." },
    { title: "Second", direction: "Explosive distorted finale.", prompt: "Instrumental industrial techno with an explosive distorted finale. No vocals." },
  ],
};

test("creates projects and preserves edits across restart", async (t) => {
  const { output, dependencies } = await fixture(t);
  const store = new ProjectStore(output, dependencies);
  await store.initialize();
  const project = await store.create({ name: "Initial", theme: "Initial instrumental theme" });
  await store.update(project.id, { name: "Renamed", theme: "Updated instrumental theme" });
  const track = await store.addTrack(project.id, {
    title: "Track A",
    direction: "Mechanical rhythm",
    prompt: "Instrumental mechanical cyberpunk rhythm with no vocals.",
  });
  await store.updateTrack(project.id, track.id, { title: "Track A Revised" });

  const restarted = new ProjectStore(output, dependencies);
  const projects = await restarted.initialize();
  assert.equal(projects[0].name, "Renamed");
  assert.equal(projects[0].theme, "Updated instrumental theme");
  assert.equal(projects[0].tracks[0].title, "Track A Revised");
  assert.equal(projects[0].tracks[0].status, "Pending");
});

test("get returns a defensive project copy and uses the established not-found error", async (t) => {
  const { output, dependencies } = await fixture(t); const store = new ProjectStore(output, dependencies); await store.initialize(); const created = await store.create({ name: "Read only", theme: "A persistent instrumental theme" });
  const copy = store.get(created.id); copy.name = "Mutated elsewhere"; assert.equal(store.get(created.id).name, "Read only"); assert.throws(() => store.get("missing"), ProjectNotFoundError);
});

test("imports versioned JSON offline and preserves track order", async (t) => {
  const { output, dependencies } = await fixture(t);
  let paidCalls = 0;
  const unusedGenerator = () => { paidCalls += 1; };
  const store = new ProjectStore(output, dependencies);
  await store.initialize();
  const project = await store.import(validImport);

  assert.deepEqual(project.tracks.map((track) => track.title), ["First", "Second"]);
  assert.ok(project.tracks.every((track) => track.status === "Pending"));
  assert.equal(paidCalls, 0);
  assert.equal(typeof unusedGenerator, "function");
});

test("import validation rejects malformed, oversized, and invalid fields", () => {
  assert.throws(() => validateImport(null), ProjectValidationError);
  assert.throws(() => validateImport({ ...validImport, version: 2 }), /version must be 1/);
  assert.throws(() => validateImport({ ...validImport, tracks: [] }), /between 1 and 100/);
  assert.throws(() => validateImport({ ...validImport, tracks: [{ ...validImport.tracks[0], prompt: "short" }] }), /between 10 and 2000/);
  assert.throws(() => validateImport({ ...validImport, unexpected: true }), /unsupported field: unexpected/);
  assert.throws(() => validateImport({ ...validImport, theme: "x".repeat(MAX_IMPORT_BYTES) }), /128 KB or smaller/);
});

test("links generated library tracks and repairs project persistence failure on restart", async (t) => {
  const { output, dependencies } = await fixture(t);
  let failProjectPersist = false;
  const projects = new ProjectStore(output, {
    ...dependencies,
    rename: async (source, destination) => {
      if (failProjectPersist && path.basename(destination) === "projects.json") throw new Error("simulated project metadata failure");
      return fsRename(source, destination);
    },
  });
  const library = new TrackLibrary(output, dependencies);
  await library.initialize();
  await projects.initialize();
  const project = await projects.import(validImport);
  const planned = project.tracks[0];
  await writeFile(path.join(output, "generated.mp3"), "generated audio");
  const libraryTrack = await library.registerGenerated({
    filename: "generated.mp3",
    title: planned.title,
    prompt: planned.prompt,
    projectId: project.id,
    plannedTrackId: planned.id,
  });
  assert.equal(libraryTrack.title, planned.title);
  assert.equal(libraryTrack.prompt, planned.prompt);

  failProjectPersist = true;
  await assert.rejects(() => projects.linkGenerated(project.id, planned.id, libraryTrack.id), /simulated project metadata failure/);
  assert.equal(projects.getTrack(project.id, planned.id).track.status, "Generated");

  const restarted = new ProjectStore(output, dependencies);
  await restarted.initialize();
  await restarted.reconcileLibraryLinks(library.list());
  const recovered = restarted.getTrack(project.id, planned.id).track;
  assert.equal(recovered.status, "Generated");
  assert.equal(recovered.libraryTrackId, libraryTrack.id);
  assert.equal(await readFile(path.join(output, "generated.mp3"), "utf8"), "generated audio");
});

test("saved MP3 is recoverable when library metadata persistence fails", async (t) => {
  const { output, dependencies } = await fixture(t);
  const projects = new ProjectStore(output, dependencies);
  await projects.initialize();
  const project = await projects.import(validImport);
  const planned = project.tracks[0];
  let failLibraryPersist = true;
  const failingLibrary = new TrackLibrary(output, {
    ...dependencies,
    rename: async (source, destination) => {
      if (failLibraryPersist && path.basename(destination) === "library.json") throw new Error("simulated library metadata failure");
      return fsRename(source, destination);
    },
  });
  await failingLibrary.initialize();
  const filename = "saved-before-metadata-failure.mp3";
  await writeFile(path.join(output, filename), "safe generated audio");
  await assert.rejects(() => failingLibrary.registerGenerated({
    filename, title: planned.title, prompt: planned.prompt,
    projectId: project.id, plannedTrackId: planned.id,
  }), /simulated library metadata failure/);
  await projects.markSavedFile(project.id, planned.id, filename);
  assert.equal(projects.getTrack(project.id, planned.id).track.status, "Generated");

  failLibraryPersist = false;
  const restartedLibrary = new TrackLibrary(output, dependencies);
  await restartedLibrary.initialize();
  const restartedProjects = new ProjectStore(output, dependencies);
  await restartedProjects.initialize();
  await restartedProjects.reconcileLibraryLinks(restartedLibrary.list());

  const recovered = restartedProjects.getTrack(project.id, planned.id).track;
  assert.equal(recovered.status, "Generated");
  assert.equal(typeof recovered.libraryTrackId, "string");
  assert.equal(recovered.recoveryFilename, undefined);
  assert.equal(await readFile(path.join(output, filename), "utf8"), "safe generated audio");
});

test("deleting a project preserves generated audio and its library entry", async (t) => {
  const { output, dependencies } = await fixture(t);
  const library = new TrackLibrary(output, dependencies);
  const projects = new ProjectStore(output, dependencies);
  await library.initialize();
  await projects.initialize();
  const project = await projects.import(validImport);
  const planned = project.tracks[0];
  const audioPath = path.join(output, "preserved.mp3");
  await writeFile(audioPath, "preserved audio");
  const libraryTrack = await library.registerGenerated({
    filename: "preserved.mp3", title: planned.title, prompt: planned.prompt,
    projectId: project.id, plannedTrackId: planned.id,
  });
  await projects.linkGenerated(project.id, planned.id, libraryTrack.id);

  await projects.delete(project.id);
  assert.equal(projects.list().length, 0);
  assert.equal(library.list().length, 1);
  assert.equal(await readFile(audioPath, "utf8"), "preserved audio");
});

test("track deletion clears generated project references without affecting other MP3s", async (t) => {
  const { output, dependencies } = await fixture(t);
  const library = new TrackLibrary(output, dependencies);
  const projects = new ProjectStore(output, dependencies);
  await library.initialize();
  await projects.initialize();
  const project = await projects.import(validImport);
  const planned = project.tracks[0];
  await writeFile(path.join(output, "linked.mp3"), "linked");
  await writeFile(path.join(output, "unrelated.mp3"), "unrelated");
  const linked = await library.registerGenerated({
    filename: "linked.mp3", title: planned.title, prompt: planned.prompt,
    projectId: project.id, plannedTrackId: planned.id,
  });
  await library.registerGenerated({ filename: "unrelated.mp3", title: "Unrelated", prompt: "Unrelated instrumental" });
  await projects.linkGenerated(project.id, planned.id, linked.id);

  await library.delete(linked.id);
  await projects.reconcileLibraryLinks(library.list());
  const reconciled = projects.getTrack(project.id, planned.id).track;
  assert.equal(reconciled.status, "Pending");
  assert.equal(reconciled.libraryTrackId, undefined);
  assert.equal(await readFile(path.join(output, "unrelated.mp3"), "utf8"), "unrelated");
});

test("project metadata write failure rolls ordinary edits back", async (t) => {
  const { output, dependencies } = await fixture(t);
  let fail = false;
  const store = new ProjectStore(output, {
    ...dependencies,
    rename: async (source, destination) => {
      if (fail && path.basename(destination) === "projects.json") throw new Error("write failed");
      return fsRename(source, destination);
    },
  });
  await store.initialize();
  const project = await store.create({ name: "Safe", theme: "Safe theme" });
  fail = true;
  await assert.rejects(() => store.update(project.id, { name: "Lost edit" }), /write failed/);
  assert.equal(store.list()[0].name, "Safe");
});

test("explicit legacy-link repair is atomic and rejects stale or conflicting projects", async (t) => {
  const { output, dependencies } = await fixture(t); const store = new ProjectStore(output, dependencies); await store.initialize(); const project = await store.import(validImport); const [first, second] = project.tracks;
  await assert.rejects(() => store.repairLegacyLinks(project.id, [{ plannedTrackId: first.id, libraryTrackId: "recording-a" }], { ...project, name: "stale" }), ProjectConflictError);
  await store.linkGenerated(project.id, second.id, "existing-recording"); const current = store.get(project.id);
  await assert.rejects(() => store.repairLegacyLinks(project.id, [{ plannedTrackId: second.id, libraryTrackId: "different-recording" }], current), /already linked to a different recording/);
  assert.equal(store.getTrack(project.id, first.id).track.libraryTrackId, undefined);
  const repaired = await store.repairLegacyLinks(project.id, [{ plannedTrackId: first.id, libraryTrackId: "recording-a" }], current); assert.equal(repaired.tracks[0].libraryTrackId, "recording-a"); assert.equal(repaired.tracks[1].libraryTrackId, "existing-recording");
});

test("server snapshot verification blocks stale paid-generation data", () => {
  const track = {
    title: "Saved",
    direction: "Saved direction",
    prompt: "Saved instrumental generation prompt.",
  };
  assert.doesNotThrow(() => assertGenerationSnapshot(track, { ...track }));
  let paidCalls = 0;
  assert.throws(
    () => {
      assertGenerationSnapshot(track, { ...track, prompt: "Unsaved edited prompt" });
      paidCalls += 1;
    },
    (error) => error.statusCode === 409 && /changed after it was displayed/.test(error.message),
  );
  assert.equal(paidCalls, 0);
  assert.throws(() => assertGenerationSnapshot(track, undefined), (error) => error.statusCode === 409);
});
