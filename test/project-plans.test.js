import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { ProjectPlanService, assertSafePlanId } from "../src/project-plans.js";
import { ProjectStore } from "../src/projects.js";

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
