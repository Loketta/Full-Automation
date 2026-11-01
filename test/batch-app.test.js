import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { BatchStore } from "../src/batches.js";
import { TrackLibrary } from "../src/library.js";
import { ProjectStore } from "../src/projects.js";

test("batch HTTP flow blocks overlapping single generation and durably saves each mocked result", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-batch-app-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const library = new TrackLibrary(output);
  const projects = new ProjectStore(output);
  const batches = new BatchStore(output);
  await library.initialize();
  await projects.initialize();
  await batches.initialize();
  await writeFile(path.join(output, "existing.mp3"), "existing audio");
  const existing = await library.registerGenerated({
    filename: "existing.mp3", title: "Existing", prompt: "Existing instrumental track prompt.",
  });
  const project = await projects.import({
    version: 1,
    name: "HTTP Batch",
    theme: "Offline batch integration test",
    tracks: [1, 2, 3].map((number) => ({
      title: `Track ${number}`,
      direction: `Direction ${number}`,
      prompt: `Instrumental offline test prompt ${number} with no vocals.`,
    })),
  });

  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const client = { interactions: { create: async () => {
    calls += 1;
    if (calls === 1) await firstHeld;
    return { steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/mpeg", data: "bXAz" }] }] };
  } } };
  const app = createApp({ client, library, projects, batches, outputDirectory: output, publicDirectory: path.join(root, "public") });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const expected = {
    projectName: project.name,
    tracks: project.tracks.slice(0, 2).map(({ id, title, direction, prompt }) => ({ id, title, direction, prompt })),
  };

  const startedResponse = await fetch(`${base}/api/projects/${project.id}/batches`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected }),
  });
  assert.equal(startedResponse.status, 202);
  const { batch: started } = await startedResponse.json();
  while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));

  const overlap = await fetch(`${base}/api/projects/${project.id}/tracks/${project.tracks[2].id}/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected: project.tracks[2] }),
  });
  assert.equal(overlap.status, 409);
  assert.equal(calls, 1);

  releaseFirst();
  let finished;
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const response = await fetch(`${base}/api/batches/${started.id}`);
    ({ batch: finished } = await response.json());
    if (finished.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(finished.status, "completed");
  assert.equal(calls, 2);
  assert.equal(finished.completed.length, 2);
  assert.equal(library.list().length, 3);
  assert.ok(library.list().some((track) => track.id === existing.id));
  assert.equal(await readFile(path.join(output, "existing.mp3"), "utf8"), "existing audio");
  assert.ok(projects.list()[0].tracks.slice(0, 2).every((track) => track.status === "Generated"));
  assert.equal(projects.list()[0].tracks[2].status, "Pending");
});
