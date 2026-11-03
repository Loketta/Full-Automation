import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { TrackLibrary } from "../src/library.js";
import { MixAssemblyService, MixStore } from "../src/mixes.js";

test("mix API saves a draft, requires its approved snapshot, renders, and downloads", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-mix-app-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const library = new TrackLibrary(output);
  await library.initialize();
  const tracks = [];
  for (const [filename, title] of [["one.mp3", "One"], ["two.mp3", "Two"]]) {
    await writeFile(path.join(output, filename), `${title} source audio`);
    tracks.push(await library.registerGenerated({ filename, title, prompt: `${title} instrumental prompt` }));
  }
  let storeId = 0;
  const store = new MixStore(output, { randomUUID: () => `mix-api-${++storeId}` });
  await store.initialize();
  const runner = {
    async check() {},
    async run(_executable, args) { await writeFile(args.at(-1), "validated wav master"); },
  };
  const mixService = new MixAssemblyService(output, library, store, {
    runner,
    minimumDurationSeconds: 1,
    randomUUID: () => "render-api",
    probe: async (filePath) => filePath.endsWith(".wav")
      ? { formatName: "wav", duration: 3.5, streams: [{ codecType: "audio", codecName: "pcm_s24le", sampleRate: 48000, channels: 2, duration: 3.5 }] }
      : { formatName: "mp3", duration: 2, streams: [{ codecType: "audio", codecName: "mp3", duration: 2 }] },
  });
  await mixService.initialize();
  const projects = { list: () => [], reconcileLibraryLinks: async () => [] };
  const app = createApp({ client: {}, library, projects, mixStore: store, mixService, outputDirectory: output, publicDirectory: path.join(root, "public") });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const createdResponse = await fetch(`${base}/api/mixes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "API Mix", trackIds: tracks.map((track) => track.id), crossfadeSeconds: 0.5 }),
  });
  assert.equal(createdResponse.status, 201);
  const { mix } = await createdResponse.json();

  const planResponse = await fetch(`${base}/api/mixes/${mix.id}/plan`, { method: "POST" });
  assert.equal(planResponse.status, 200);
  const { plan } = await planResponse.json();
  assert.equal(plan.expectedDuration, 3.5);

  const recordingResponse = await fetch(`${base}/api/mix-recordings`);
  assert.equal(recordingResponse.status, 200);
  assert.deepEqual((await recordingResponse.json()).recordings.map((recording) => recording.duration), [2, 2]);
  const previewResponse = await fetch(`${base}/api/mixes/preview`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trackIds: tracks.map((track) => track.id), crossfadeSeconds: 0.5 }),
  });
  assert.equal(previewResponse.status, 200);
  assert.equal((await previewResponse.json()).preview.expectedDuration, 3.5);

  const staleResponse = await fetch(`${base}/api/mixes/${mix.id}/render`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outputFilename: plan.outputFilename, snapshot: "stale" }),
  });
  assert.equal(staleResponse.status, 409);

  const renderResponse = await fetch(`${base}/api/mixes/${mix.id}/render`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outputFilename: plan.outputFilename, snapshot: plan.snapshot }),
  });
  assert.equal(renderResponse.status, 201);
  const { export: exported } = await renderResponse.json();
  const download = await fetch(`${base}${exported.downloadUrl}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.equal(await download.text(), "validated wav master");

  const missingIds = [tracks[0].id, "unavailable-library-id", tracks[1].id];
  const missingMix = await store.create({ title: "Unavailable Source", trackIds: missingIds, crossfadeSeconds: 8 });
  const preserveResponse = await fetch(`${base}/api/mixes/${missingMix.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Unavailable Source Saved", trackIds: missingIds, crossfadeSeconds: 8 }),
  });
  assert.equal(preserveResponse.status, 200);
  assert.deepEqual((await preserveResponse.json()).mix.trackIds, missingIds);
  const missingPlanResponse = await fetch(`${base}/api/mixes/${missingMix.id}/plan`, { method: "POST" });
  assert.equal(missingPlanResponse.status, 400);
  assert.match((await missingPlanResponse.json()).error, /unavailable-library-id/);
});
