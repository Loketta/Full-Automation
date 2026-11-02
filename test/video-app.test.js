import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { TrackLibrary } from "../src/library.js";
import { VideoAssemblyService } from "../src/video.js";

test("video API plans, renders, and downloads a completed mocked export", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-video-app-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const library = new TrackLibrary(output);
  await library.initialize();
  await writeFile(path.join(output, "api-music.mp3"), "api audio");
  const track = await library.registerGenerated({ filename: "api-music.mp3", title: "API Video", prompt: "Instrumental API video" });
  const runner = {
    async check() {},
    async run(_executable, args) { await writeFile(args.at(-1), "downloadable mp4"); },
  };
  const videoService = new VideoAssemblyService(output, library, {
    runner,
    randomUUID: () => "api-render",
    probeMedia: async (filePath) => filePath.endsWith(".mp3")
      ? { duration: 2, streams: [{ codecType: "audio", codecName: "mp3", duration: 2 }] }
      : filePath.includes("visual-assets")
        ? { duration: 0.5, streams: [{ codecType: "video", codecName: "h264", width: 320, height: 180 }] }
        : { duration: 2, streams: [
          { codecType: "video", codecName: "h264", width: 320, height: 180 },
          { codecType: "audio", codecName: "aac", duration: 2 },
        ] },
  });
  await videoService.initialize();
  await writeFile(path.join(output, "visual-assets", "Harbour.mp4"), "animation");
  const projects = { list: () => [], reconcileLibraryLinks: async () => [] };
  const app = createApp({
    client: {}, library, projects, videoService, outputDirectory: output, publicDirectory: path.join(root, "public"),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const assetsResponse = await fetch(`${base}/api/video-assets`);
  const assets = await assetsResponse.json();
  assert.equal(assets.status.available, true);
  assert.deepEqual(assets.assets.map((asset) => asset.filename), ["Harbour.mp4"]);

  const planResponse = await fetch(`${base}/api/videos/plan`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trackId: track.id, assetFilename: "Harbour.mp4" }),
  });
  const { plan } = await planResponse.json();
  assert.equal(plan.outputFilename, "api-video-harbour.mp4");
  assert.equal("audioPath" in plan, false);
  assert.equal("assetPath" in plan, false);

  const renderResponse = await fetch(`${base}/api/videos`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trackId: track.id, assetFilename: "Harbour.mp4", outputFilename: plan.outputFilename }),
  });
  const { video } = await renderResponse.json();
  assert.equal(renderResponse.status, 201);
  assert.equal(video.downloadUrl, "/videos/api-video-harbour.mp4");
  const download = await fetch(`${base}${video.downloadUrl}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.equal(await download.text(), "downloadable mp4");
});
