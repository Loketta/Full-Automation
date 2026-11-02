import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { TrackLibrary } from "../src/library.js";
import { probeMedia, SpawnProcessRunner, validateExportMedia, VideoAssemblyService } from "../src/video.js";

test("real FFmpeg pipeline loops shorter animation and FFprobe validates the complete MP4", { timeout: 60_000 }, async (t) => {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  const runner = new SpawnProcessRunner();
  try {
    await runner.check(ffmpeg);
    await runner.check(ffprobe);
  } catch (error) {
    const reason = `FFmpeg integration skipped: both FFmpeg and FFprobe are required (${error.message}).`;
    if (process.env.REQUIRE_FFMPEG_INTEGRATION === "1") assert.fail(reason);
    t.skip(reason);
    return;
  }

  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-video-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const library = new TrackLibrary(output);
  await library.initialize();
  const audioPath = path.join(output, "synthetic-audio.mp3");
  const assetPath = path.join(output, "visual-assets", "synthetic-loop.mp4");
  const service = new VideoAssemblyService(output, library, {
    executable: ffmpeg,
    probeExecutable: ffprobe,
    randomUUID: () => "real-integration-render",
  });
  await service.initialize();

  await runner.run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-n",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2.4",
    "-c:a", "libmp3lame", "-b:a", "128k", audioPath,
  ]);
  await runner.run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-n",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=0.7",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", assetPath,
  ]);
  const originalAudio = await readFile(audioPath);
  const originalAsset = await readFile(assetPath);
  const track = await library.registerGenerated({
    filename: "synthetic-audio.mp3", title: "Synthetic Integration", prompt: "Offline synthetic test audio",
  });

  const sourceAudio = await probeMedia(runner, ffprobe, audioPath);
  const sourceAsset = await probeMedia(runner, ffprobe, assetPath);
  assert.ok(sourceAsset.duration < sourceAudio.duration, `Expected ${sourceAsset.duration}s animation to be shorter than ${sourceAudio.duration}s audio.`);
  const plan = await service.plan(track.id, "synthetic-loop.mp4");
  const rendered = await service.render({
    trackId: track.id,
    assetFilename: "synthetic-loop.mp4",
    outputFilename: plan.outputFilename,
  });
  const exportedPath = path.join(output, "videos", rendered.filename);
  const exported = await probeMedia(runner, ffprobe, exportedPath);
  const validation = validateExportMedia({ audioMedia: sourceAudio, assetMedia: sourceAsset, outputMedia: exported, toleranceSeconds: 0.35 });
  const video = exported.streams.find((stream) => stream.codecType === "video");
  const audio = exported.streams.find((stream) => stream.codecType === "audio");

  assert.equal(video.codecName, "h264");
  assert.equal(audio.codecName, "aac");
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.ok(Math.abs(validation.outputDuration - validation.audioDuration) <= 0.35);
  assert.ok(validation.outputDuration > sourceAsset.duration * 2, "Output duration proves the shorter animation was looped.");
  assert.deepEqual(await readFile(audioPath), originalAudio);
  assert.deepEqual(await readFile(assetPath), originalAsset);
});
