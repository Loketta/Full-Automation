import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { ProjectPlanService, assertSafePlanId } from "../src/project-plans.js";
import { ProjectStore } from "../src/projects.js";
import { TrackLibrary } from "../src/library.js";

function payload(name = "Repository Plan") {
  return {
    version: 1, name, theme: "Instrumental cyberpunk industrial music.",
    tracks: [
      { title: "First", direction: "Driving industrial rhythm.", prompt: "Instrumental machinery, dark synthesizers and percussion. No vocals." },
      { title: "Second", direction: "Slower mechanical atmosphere.", prompt: "Instrumental dark ambient machinery with restrained percussion. No vocals." },
    ],
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-project-plans-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plans = path.join(root, "project-plans");
  const output = path.join(root, "output");
  const projects = new ProjectStore(output);
  await projects.initialize();
  const service = new ProjectPlanService(plans, output, projects);
  await service.initialize();
  return { root, plans, output, projects, service };
}

test("discovers and validates repository plans without modifying them", async (t) => {
  const values = await fixture(t);
  const file = path.join(values.plans, "valid-plan.json");
  const original = `${JSON.stringify(payload(), null, 2)}\n`;
  await writeFile(file, original);
  const [plan] = await values.service.list();
  assert.equal(plan.id, "valid-plan.json");
  assert.equal(plan.name, "Repository Plan");
  assert.equal(plan.theme, "Instrumental cyberpunk industrial music.");
  assert.equal(plan.trackCount, 2);
  assert.equal(plan.status, "Available");
  assert.equal(plan.canImport, true);
  assert.equal(await readFile(file, "utf8"), original);
});

test("reports malformed, invalid, and oversized plans independently", async (t) => {
  const values = await fixture(t);
  await writeFile(path.join(values.plans, "malformed.json"), "{not json");
  await writeFile(path.join(values.plans, "invalid.json"), JSON.stringify({ ...payload(), version: 2 }));
  await writeFile(path.join(values.plans, "oversized.json"), Buffer.alloc(128 * 1024 + 1, 32));
  const plans = await values.service.list();
  assert.equal(plans.length, 3);
  assert.match(plans.find((plan) => plan.id === "malformed.json").error, /malformed JSON/);
  assert.match(plans.find((plan) => plan.id === "invalid.json").error, /version must be 1/);
  assert.match(plans.find((plan) => plan.id === "oversized.json").error, /128 KB or smaller/);
  assert.ok(plans.every((plan) => plan.valid === false));
});

test("rejects unsafe identifiers and does not follow plan symlinks", async (t) => {
  const values = await fixture(t);
  assert.throws(() => assertSafePlanId("../secret.json"), /Invalid repository plan filename/);
  assert.throws(() => assertSafePlanId(path.resolve(values.root, "secret.json")), /Invalid repository plan filename/);
  await assert.rejects(() => values.service.import("../secret.json"), /Invalid repository plan filename/);
  const outside = path.join(values.root, "outside.json");
  await writeFile(outside, JSON.stringify(payload("Outside")));
  try { await symlink(outside, path.join(values.plans, "linked.json"), "file"); }
  catch (error) { if (error.code === "EPERM") { t.skip("Creating symlinks requires Windows Developer Mode."); return; } throw error; }
  const [linked] = await values.service.list();
  assert.equal(linked.valid, false);
  assert.match(linked.error, /symbolic link/);
  assert.equal("name" in linked, false);
});

test("imports through ProjectStore preserving fields and order, then prevents duplicates", async (t) => {
  const values = await fixture(t);
  await writeFile(path.join(values.plans, "ordered.json"), JSON.stringify(payload()));
  const imported = await values.service.import("ordered.json");
  assert.deepEqual(imported.tracks.map((track) => ({ title: track.title, direction: track.direction, prompt: track.prompt, status: track.status })), [
    { ...payload().tracks[0], status: "Pending" }, { ...payload().tracks[1], status: "Pending" },
  ]);
  assert.equal(imported.sourcePlan.id, "ordered.json");
  await assert.rejects(() => values.service.import("ordered.json"), /already been imported/);
  assert.equal(values.projects.list().length, 1);
});

test("import history survives restart, identifies revisions, and never overwrites an edited project", async (t) => {
  const values = await fixture(t);
  const file = path.join(values.plans, "revisable.json");
  await writeFile(file, JSON.stringify(payload("Original")));
  const original = await values.service.import("revisable.json");
  await values.projects.update(original.id, { name: "Locally Edited" });

  const restarted = new ProjectPlanService(values.plans, values.output, values.projects);
  await restarted.initialize();
  assert.equal((await restarted.list())[0].status, "Imported");
  await writeFile(file, JSON.stringify(payload("Revised")));
  const revised = (await restarted.list())[0];
  assert.equal(revised.status, "Revised version available");
  assert.equal(revised.canImport, true);
  assert.equal(values.projects.list()[0].name, "Locally Edited");
  const revisionProject = await restarted.import("revisable.json");
  assert.equal(revisionProject.name, "Revised");
  assert.equal(values.projects.list()[0].name, "Locally Edited");
});

test("deleting an imported project keeps history and permits explicit reimport", async (t) => {
  const values = await fixture(t);
  await writeFile(path.join(values.plans, "reimport.json"), JSON.stringify(payload()));
  const first = await values.service.import("reimport.json");
  await values.projects.delete(first.id);
  const [available] = await values.service.list();
  assert.equal(available.status, "Previously imported project deleted — reimport available");
  assert.equal(available.canImport, true);
  const second = await values.service.import("reimport.json");
  assert.notEqual(second.id, first.id);
  assert.equal(values.projects.list().length, 1);
});

test("appends ordered Pending tracks atomically while preserving all existing project data", async (t) => {
  const values = await fixture(t);
  const library = new TrackLibrary(values.output); await library.initialize();
  await writeFile(path.join(values.output, "accepted.mp3"), "existing audio bytes");
  const recording = await library.registerGenerated({ filename: "accepted.mp3", title: "Accepted Recording", prompt: "Existing instrumental recording prompt" });
  await library.update(recording.id, { reviewStatus: "Keep" });
  const recordingBefore = library.get(recording.id);
  const audioBefore = await readFile(path.join(values.output, "accepted.mp3"));
  const target = await values.projects.import({ ...payload("Existing"), tracks: [payload().tracks[0]] });
  await values.projects.linkGenerated(target.id, target.tracks[0].id, recording.id);
  const before = values.projects.list()[0];
  await writeFile(path.join(values.plans, "expansion.json"), JSON.stringify(payload("Expansion")));
  const approval = await values.service.prepareAppend("expansion.json", target.id);
  const appended = await values.service.append("expansion.json", approval);

  assert.equal(appended.id, before.id);
  assert.equal(appended.name, before.name);
  assert.equal(appended.theme, before.theme);
  assert.equal(appended.createdAt, before.createdAt);
  assert.deepEqual(appended.tracks.slice(0, 1), before.tracks);
  assert.deepEqual(appended.tracks.slice(1).map((track) => ({ title: track.title, direction: track.direction, prompt: track.prompt, status: track.status, libraryTrackId: track.libraryTrackId })), [
    { ...payload().tracks[0], status: "Pending", libraryTrackId: undefined },
    { ...payload().tracks[1], status: "Pending", libraryTrackId: undefined },
  ]);
  assert.deepEqual(appended.tracks.map((track) => track.title), ["First", "First", "Second"]);
  assert.equal(appended.appendedPlans[0].fingerprint, approval.planFingerprint);
  assert.deepEqual(library.get(recording.id), recordingBefore);
  assert.deepEqual(await readFile(path.join(values.output, "accepted.mp3")), audioBefore);
});

test("prevents duplicate append after restart and explicitly supports revised versions", async (t) => {
  const values = await fixture(t);
  const target = await values.projects.create({ name: "Target", theme: "Existing theme" });
  const file = path.join(values.plans, "versioned.json");
  await writeFile(file, JSON.stringify(payload("Version One")));
  const firstApproval = await values.service.prepareAppend("versioned.json", target.id);
  await values.service.append("versioned.json", firstApproval);

  const restartedProjects = new ProjectStore(values.output); await restartedProjects.initialize();
  const restarted = new ProjectPlanService(values.plans, values.output, restartedProjects); await restarted.initialize();
  const listed = (await restarted.list())[0];
  assert.equal(listed.status, "Appended to 1 project");
  assert.deepEqual(listed.appendedTargets, [{ id: target.id, name: "Target" }]);
  await assert.rejects(() => restarted.prepareAppend("versioned.json", target.id), /already been appended/);
  await writeFile(file, JSON.stringify({ ...payload("Version Two"), tracks: [payload().tracks[1]] }));
  const revisedApproval = await restarted.prepareAppend("versioned.json", target.id);
  assert.equal(revisedApproval.revised, true);
  const revised = await restarted.append("versioned.json", revisedApproval);
  assert.deepEqual(revised.tracks.map((track) => track.title), ["First", "Second", "Second"]);
});

test("rejects stale plan and project approvals plus deleted or invalid targets", async (t) => {
  const values = await fixture(t);
  const target = await values.projects.create({ name: "Target", theme: "Existing theme" });
  const file = path.join(values.plans, "stale.json");
  await writeFile(file, JSON.stringify(payload("Original")));
  const stalePlan = await values.service.prepareAppend("stale.json", target.id);
  await writeFile(file, JSON.stringify(payload("Changed")));
  await assert.rejects(() => values.service.append("stale.json", stalePlan), /plan changed/);

  const staleProject = await values.service.prepareAppend("stale.json", target.id);
  await values.projects.update(target.id, { theme: "Changed existing theme" });
  await assert.rejects(() => values.service.append("stale.json", staleProject), /target project changed/);
  await assert.rejects(() => values.service.prepareAppend("stale.json", "missing"), /Target project not found/);
  const deletedApproval = await values.service.prepareAppend("stale.json", target.id);
  await values.projects.delete(target.id);
  await assert.rejects(() => values.service.append("stale.json", deletedApproval), /Target project not found/);
});

test("project persistence failure leaves no partial append", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-project-append-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output"); const plans = path.join(root, "project-plans");
  let failWrites = false;
  const projects = new ProjectStore(output, { writeFile: async (...args) => { if (failWrites) throw new Error("project write failed"); return writeFile(...args); } });
  await projects.initialize();
  const target = await projects.create({ name: "Target", theme: "Existing theme" });
  const service = new ProjectPlanService(plans, output, projects); await service.initialize();
  await writeFile(path.join(plans, "failure.json"), JSON.stringify(payload()));
  const approval = await service.prepareAppend("failure.json", target.id);
  failWrites = true;
  await assert.rejects(() => service.append("failure.json", approval), /project write failed/);
  assert.equal(projects.list()[0].tracks.length, 0);
  assert.equal(projects.list()[0].appendedPlans, undefined);
});

test("history persistence failure cannot make a retry duplicate appended tracks", async (t) => {
  const values = await fixture(t);
  const target = await values.projects.create({ name: "Target", theme: "Existing theme" });
  await writeFile(path.join(values.plans, "history-failure.json"), JSON.stringify({ ...payload(), tracks: [payload().tracks[0]] }));
  const service = new ProjectPlanService(values.plans, values.output, values.projects, {
    writeFile: async (filePath, ...args) => {
      if (path.basename(filePath).startsWith(".project-plan-imports.")) throw new Error("history write failed");
      return writeFile(filePath, ...args);
    },
  });
  await service.initialize();
  const approval = await service.prepareAppend("history-failure.json", target.id);
  await assert.rejects(() => service.append("history-failure.json", approval), /history write failed/);
  assert.equal(values.projects.list()[0].tracks.length, 1);
  await assert.rejects(() => service.append("history-failure.json", approval), /already been appended/);
  assert.equal(values.projects.list()[0].tracks.length, 1);
});

test("append planning enforces the existing 100-track project limit", async (t) => {
  const values = await fixture(t);
  const template = payload().tracks[0];
  const target = await values.projects.import({ ...payload("Nearly Full"), tracks: Array.from({ length: 99 }, (_value, index) => ({ ...template, title: `Existing ${index + 1}` })) });
  await writeFile(path.join(values.plans, "too-many.json"), JSON.stringify(payload("Two More")));
  await assert.rejects(() => values.service.prepareAppend("too-many.json", target.id), /exceed the 100-track project limit/);
  assert.equal(values.projects.list()[0].tracks.length, 99);
});
