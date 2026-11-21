import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { ProjectStore, validateImport } from "../src/projects.js";
import { buildBatchSnapshot } from "../public/batch-state.js";
import { addAcceptedProjectRecordings, addRecordingToMix } from "../public/mix-state.js";
import { calculateMixDuration } from "../src/mixes.js";

function plan(name, start, count, metadata = {}) {
  return { version: 1, name, theme: metadata.theme ?? "Optimistic instrumental synthwave compilation.", thematicOpening: metadata.thematicOpening ?? "Music for the nights worth remembering.", genres: metadata.genres ?? ["synthwave"], moods: metadata.moods ?? ["optimistic"], targetDurationMinutes: metadata.targetDurationMinutes ?? 62, arrangementNotes: metadata.arrangementNotes ?? "Preserve the planned arc.", tracks: Array.from({ length: count }, (_value, index) => { const position = start + index; return { identifier: `neon-${position}`, title: `Neon Track ${position}`, direction: position % 3 ? "Energetic melodic drive." : "Moderate nostalgic passage.", prompt: `Instrumental synthwave for Neon Track ${position}, analogue synthesizers, driving drums and no vocals.`, energy: position % 3 ? "high" : "moderate", position }; }) };
}

async function fixture(t) { const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-project-expansion-")); t.after(() => rm(root, { recursive: true, force: true })); const output = path.join(root, "output"); let id = 0; const dependencies = { randomUUID: () => `id-${++id}`, now: () => new Date("2026-11-21T16:00:00Z") }; const store = new ProjectStore(output, dependencies); await store.initialize(); return { store, output, dependencies }; }

test("appends 15 ordered pending tracks to Neon Daybreak while preserving ten generated tracks and metadata", async (t) => {
  const values = await fixture(t); const original = await values.store.import(plan("Neon Daybreak", 1, 10)); const reviewStates = new Map();
  for (const [index, track] of original.tracks.entries()) { await values.store.linkGenerated(original.id, track.id, `recording-${index + 1}`); reviewStates.set(`recording-${index + 1}`, index % 2 ? "Keep" : "Reject"); }
  const before = values.store.get(original.id); const expansion = plan("Incoming Different Name", 11, 15, { theme: "A different incoming theme.", thematicOpening: "Music for a different night.", genres: ["retrowave"], moods: ["nostalgic"], targetDurationMinutes: 90, arrangementNotes: "Incoming notes must not replace destination notes." }); const preview = values.store.previewFileAppend(original.id, expansion, "neon-expansion.json");
  assert.equal(preview.destination.existingTrackCount, 10); assert.equal(preview.incomingTrackCount, 15); assert.equal(preview.resultingTrackCount, 25); assert.ok(preview.warnings.length >= 6);
  const { project, addedTrackIds } = await values.store.appendFile(original.id, expansion, { filename: "neon-expansion.json", snapshot: preview.snapshot }); assert.equal(addedTrackIds.length, 15); assert.deepEqual(project.tracks.slice(0, 10), before.tracks); assert.deepEqual(project.tracks.slice(10).map((track) => track.title), expansion.tracks.map((track) => track.title)); assert.ok(project.tracks.slice(10).every((track) => track.status === "Pending"));
  for (const track of project.tracks.slice(0, 10)) assert.equal(reviewStates.get(track.libraryTrackId), reviewStates.get(before.tracks.find((item) => item.id === track.id).libraryTrackId));
  assert.equal(project.name, before.name); assert.equal(project.theme, before.theme); assert.equal(project.thematicOpening, before.thematicOpening); assert.deepEqual(project.genres, before.genres); assert.deepEqual(project.moods, before.moods); assert.equal(project.targetDurationMinutes, 62); assert.equal(project.arrangementNotes, before.arrangementNotes);
  const selected = buildBatchSnapshot(project, project.tracks.slice(10, 15).map((track) => track.id)); assert.equal(selected.tracks.length, 5); assert.ok(selected.tracks.every((track) => track.title.startsWith("Neon Track 1")));
});

test("expansion duplicate payload, title, identifier and stale destination snapshot are rejected", async (t) => {
  const values = await fixture(t); const original = await values.store.import(plan("Base", 1, 10)); const expansion = plan("Expansion", 11, 15); const preview = values.store.previewFileAppend(original.id, expansion, "expansion.json"); await values.store.appendFile(original.id, expansion, { filename: "expansion.json", snapshot: preview.snapshot });
  assert.throws(() => values.store.previewFileAppend(original.id, { ...plan("Unsupported", 26, 1), version: 99 }, "unsupported.json"), /version must be 1/);
  assert.throws(() => values.store.previewFileAppend(original.id, expansion, "again.json"), /already been appended/);
  const duplicateTitle = plan("Title conflict", 26, 1); duplicateTitle.tracks[0].title = "Neon Track 1"; assert.throws(() => values.store.previewFileAppend(original.id, duplicateTitle, "title.json"), /duplicate destination titles/);
  const duplicateIdentifier = plan("ID conflict", 26, 1); duplicateIdentifier.tracks[0].identifier = "neon-1"; assert.throws(() => values.store.previewFileAppend(original.id, duplicateIdentifier, "identifier.json"), /conflicting track identifiers/);
  const fresh = plan("Fresh", 26, 1); const stale = values.store.previewFileAppend(original.id, fresh, "fresh.json"); await values.store.update(original.id, { theme: "Destination changed after preview." }); await assert.rejects(() => values.store.appendFile(original.id, fresh, { filename: "fresh.json", snapshot: stale.snapshot }), /changed after preview/);
});

test("append persistence is atomic and survives restart without paid generation", async (t) => {
  const values = await fixture(t); let paidCalls = 0; const original = await values.store.import(plan("Base", 1, 10)); const expansion = plan("Expansion", 11, 15); const preview = values.store.previewFileAppend(original.id, expansion, "expansion.json"); await values.store.appendFile(original.id, expansion, { filename: "expansion.json", snapshot: preview.snapshot }); assert.equal(paidCalls, 0);
  const restarted = new ProjectStore(values.output, values.dependencies); await restarted.initialize(); const project = restarted.get(original.id); assert.equal(project.tracks.length, 25); assert.equal(project.fileExpansions.length, 1); assert.throws(() => restarted.previewFileAppend(original.id, expansion, "expansion.json"), /already been appended/);
});

test("append write failure rolls back every new track and expansion marker", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-project-expansion-failure-")); t.after(() => rm(root, { recursive: true, force: true })); const output = path.join(root, "output"); let fail = false; let id = 0; const dependencies = { randomUUID: () => `failure-${++id}`, writeFile: async (...args) => { if (fail) throw new Error("disk unavailable"); return writeFile(...args); } }; const store = new ProjectStore(output, dependencies); await store.initialize(); const original = await store.import(plan("Base", 1, 10)); const expansion = plan("Expansion", 11, 15); const preview = store.previewFileAppend(original.id, expansion, "expansion.json"); fail = true;
  await assert.rejects(() => store.appendFile(original.id, expansion, { filename: "expansion.json", snapshot: preview.snapshot }), /disk unavailable/); assert.equal(store.get(original.id).tracks.length, 10); assert.equal(store.get(original.id).fileExpansions, undefined); fail = false; const restarted = new ProjectStore(output, dependencies); await restarted.initialize(); assert.equal(restarted.get(original.id).tracks.length, 10);
});

test("25-track convention and smaller legacy and expansion plans remain valid", async () => {
  assert.equal(validateImport(plan("Full", 1, 25)).tracks.length, 25); assert.equal(validateImport(plan("Legacy", 1, 3)).tracks.length, 3); assert.equal(validateImport(plan("Expansion", 1, 2)).tracks.length, 2);
  const example = JSON.parse(await readFile("public/examples/project-import-v1.json", "utf8")); assert.equal(validateImport(example).tracks.length, 25);
});

test("accepted recording selection remains independent, ordered and based only on selected actual durations", () => {
  const project = { tracks: [{ status: "Generated", recording: { id: "accepted-a", reviewStatus: "Keep" } }, { status: "Generated", recording: { id: "rejected", reviewStatus: "Reject" } }, { status: "Pending" }, { status: "Generated", recording: { id: "accepted-b", reviewStatus: "Keep" } }] };
  let selected = addAcceptedProjectRecordings([], project).trackIds; assert.deepEqual(selected, ["accepted-a", "accepted-b"]); selected = addRecordingToMix(selected.filter((id) => id !== "accepted-a"), "accepted-a").trackIds; assert.deepEqual(selected, ["accepted-b", "accepted-a"]);
  const summary = calculateMixDuration([{ duration: 1800.5 }, { duration: 1810 }], [{ duration: 8 }]); assert.equal(summary.totalSourceDuration, 3610.5); assert.equal(summary.totalCrossfadeOverlap, 8); assert.equal(summary.expectedDuration, 3602.5);
});
