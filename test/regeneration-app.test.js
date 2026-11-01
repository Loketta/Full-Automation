import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { BatchStore } from "../src/batches.js";
import { TrackLibrary } from "../src/library.js";
import { ProjectStore } from "../src/projects.js";

async function appFixture(t, { activeBatch = false, startupGenerationBlock } = {}) {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-regeneration-app-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const library = new TrackLibrary(output);
  const projects = new ProjectStore(output);
  const batches = new BatchStore(output);
  await library.initialize();
  await projects.initialize();
  await batches.initialize();
  const project = await projects.import({
    version: 1, name: "Regeneration API", theme: "Offline API test",
    tracks: [
      { title: "Rejected", direction: "Dark", prompt: "Original instrumental API prompt with no vocals." },
      { title: "Pending", direction: "Bright", prompt: "Pending instrumental API prompt with no vocals." },
    ],
  });
  const planned = project.tracks[0];
  await writeFile(path.join(output, "api-rejected.mp3"), "old audio");
  const old = await library.registerGenerated({
    filename: "api-rejected.mp3", title: planned.title, prompt: planned.prompt,
    projectId: project.id, plannedTrackId: planned.id,
  });
  await library.update(old.id, { reviewStatus: "Reject" });
  await projects.linkGenerated(project.id, planned.id, old.id);
  if (activeBatch) {
    const pending = project.tracks[1];
    await batches.create({
      projectId: project.id, projectName: project.name,
      tracks: [{ id: pending.id, title: pending.title, direction: pending.direction, prompt: pending.prompt }],
    });
  }
  let calls = 0;
  const client = { interactions: { create: async () => {
    calls += 1;
    return { steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/mpeg", data: "bmV3IGF1ZGlv" }] }] };
  } } };
  const app = createApp({ client, library, projects, batches, startupGenerationBlock, outputDirectory: output, publicDirectory: path.join(root, "public") });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    project, planned, old, library, projects,
    calls: () => calls,
  };
}

function regenerationBody(values) {
  return JSON.stringify({
    prompt: "Revised instrumental API prompt with stronger percussion and no vocals.",
    expected: { libraryTrackId: values.old.id, prompt: values.old.prompt },
  });
}

test("regeneration endpoint makes one mocked paid call and safely replaces the rejected recording", async (t) => {
  const values = await appFixture(t);
  const response = await fetch(`${values.base}/api/projects/${values.project.id}/tracks/${values.planned.id}/regenerate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: regenerationBody(values),
  });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.equal(values.calls(), 1);
  assert.equal(data.track.reviewStatus, "Unreviewed");
  assert.equal(values.projects.getTrack(values.project.id, values.planned.id).track.libraryTrackId, data.track.id);
  assert.equal(values.library.list().some((track) => track.id === values.old.id), false);
});

test("an active batch blocks regeneration before any mocked paid call", async (t) => {
  const values = await appFixture(t, { activeBatch: true });
  const response = await fetch(`${values.base}/api/projects/${values.project.id}/tracks/${values.planned.id}/regenerate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: regenerationBody(values),
  });
  assert.equal(response.status, 409);
  assert.equal(values.calls(), 0);
  assert.equal(values.projects.getTrack(values.project.id, values.planned.id).track.libraryTrackId, values.old.id);
});

test("pending startup recovery visibly blocks regeneration and standalone generation", async (t) => {
  const message = "Replacement recovery requires manual investigation before paid generation.";
  const values = await appFixture(t, { startupGenerationBlock: { blocked: true, outcomeUncertain: true, message } });
  const regeneration = await fetch(`${values.base}/api/projects/${values.project.id}/tracks/${values.planned.id}/regenerate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: regenerationBody(values),
  });
  const standalone = await fetch(`${values.base}/api/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Standalone instrumental prompt" }),
  });
  assert.equal(regeneration.status, 409);
  assert.equal(standalone.status, 409);
  assert.match((await regeneration.json()).error, /manual investigation/);
  assert.equal(values.calls(), 0);
});
