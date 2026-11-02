import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { TrackLibrary } from "../src/library.js";
import { buildFfmpegArgs, validateExportMedia, VideoAssemblyService, VideoConflictError, VideoRenderError, VideoUnavailableError, VideoValidationError } from "../src/video.js";

async function fixture(t, runner, serviceDependencies = {}) {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-video-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const library = new TrackLibrary(output);
  await library.initialize();
  await writeFile(path.join(output, "music.mp3"), "mock mp3 audio");
  const track = await library.registerGenerated({ filename: "music.mp3", title: "Harbour Theme", prompt: "Instrumental harbour theme" });
  const service = new VideoAssemblyService(output, library, {
    runner,
    executable: "C:\\Tools\\ffmpeg.exe",
    probeExecutable: "C:\\Tools\\ffprobe.exe",
    randomUUID: () => "render-job-1",
    probeMedia: async (filePath) => {
      if (filePath.endsWith(".mp3")) return { duration: 2, streams: [{ codecType: "audio", codecName: "mp3", duration: 2 }] };
      if (filePath.includes("visual-assets")) return { duration: 0.5, streams: [{ codecType: "video", codecName: "h264", width: 1672, height: 942, duration: 0.5 }] };
      return { duration: 2.02, streams: [
        { codecType: "video", codecName: "h264", width: 1672, height: 942, duration: 2.02 },
        { codecType: "audio", codecName: "aac", duration: 2 },
      ] };
    },
    ...serviceDependencies,
  });
  await service.initialize();
  await writeFile(path.join(output, "visual-assets", "Harbour Docks Master.mp4"), "mock 1672x942 animation");
  return { root, output, library, track, service };
}

function successfulRunner() {
  return {
    checked: [], calls: [],
    async check(executable) { this.checked.push(executable); },
    async run(executable, args) {
      this.calls.push({ executable, args });
      await writeFile(args.at(-1), "completed mp4");
    },
  };
}

test("FFmpeg arguments safely loop animation, map complete audio, and produce compatible H.264/AAC MP4", () => {
  const args = buildFfmpegArgs({ audioPath: "C:\\audio\\track.mp3", assetPath: "C:\\visuals\\loop.mp4", outputPath: "C:\\videos\\out.mp4" });
  assert.deepEqual(args.slice(0, 8), ["-hide_banner", "-n", "-stream_loop", "-1", "-i", "C:\\visuals\\loop.mp4", "-i", "C:\\audio\\track.mp3"]);
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-vf")), ["-map", "0:v:0", "-map", "1:a:0"]);
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuv420p");
  assert.equal(args[args.indexOf("-movflags") + 1], "+faststart");
  assert.ok(args.includes("-shortest"));
  assert.equal(args[args.indexOf("-vf") + 1], "scale=trunc(iw/2)*2:trunc(ih/2)*2");
  assert.equal(args.at(-1), "C:\\videos\\out.mp4");
});

test("discovers local MP4 assets, plans without overwrite, and publishes only a complete output", async (t) => {
  const runner = successfulRunner();
  const values = await fixture(t, runner);
  const assets = await values.service.listAssets();
  assert.deepEqual(assets.map((asset) => asset.filename), ["Harbour Docks Master.mp4"]);
  const plan = await values.service.plan(values.track.id, assets[0].filename);
  assert.equal(plan.outputFilename, "harbour-theme-harbour-docks-master.mp4");
  const video = await values.service.render({ trackId: values.track.id, assetFilename: assets[0].filename, outputFilename: plan.outputFilename });
  assert.equal(video.downloadUrl, "/videos/harbour-theme-harbour-docks-master.mp4");
  assert.equal(await readFile(path.join(values.output, "videos", plan.outputFilename), "utf8"), "completed mp4");
  assert.equal(await readFile(path.join(values.output, "music.mp3"), "utf8"), "mock mp3 audio");
  assert.equal(await readFile(path.join(values.output, "visual-assets", assets[0].filename), "utf8"), "mock 1672x942 animation");
  const next = await values.service.plan(values.track.id, assets[0].filename);
  assert.equal(next.outputFilename, "harbour-theme-harbour-docks-master-2.mp4");
  assert.deepEqual(runner.checked, ["C:\\Tools\\ffmpeg.exe", "C:\\Tools\\ffprobe.exe"]);
  assert.equal(runner.calls.length, 1);
});

test("rejects traversal, missing recordings, and missing or empty visual assets", async (t) => {
  const values = await fixture(t, successfulRunner());
  await assert.rejects(() => values.service.plan(values.track.id, "../outside.mp4"), VideoValidationError);
  await assert.rejects(() => values.service.plan("missing-track", "Harbour Docks Master.mp4"), /recording not found/);
  await assert.rejects(() => values.service.plan(values.track.id, "missing.mp4"), /visual asset is missing/);
  await writeFile(path.join(values.output, "visual-assets", "empty.mp4"), "");
  await assert.rejects(() => values.service.plan(values.track.id, "empty.mp4"), /visual asset is missing/);
  await assert.rejects(() => values.service.render({
    trackId: values.track.id, assetFilename: "Harbour Docks Master.mp4", outputFilename: "../escape.mp4",
  }), VideoValidationError);
});

test("missing FFmpeg is reported clearly without installation or rendering", async (t) => {
  const runner = { async check() { throw new Error("ENOENT"); }, async run() { throw new Error("must not run"); } };
  const values = await fixture(t, runner);
  assert.equal(values.service.status().available, false);
  assert.match(values.service.status().error, /Install FFmpeg locally|FFMPEG_PATH/);
  await assert.rejects(() => values.service.plan(values.track.id, "Harbour Docks Master.mp4"), VideoUnavailableError);
});

test("FFmpeg failure removes partial output and never presents it as a completed export", async (t) => {
  const runner = {
    async check() {},
    async run(_executable, args) {
      await writeFile(args.at(-1), "partial mp4");
      throw new Error("mock FFmpeg failure");
    },
  };
  const values = await fixture(t, runner);
  const plan = await values.service.plan(values.track.id, "Harbour Docks Master.mp4");
  await assert.rejects(() => values.service.render({ trackId: values.track.id, assetFilename: "Harbour Docks Master.mp4", outputFilename: plan.outputFilename }), /mock FFmpeg failure/);
  assert.deepEqual(await readdir(path.join(values.output, "videos")), []);
  assert.equal(values.service.status().active, false);
});

test("FFprobe validation rejects missing streams, wrong codecs, dimensions, and truncated output", () => {
  const audioMedia = { duration: 4, streams: [{ codecType: "audio", codecName: "mp3", duration: 4 }] };
  const assetMedia = { duration: 1, streams: [{ codecType: "video", codecName: "h264", width: 1672, height: 942 }] };
  const valid = { duration: 4.05, streams: [
    { codecType: "video", codecName: "h264", width: 1672, height: 942 },
    { codecType: "audio", codecName: "aac", duration: 4.02 },
  ] };
  assert.deepEqual(validateExportMedia({ audioMedia, assetMedia, outputMedia: valid }), {
    audioDuration: 4, outputDuration: 4.02, width: 1672, height: 942,
  });
  assert.throws(() => validateExportMedia({ audioMedia, assetMedia, outputMedia: { ...valid, streams: [valid.streams[0]] } }), /AAC audio/);
  assert.throws(() => validateExportMedia({ audioMedia, assetMedia, outputMedia: { ...valid, streams: [{ ...valid.streams[0], codecName: "vp9" }, valid.streams[1]] } }), /H\.264/);
  assert.throws(() => validateExportMedia({ audioMedia, assetMedia, outputMedia: { ...valid, streams: [{ ...valid.streams[0], width: 1280 }, valid.streams[1]] } }), /dimensions/);
  assert.throws(() => validateExportMedia({ audioMedia, assetMedia, outputMedia: { ...valid, duration: 2, streams: [valid.streams[0], { ...valid.streams[1], duration: 2 }] } }), /complete source audio/);
});

test("failed FFprobe output validation removes the temporary MP4 and preserves both inputs", async (t) => {
  const runner = successfulRunner();
  const values = await fixture(t, runner, {
    probeMedia: async (filePath) => {
      if (filePath.endsWith(".mp3")) return { duration: 3, streams: [{ codecType: "audio", codecName: "mp3", duration: 3 }] };
      if (filePath.includes("visual-assets")) return { duration: 1, streams: [{ codecType: "video", codecName: "h264", width: 1672, height: 942 }] };
      return { duration: 1, streams: [{ codecType: "video", codecName: "h264", width: 1672, height: 942 }] };
    },
  });
  const plan = await values.service.plan(values.track.id, "Harbour Docks Master.mp4");
  await assert.rejects(() => values.service.render({
    trackId: values.track.id, assetFilename: "Harbour Docks Master.mp4", outputFilename: plan.outputFilename,
  }), VideoRenderError);
  assert.deepEqual(await readdir(path.join(values.output, "videos")), []);
  assert.equal(await readFile(path.join(values.output, "music.mp3"), "utf8"), "mock mp3 audio");
  assert.equal(await readFile(path.join(values.output, "visual-assets", "Harbour Docks Master.mp4"), "utf8"), "mock 1672x942 animation");
});

test("interrupted temporary outputs are removed on startup", async (t) => {
  const values = await fixture(t, successfulRunner());
  await writeFile(path.join(values.output, "videos", ".rendering-interrupted.mp4"), "partial");
  const restarted = new VideoAssemblyService(values.output, values.library, { runner: successfulRunner() });
  await restarted.initialize();
  assert.deepEqual(await readdir(path.join(values.output, "videos")), []);
});

test("overlapping exports are rejected while the first mocked process is in flight", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const runner = {
    async check() {},
    async run(_executable, args) {
      await held;
      await writeFile(args.at(-1), "completed mp4");
    },
  };
  const values = await fixture(t, runner);
  const plan = await values.service.plan(values.track.id, "Harbour Docks Master.mp4");
  const first = values.service.render({ trackId: values.track.id, assetFilename: "Harbour Docks Master.mp4", outputFilename: plan.outputFilename });
  await assert.rejects(() => values.service.render({
    trackId: values.track.id, assetFilename: "Harbour Docks Master.mp4", outputFilename: "second.mp4",
  }), VideoConflictError);
  release();
  await first;
});

test("an occupied planned filename is never overwritten", async (t) => {
  const values = await fixture(t, successfulRunner());
  await writeFile(path.join(values.output, "videos", "occupied.mp4"), "existing export");
  await assert.rejects(() => values.service.render({
    trackId: values.track.id, assetFilename: "Harbour Docks Master.mp4", outputFilename: "occupied.mp4",
  }), /nothing was overwritten/);
  assert.equal(await readFile(path.join(values.output, "videos", "occupied.mp4"), "utf8"), "existing export");
});

test("atomic publication preserves a file that appears after rendering starts", async (t) => {
  let competingPath;
  const values = await fixture(t, successfulRunner(), {
    publish: async (_source, destination) => {
      competingPath = destination;
      await writeFile(destination, "competing export", { flag: "wx" });
      throw Object.assign(new Error("occupied"), { code: "EEXIST" });
    },
  });
  const plan = await values.service.plan(values.track.id, "Harbour Docks Master.mp4");
  await assert.rejects(() => values.service.render({
    trackId: values.track.id, assetFilename: "Harbour Docks Master.mp4", outputFilename: plan.outputFilename,
  }), /nothing was overwritten/);
  assert.equal(await readFile(competingPath, "utf8"), "competing export");
  assert.deepEqual((await readdir(path.join(values.output, "videos"))).filter((name) => name.startsWith(".rendering-")), []);
});
