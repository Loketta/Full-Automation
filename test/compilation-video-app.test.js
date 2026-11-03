import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { CompilationVideoService } from "../src/compilation-video.js";

test("compilation video API requires an approved snapshot, renders, and downloads", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-compilation-app-")); t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const service = new CompilationVideoService(output, {
    minimumSourceDuration: 0, randomUUID: () => "api",
    runner: { async check() {}, async run(_exe, args) { await writeFile(args.at(-1), "downloadable compilation"); } },
    probe: async (filePath) => filePath.endsWith("master.wav")
      ? { formatName: "wav", duration: 3.2, streams: [{ codecType: "audio", codecName: "pcm_s24le", sampleRate: 48000, channels: 2, duration: 3.2 }] }
      : filePath.includes("visual-assets")
        ? { formatName: "mp4", duration: 0.8, streams: [{ codecType: "video", width: 320, height: 180, duration: 0.8 }] }
        : { formatName: "mov,mp4", duration: 3.2, streams: [
          { codecType: "video", codecName: "h264", width: 1920, height: 1080, pixelFormat: "yuv420p", duration: 3.2 },
          { codecType: "audio", codecName: "aac", sampleRate: 48000, channels: 2, duration: 3.2 },
        ] },
  });
  await service.initialize(); await writeFile(path.join(output, "mixes", "master.wav"), "wav"); await writeFile(path.join(output, "visual-assets", "loop.mp4"), "visual");
  const app = createApp({ client: {}, library: { list: () => [] }, projects: { list: () => [] }, compilationVideoService: service, outputDirectory: output, publicDirectory: path.join(root, "public") });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close()); const base = `http://127.0.0.1:${server.address().port}`;
  const sources = await (await fetch(`${base}/api/compilation-videos/sources`)).json(); assert.deepEqual(sources.masters.map((item) => item.filename), ["master.wav"]);
  const planResponse = await fetch(`${base}/api/compilation-videos/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ masterFilename: "master.wav", assetFilename: "loop.mp4", title: "Complete" }) });
  const { plan } = await planResponse.json(); assert.equal(plan.outputFilename, "complete.mp4"); assert.ok(plan.snapshot);
  const stale = await fetch(`${base}/api/compilation-videos/render`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ masterFilename: "master.wav", assetFilename: "loop.mp4", outputFilename: plan.outputFilename, snapshot: "stale" }) });
  assert.equal(stale.status, 409);
  const response = await fetch(`${base}/api/compilation-videos/render`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ masterFilename: "master.wav", assetFilename: "loop.mp4", outputFilename: plan.outputFilename, snapshot: plan.snapshot }) });
  assert.equal(response.status, 201); const { video } = await response.json();
  const download = await fetch(`${base}${video.downloadUrl}`); assert.equal(download.status, 200); assert.match(download.headers.get("content-disposition"), /attachment/); assert.equal(await download.text(), "downloadable compilation");
});
