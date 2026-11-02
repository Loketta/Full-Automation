import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { TrackLibrary } from "../src/library.js";
import { ProjectPlanService } from "../src/project-plans.js";
import { ProjectStore } from "../src/projects.js";

test("project plan API discovers and imports locally without invoking a generation client", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-project-plan-app-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const plansDirectory = path.join(root, "project-plans");
  const library = new TrackLibrary(output); await library.initialize();
  const projects = new ProjectStore(output); await projects.initialize();
  const projectPlans = new ProjectPlanService(plansDirectory, output, projects); await projectPlans.initialize();
  await writeFile(path.join(plansDirectory, "api-plan.json"), JSON.stringify({
    version: 1, name: "API Plan", theme: "Local instrumental plan.", tracks: [
      { title: "Pending One", direction: "Mechanical rhythm.", prompt: "Instrumental mechanical rhythm with synthesizers and no vocals." },
    ],
  }));
  let generationAccessed = false;
  const client = new Proxy({}, { get() { generationAccessed = true; throw new Error("Generation client must not be used."); } });
  const app = createApp({ client, library, projects, projectPlans, outputDirectory: output, publicDirectory: path.join(root, "public") });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const listResponse = await fetch(`${base}/api/project-plans`);
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json()).plans[0].name, "API Plan");
  const importResponse = await fetch(`${base}/api/project-plans/api-plan.json/import`, { method: "POST" });
  assert.equal(importResponse.status, 201);
  const imported = (await importResponse.json()).project;
  assert.equal(imported.tracks[0].status, "Pending");
  assert.equal(generationAccessed, false);
  const duplicate = await fetch(`${base}/api/project-plans/api-plan.json/import`, { method: "POST" });
  assert.equal(duplicate.status, 409);
  assert.equal(generationAccessed, false);
});
