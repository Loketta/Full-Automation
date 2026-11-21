import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { ProjectStore, validateImport } from "../src/projects.js";
import { projectProgress } from "../src/regeneration.js";
import { buildBatchSnapshot } from "../public/batch-state.js";

function neonPlan() {
  const titles = ["First Light on Chrome", "Electric Boulevard", "Weekend in the Megacity", "Sunset Frequency", "Skyline Runner", "Arcade Hearts", "Summer on the Rooftops", "Midnight Overdrive", "Tomorrow Looks Electric", "One More Sunrise"];
  const moderate = new Set([3, 6, 9]);
  return {
    version: 1, name: "Neon Daybreak", theme: "Optimistic, colourful 1980s-inspired cyberpunk synthwave and retrowave. Warm analogue synthesizers, memorable melodies, driving drum machines and a sense of freedom and adventure.", thematicOpening: "Music for the nights worth remembering.", genres: ["synthwave", "retrowave"], moods: ["optimistic", "nostalgic", "adventurous"], targetDurationMinutes: 62, arrangementNotes: "Seven energetic tracks balanced by three moderate, nostalgic passages.",
    tracks: titles.map((title, index) => ({ identifier: `track-${index + 1}`, title, direction: moderate.has(index) ? "Moderate nostalgic synthwave passage." : "Energetic melodic cyberpunk drive.", prompt: `Instrumental optimistic synthwave for ${title}, warm analogue synthesizers, memorable melody, driving drum machines and no vocals.`, energy: moderate.has(index) ? "moderate" : "high", tempo: moderate.has(index) ? { minBpm: 96, maxBpm: 106 } : { minBpm: 116, maxBpm: 126 }, position: index + 1, arrangementNotes: `Position ${index + 1} in the planned compilation.` })),
  };
}

async function fixture(t) { const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-structured-import-")); t.after(() => rm(root, { recursive: true, force: true })); const output = path.join(root, "output"); let id = 0; const dependencies = { randomUUID: () => `id-${++id}`, now: () => new Date("2026-11-21T12:00:00Z") }; const store = new ProjectStore(output, dependencies); await store.initialize(); return { store, output, dependencies }; }

test("Neon Daybreak validates, previews energy distribution, and imports without paid work", async (t) => {
  const values = await fixture(t); let paidCalls = 0; const plan = neonPlan(); const preview = values.store.previewFileImport(plan, "neon-daybreak.json");
  assert.equal(preview.trackCount, 10); assert.deepEqual(preview.energyDistribution, { high: 7, moderate: 3, low: 0 }); assert.equal(preview.plan.targetDurationMinutes, 62); assert.deepEqual(preview.warnings, []);
  const project = await values.store.importFile(plan, { filename: "neon-daybreak.json", snapshot: preview.snapshot }); assert.equal(paidCalls, 0); assert.deepEqual(project.tracks.map((track) => track.title), plan.tracks.map((track) => track.title)); assert.ok(project.tracks.every((track) => track.status === "Pending"));
  assert.deepEqual(projectProgress(project.tracks), { accepted: 0, rejected: 0, awaitingReview: 0, pending: 10 }); assert.equal(buildBatchSnapshot(project, project.tracks.slice(0, 5).map((track) => track.id)).tracks.length, 5);
});

test("structured validation rejects schema, required-field, prompt, opening, energy, identifiers, order and unsafe filenames", async (t) => {
  const values = await fixture(t); const plan = neonPlan();
  assert.throws(() => validateImport({ ...plan, version: 2 }), /version/); assert.throws(() => validateImport({ ...plan, theme: undefined }), /required/); assert.throws(() => validateImport({ ...plan, tracks: [{ ...plan.tracks[0], prompt: "short" }] }), /between 10 and 2000/); assert.throws(() => validateImport({ ...plan, thematicOpening: "A neon night." }), /begin with/); assert.throws(() => validateImport({ ...plan, tracks: [{ ...plan.tracks[0], energy: "extreme" }] }), /high, moderate, or low/);
  assert.throws(() => validateImport({ ...plan, tracks: plan.tracks.map((track) => ({ ...track, identifier: "same" })) }), /unique/); assert.throws(() => validateImport({ ...plan, tracks: plan.tracks.map((track, index) => ({ ...track, position: index === 0 ? 2 : index + 1 })) }), /match the JSON track order/); assert.throws(() => values.store.previewFileImport(plan, "../neon.json"), /safe local/);
});

test("duplicate protection is atomic, preserves existing projects, and survives restart", async (t) => {
  const values = await fixture(t); const existing = await values.store.create({ name: "Existing", theme: "Existing instrumental project." }); const plan = neonPlan(); const preview = values.store.previewFileImport(plan, "neon.json"); await values.store.importFile(plan, { filename: "neon.json", snapshot: preview.snapshot });
  await assert.rejects(() => values.store.importFile(plan, { filename: "neon.json", snapshot: preview.snapshot }), /already been imported/); assert.equal(values.store.get(existing.id).name, "Existing");
  const restarted = new ProjectStore(values.output, values.dependencies); await restarted.initialize(); assert.equal(restarted.list().length, 2); assert.throws(() => restarted.previewFileImport(plan, "neon.json"), /already been imported/);
});

test("export/import round trip preserves planning data but excludes generated and machine state", async (t) => {
  const first = await fixture(t); const plan = neonPlan(); const preview = first.store.previewFileImport(plan, "neon.json"); const project = await first.store.importFile(plan, { filename: "neon.json", snapshot: preview.snapshot }); const exported = first.store.exportPlan(project.id);
  assert.deepEqual(exported, validateImport(plan)); assert.equal("id" in exported, false); assert.equal("fileImport" in exported, false); assert.ok(exported.tracks.every((track) => !("status" in track) && !("libraryTrackId" in track)));
  const second = await fixture(t); const secondPreview = second.store.previewFileImport(exported, "round-trip.json"); const roundTrip = await second.store.importFile(exported, { filename: "round-trip.json", snapshot: secondPreview.snapshot }); assert.equal(roundTrip.tracks[0].prompt, plan.tracks[0].prompt); assert.equal(roundTrip.tracks[0].energy, "high");
});
